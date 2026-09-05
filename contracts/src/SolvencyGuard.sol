// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "swap-vm/libs/VM.sol";

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title SolvencyGuard
/// @notice A SwapVM instruction that refuses to fill more than the maker's REAL backing.
///
/// Aqua stores *virtual* balances, so a position can quote depth its maker cannot actually
/// honour (see Overdraft's coverage measurement). Placed after the swap-curve instruction in
/// a program, SolvencyGuard reverts whenever the computed output (`ctx.swap.amountOut`) exceeds
/// the maker's real backing of the output token:
///
///     backed = min(ERC20(tokenOut).balanceOf(maker), ERC20(tokenOut).allowance(maker, Aqua))
///
/// (Aqua does the `transferFrom` on pull, so the maker's allowance is granted to the Aqua
/// contract.) A position built with this instruction can never advertise depth it cannot fill —
/// it self-limits to whatever the wallet holds at execution time. This is the on-chain "fix"
/// that turns Overdraft's diagnosis into a guarantee.
abstract contract SolvencyGuard {
    /// @dev The Aqua registry: the spender the maker approves and that performs the pull.
    address private immutable _solvencyAqua;

    /// @notice Reverts when a quote/swap would pull more tokenOut than the maker has backed.
    error InsufficientCoverage(address maker, address token, uint256 requested, uint256 backed);

    constructor(address aqua) {
        _solvencyAqua = aqua;
    }

    /// @notice SwapVM instruction entrypoint. Signature matches the opcode ABI `(Context, bytes)`.
    /// @dev `args` is reserved for a future basis-point safety haircut; unused today. `view`
    ///      is compatible with the VM's default-mutability opcode slot (same as Controls guards).
    function _solvencyGuard(Context memory ctx, bytes calldata /* args */) internal view {
        address maker = ctx.query.maker;
        address tokenOut = ctx.query.tokenOut;
        uint256 requested = ctx.swap.amountOut;

        uint256 bal = IERC20Min(tokenOut).balanceOf(maker);
        uint256 allowed = IERC20Min(tokenOut).allowance(maker, _solvencyAqua);
        uint256 backed = bal < allowed ? bal : allowed;

        require(requested <= backed, InsufficientCoverage(maker, tokenOut, requested, backed));
    }
}
