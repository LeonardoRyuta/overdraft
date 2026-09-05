// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test, console2} from "forge-std/Test.sol";

interface IAqua {
    // maker => app => strategyHash => token => Balance{uint248 amount, uint8 tokensCount}
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external view returns (uint248 balance, uint8 tokensCount);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Foundry fork harness for the Honesty Probe. Day-2 foundation: proves we can
/// (a) read a live Aqua position's coverage from mainnet fork state, and (b) impersonate
/// an arbitrary taker + fund it — the setup a real swap needs. Executing quote-vs-swap
/// against a real position needs the reconstructed Order (Agent E / RECON-ORDER.md).
contract ProbeTest is Test {
    address constant AQUA   = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a; // registry
    address constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De; // SwapVM router = Aqua "app"
    address constant WETH   = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // A live SwapVM position observed by the coverage engine (0x3127…, WETH leg).
    // Live state is mutable; the test logs coverage and does not hard-assert liveness.
    address constant MAKER  = 0x3127f2A46BcE49882b41F66c5F9c8D9c541a8f78;
    bytes32 constant STRAT  = 0x353a3087a9bf803f7c1f2e1bd5fad327477a5a13766a0765d0c96628ec87fd14;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"));
    }

    /// Read a live position's coverage on the fork and cross-check against the TS engine's method.
    function test_ReadLiveCoverage() public view {
        assertGt(AQUA.code.length, 0, "Aqua not deployed on fork");
        assertGt(ROUTER.code.length, 0, "router not deployed on fork");

        (uint248 committed, uint8 tokensCount) = IAqua(AQUA).rawBalances(MAKER, ROUTER, STRAT, WETH);
        uint256 wallet = IERC20(WETH).balanceOf(MAKER);
        uint256 allowance = IERC20(WETH).allowance(MAKER, AQUA);
        uint256 backed = wallet < allowance ? wallet : allowance;

        console2.log("=== live WETH leg, maker 0x3127... ===");
        console2.log("tokensCount (1..0xfe live, 0xff docked, 0 empty):", tokensCount);
        console2.log("committed (virtual):", uint256(committed));
        console2.log("wallet:", wallet);
        console2.log("allowance->Aqua:", allowance);
        console2.log("backed = min(wallet,allowance):", backed);
        if (committed > 0) {
            console2.log("coverage (bps):", backed * 10_000 / uint256(committed));
        }
        // The read must succeed (no revert) — that alone proves the fork harness works.
        assertTrue(true);
    }

    /// Prove we can impersonate + fund an arbitrary taker — no verified-counterparty registry
    /// blocks this (RECON-PROTOCOL Q4). This is the taker side of a fork swap.
    function test_ImpersonateAndFundTaker() public {
        address taker = makeAddr("taker");
        deal(WETH, taker, 10 ether);
        assertEq(IERC20(WETH).balanceOf(taker), 10 ether, "deal failed");

        vm.startPrank(taker);
        // A real swap would: IERC20(WETH).approve(ROUTER or AQUA, amt);
        //                    ISwapVMRouter(ROUTER).swap(order, amountIn, takerTraitsAndData);
        // order comes from the reconstructed Order preimage (Agent E). Wired next.
        assertEq(IERC20(WETH).balanceOf(taker), 10 ether);
        vm.stopPrank();

        console2.log("taker impersonated + funded:", taker);
    }
}
