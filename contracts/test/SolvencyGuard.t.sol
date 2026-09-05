// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Context } from "swap-vm/libs/VM.sol";
import { SolvencyGuard } from "../src/SolvencyGuard.sol";

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Exposes the internal guard instruction with a hand-built Context so we can unit-test
///      the coverage logic in isolation (no full swap machinery needed).
contract SolvencyGuardHarness is SolvencyGuard {
    constructor(address aqua) SolvencyGuard(aqua) {}

    function check(address maker, address tokenOut, uint256 amountOut, bytes calldata args) external view {
        Context memory ctx;
        ctx.query.maker = maker;
        ctx.query.tokenOut = tokenOut;
        ctx.swap.amountOut = amountOut;
        _solvencyGuard(ctx, args);
    }
}

/// @notice Proves SolvencyGuard reverts iff the requested output exceeds the maker's REAL backing
/// = min(wallet balance, allowance→Aqua). The allowance-bound case is Overdraft's core
/// differentiation from wallet-only tools.
contract SolvencyGuardTest is Test {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    SolvencyGuardHarness guard;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"));
        guard = new SolvencyGuardHarness(AQUA);
    }

    function test_PassesWhenFullyBacked() public {
        address maker = makeAddr("maker");
        deal(WETH, maker, 10 ether);
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, 10 ether);
        guard.check(maker, WETH, 5 ether, hex""); // 5 <= min(10,10) -> no revert
    }

    function test_RevertsWhenWalletBound() public {
        address maker = makeAddr("maker");
        deal(WETH, maker, 1 ether); // thin wallet
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, 100 ether); // generous allowance
        vm.expectRevert(
            abi.encodeWithSelector(SolvencyGuard.InsufficientCoverage.selector, maker, WETH, 5 ether, 1 ether)
        );
        guard.check(maker, WETH, 5 ether, hex""); // 5 > min(1,100)=1 -> wallet-bound revert
    }

    function test_RevertsWhenAllowanceBound() public {
        address maker = makeAddr("maker");
        deal(WETH, maker, 100 ether); // plenty in wallet
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, 1 ether); // but only 1 approved to Aqua
        vm.expectRevert(
            abi.encodeWithSelector(SolvencyGuard.InsufficientCoverage.selector, maker, WETH, 5 ether, 1 ether)
        );
        guard.check(maker, WETH, 5 ether, hex""); // 5 > min(100,1)=1 -> allowance-bound revert (wallet-only tools miss this)
    }

    function test_PassesExactlyAtBacking() public {
        address maker = makeAddr("maker");
        deal(WETH, maker, 3 ether);
        vm.prank(maker);
        IERC20(WETH).approve(AQUA, 3 ether);
        guard.check(maker, WETH, 3 ether, hex""); // requested == backed -> allowed
    }
}
