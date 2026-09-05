// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { ISwapVM } from "swap-vm/interfaces/ISwapVM.sol";
import { MakerTraits } from "swap-vm/libs/MakerTraits.sol";
import { TakerTraits, TakerTraitsLib } from "swap-vm/libs/TakerTraits.sol";

import { SolvencyGuard } from "../src/SolvencyGuard.sol";
import { OverdraftAquaSwapVMRouter } from "../src/OverdraftAquaSwapVMRouter.sol";

interface IAqua {
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external returns (bytes32 strategyHash);
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external view returns (uint248 balance, uint8 tokensCount);
}

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice THE PAYOFF DEMO — Overdraft's SolvencyGuard, before/after, on a mainnet fork.
///
/// Claim proved end-to-end through the router's real `quote` entrypoint:
///   "The same overcommit scenario that lets an UNGUARDED SwapVM position quote depth it
///    cannot fill (and would revert at execution) is refused CLEANLY — at quote time — by a
///    position built with the SolvencyGuard instruction."
///
/// Both sides use our OWN OverdraftAquaSwapVMRouter deployed against the REAL Aqua registry on
/// the fork, our OWN maker, and REAL Aqua virtual balances shipped via `Aqua.ship`. The only
/// difference between the control and the fix is a single opcode appended to the program.
///
/// Mechanic of the phantom fill (identical structure to the live wstETH/1INCH position that
/// Agent H's probe demonstrated on-chain):
///   - A SwapVM Aqua order's quote reads the maker's *virtual* balances from Aqua
///     (`AQUA.safeBalances`) and runs the constant-product curve `XYCSwap` over them:
///         amountOut = amountIn * balanceOut / (balanceIn + amountIn)
///   - The maker ships a HUGE virtual `balanceOut`, so the quote advertises huge depth.
///   - The maker's REAL wallet backing of tokenOut (balance & allowance to Aqua) is TINY.
///   - UNGUARDED: quote happily returns the phantom amountOut (which the swap could never pull).
///   - GUARDED:   the SolvencyGuard opcode, appended after the curve, reverts the quote with
///                `InsufficientCoverage` because amountOut > min(wallet, allowance→Aqua).
contract GuardedDemoTest is Test {
    // Real mainnet deployments (present on the fork).
    address constant AQUA  = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a; // Aqua registry
    address constant WETH  = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant INCH  = 0x111111111117dC0aa78b770fA6A738034120C302; // 1INCH token

    // Opcode BYTES in the VM's dispatch array (index == byte). NOTE: AquaOpcodes._opcodes()
    // builds a fixed-size `[35]` array then reinterprets it as a dynamic array by overwriting
    // its first word with the length. That overwrite CLOBBERS fixed element[0] (a
    // `_notInstruction`) and shifts every remaining entry down by one, so the runtime opcode
    // BYTE for a given instruction is its position in the source literal MINUS ONE:
    //   XYCSwap._xycSwapXD is literal position 18 -> runtime byte 17 (0x11);
    //   Controls._salt      is literal position 21 -> runtime byte 20 (0x14).
    // (The guarded opcode is appended by the router's own dynamic-array builder, which does NOT
    //  shift, so it is exactly router.solvencyGuardOpcode() == 34.) Verified empirically below.
    uint8 constant OP_XYC_SWAP = 17; // 0x11 constant-product curve (XYCSwap._xycSwapXD)
    uint8 constant OP_SALT     = 20; // 0x14 no-op (Controls._salt; distinguishes the two orders)

    // Maker's tokens: tokenOut = WETH (deliberately under-backed), tokenIn = 1INCH.
    // Virtual balances shipped to Aqua (the "phantom" depth the position advertises).
    uint256 constant VIRTUAL_BALANCE_OUT = 1_000_000 ether; // 1,000,000 WETH virtual (tokenOut)
    uint256 constant VIRTUAL_BALANCE_IN  = 1_000_000 ether; // 1,000,000 1INCH virtual (tokenIn)

    // Taker's exact-in amount for the quote (in tokenIn = 1INCH).
    uint256 constant AMOUNT_IN = 100_000 ether; // 100,000 1INCH

    // Maker's REAL backing of tokenOut (WETH). Deliberately far below the phantom quote.
    uint256 constant REAL_BACKING = 5 ether; // 5 WETH in wallet, 5 WETH approved to Aqua

    OverdraftAquaSwapVMRouter router;
    address maker;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"));
        // Our modified-but-1inch-permitted SwapVM router, bound to the REAL Aqua registry.
        router = new OverdraftAquaSwapVMRouter(AQUA, WETH, address(this), "Overdraft", "1");
        maker = makeAddr("overdraftMaker");

        console2.log("=== Overdraft SolvencyGuard payoff demo ===");
        console2.log("fork block:", block.number);
        console2.log("router (OverdraftAquaSwapVMRouter):", address(router));
        console2.log("solvencyGuardOpcode (byte appended for the fix):", router.solvencyGuardOpcode());
    }

    // ---------------------------------------------------------------------------------------
    // Program builders
    // ---------------------------------------------------------------------------------------

    /// @dev VM program bytes are `[opcode(1) | argLen(1) | args(argLen)]...`.
    ///      Control program: XYCSwap curve, then a Salt no-op (only to make this order's hash
    ///      distinct from the guarded one so their Aqua slots don't collide).
    function _unguardedProgram() internal pure returns (bytes memory) {
        return abi.encodePacked(OP_XYC_SWAP, uint8(0), OP_SALT, uint8(0));
    }

    /// @dev Guarded program: the SAME XYCSwap curve, then the SolvencyGuard opcode (0 args).
    function _guardedProgram() internal view returns (bytes memory) {
        uint8 guardOp = uint8(router.solvencyGuardOpcode());
        return abi.encodePacked(OP_XYC_SWAP, uint8(0), guardOp, uint8(0));
    }

    /// @dev Minimal Aqua order: maker + useAquaInsteadOfSignature (bit 254) + program as data.
    ///      No hooks, no receiver, so `data == program` and all order-data-slice offsets are 0.
    function _buildOrder(bytes memory program) internal view returns (ISwapVM.Order memory) {
        uint256 USE_AQUA = 1 << 254;
        return ISwapVM.Order({ maker: maker, traits: MakerTraits.wrap(USE_AQUA), data: program });
    }

    /// @dev Ship the order's virtual balances to Aqua as the maker. The Aqua key is
    ///      keccak256(strategy); SwapVM keys on keccak256(abi.encode(order)); so the shipped
    ///      `strategy` MUST be abi.encode(order) for the quote to find these balances.
    ///      (This is exactly Agent E's verified recovery recipe, run forward.)
    function _shipOrder(ISwapVM.Order memory order) internal returns (bytes32 orderHash) {
        bytes memory strategy = abi.encode(order);
        orderHash = keccak256(strategy);

        address[] memory tokens = new address[](2);
        tokens[0] = INCH; // tokenIn  -> balanceIn
        tokens[1] = WETH; // tokenOut -> balanceOut
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = VIRTUAL_BALANCE_IN;
        amounts[1] = VIRTUAL_BALANCE_OUT;

        vm.prank(maker);
        bytes32 shippedHash = IAqua(AQUA).ship(address(router), strategy, tokens, amounts);
        assertEq(shippedHash, orderHash, "keccak256(strategy) must equal SwapVM orderHash");
    }

    /// @dev Minimal taker traits: exact-in, no threshold, no deadline. 22-byte header:
    ///      20 bytes slice-index (all zero) + 2 bytes flags (IS_EXACT_IN = 0x0001).
    function _takerTraitsExactIn() internal pure returns (bytes memory) {
        TakerTraitsLib.Args memory a;
        a.isExactIn = true;
        return TakerTraitsLib.build(a);
    }

    // ---------------------------------------------------------------------------------------
    // The demo
    // ---------------------------------------------------------------------------------------

    /// @notice UNGUARDED control: the quote returns phantom depth far beyond the maker's backing.
    function test_Unguarded_QuotesPhantomDepth() public {
        ISwapVM.Order memory order = _buildOrder(_unguardedProgram());
        _shipOrder(order);

        // Give the maker a REAL (but tiny) WETH backing and approve Aqua to pull it.
        deal(WETH, maker, REAL_BACKING);
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, REAL_BACKING);

        (, uint256 amountOut,) =
            router.quote(order, INCH, WETH, AMOUNT_IN, _takerTraitsExactIn());

        uint256 backed = _makerBacking();
        console2.log("--- UNGUARDED (control) ---");
        console2.log("amountIn (1INCH):", AMOUNT_IN);
        console2.log("amountOut_quoted (WETH):", amountOut);
        console2.log("maker REAL backing = min(wallet, allowance->Aqua) (WETH):", backed);
        console2.log("phantom overcommit = amountOut / backing (x):", amountOut / backed);

        // Self-check that opcode byte 17 really dispatched to XYCSwap (constant-product):
        // amountOut must equal in*balOut/(balIn+in). This nails down the opcode-shift math.
        uint256 xycExpected = (AMOUNT_IN * VIRTUAL_BALANCE_OUT) / (VIRTUAL_BALANCE_IN + AMOUNT_IN);
        assertEq(amountOut, xycExpected, "opcode 17 must be the XYCSwap constant-product curve");

        // The money fact of the control: quote advertises WAY more than the maker can deliver.
        assertGt(amountOut, backed, "control must quote phantom depth (amountOut > real backing)");
        assertGt(amountOut, 1000 ether, "sanity: phantom depth is large");
    }

    /// @notice GUARDED fix: the SAME overcommit, quoted through a position whose program ends
    ///         with SolvencyGuard, REVERTS cleanly at quote time with InsufficientCoverage.
    function test_Guarded_RefusesToQuote() public {
        ISwapVM.Order memory order = _buildOrder(_guardedProgram());
        _shipOrder(order);

        deal(WETH, maker, REAL_BACKING);
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, REAL_BACKING);

        // First recover the exact phantom amountOut this program's curve would compute, so we can
        // assert the guard reverts with the precise (requested, backed) pair. The curve is the
        // same XYCSwap; the guard just runs after it. amountOut = in*balOut/(balIn+in).
        uint256 expectedOut = (AMOUNT_IN * VIRTUAL_BALANCE_OUT) / (VIRTUAL_BALANCE_IN + AMOUNT_IN);
        uint256 backed = _makerBacking();

        console2.log("--- GUARDED (fix) ---");
        console2.log("would-be amountOut_quoted (WETH):", expectedOut);
        console2.log("maker REAL backing (WETH):", backed);
        console2.log("expecting revert InsufficientCoverage(maker, WETH, requested, backed)");

        // The money shot: the guarded position REFUSES to quote what it cannot fill.
        vm.expectRevert(
            abi.encodeWithSelector(
                SolvencyGuard.InsufficientCoverage.selector, maker, WETH, expectedOut, backed
            )
        );
        router.quote(order, INCH, WETH, AMOUNT_IN, _takerTraitsExactIn());
    }

    /// @notice Sanity floor: with backing RAISED above the quote, the SAME guarded program
    ///         quotes successfully — proving the guard blocks ONLY the overcommit, not the trade.
    function test_Guarded_AllowsWhenFullyBacked() public {
        ISwapVM.Order memory order = _buildOrder(_guardedProgram());
        _shipOrder(order);

        uint256 expectedOut = (AMOUNT_IN * VIRTUAL_BALANCE_OUT) / (VIRTUAL_BALANCE_IN + AMOUNT_IN);

        // Back the maker ABOVE the phantom quote this time.
        uint256 fullBacking = expectedOut + 1 ether;
        deal(WETH, maker, fullBacking);
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, fullBacking);

        (, uint256 amountOut,) =
            router.quote(order, INCH, WETH, AMOUNT_IN, _takerTraitsExactIn());

        console2.log("--- GUARDED, fully backed (control for the fix) ---");
        console2.log("amountOut_quoted (WETH):", amountOut);
        console2.log("maker REAL backing (WETH):", _makerBacking());
        assertEq(amountOut, expectedOut, "fully-backed guarded quote returns the curve output");
    }

    /// @notice Direct before/after in ONE test, same backing: the identical overcommit is
    ///         quoted phantom by the unguarded program and refused by the guarded one.
    function test_BeforeAfter_SameBacking() public {
        // --- ship BOTH positions with identical virtual depth ---
        ISwapVM.Order memory unguarded = _buildOrder(_unguardedProgram());
        ISwapVM.Order memory guarded   = _buildOrder(_guardedProgram());
        _shipOrder(unguarded);
        _shipOrder(guarded);

        // One shared REAL backing for the maker (both positions read the same wallet).
        deal(WETH, maker, REAL_BACKING);
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, REAL_BACKING);
        uint256 backed = _makerBacking();

        // BEFORE (unguarded): returns phantom depth.
        (, uint256 phantomOut,) =
            router.quote(unguarded, INCH, WETH, AMOUNT_IN, _takerTraitsExactIn());

        console2.log("=== BEFORE vs AFTER (same maker, same backing) ===");
        console2.log("shared maker backing (WETH):", backed);
        console2.log("BEFORE unguarded amountOut_quoted (WETH):", phantomOut);
        console2.log("  -> overcommit factor (x):", phantomOut / backed);

        assertGt(phantomOut, backed, "BEFORE: unguarded quotes phantom depth");

        // AFTER (guarded): same inputs, same backing -> refuses at quote time.
        vm.expectRevert(
            abi.encodeWithSelector(
                SolvencyGuard.InsufficientCoverage.selector, maker, WETH, phantomOut, backed
            )
        );
        router.quote(guarded, INCH, WETH, AMOUNT_IN, _takerTraitsExactIn());

        console2.log("AFTER guarded: quote REVERTED InsufficientCoverage(maker, WETH, %s, %s)", phantomOut, backed);
    }

    // ---------------------------------------------------------------------------------------

    function _makerBacking() internal view returns (uint256) {
        uint256 wallet = IERC20(WETH).balanceOf(maker);
        uint256 allowed = IERC20(WETH).allowance(maker, AQUA);
        return wallet < allowed ? wallet : allowed;
    }
}
