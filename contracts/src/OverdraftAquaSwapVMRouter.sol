// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "swap-vm/libs/VM.sol";
import { SwapVM } from "swap-vm/SwapVM.sol";
import { AquaOpcodes } from "swap-vm/opcodes/AquaOpcodes.sol";
import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { SolvencyGuard } from "./SolvencyGuard.sol";

/// @title OverdraftAquaOpcodes
/// @notice The stock AquaOpcodes instruction set with SolvencyGuard appended at the next opcode
///         slot, preserving backward compatibility (existing opcode numbers are unchanged).
abstract contract OverdraftAquaOpcodes is AquaOpcodes, SolvencyGuard {
    constructor(address aqua) AquaOpcodes(aqua) SolvencyGuard(aqua) {}

    /// @notice Opcode index assigned to SolvencyGuard (== the stock instruction count).
    function solvencyGuardOpcode() public pure returns (uint256) {
        return AquaOpcodes._opcodes().length;
    }

    /// @dev Append `_solvencyGuard` after the stock instruction set.
    function _opcodes()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        function(Context memory, bytes calldata) internal[] memory base = AquaOpcodes._opcodes();
        result = new function(Context memory, bytes calldata) internal[](base.length + 1);
        for (uint256 i = 0; i < base.length; ++i) {
            result[i] = base[i];
        }
        result[base.length] = _solvencyGuard;
    }
}

/// @title OverdraftAquaSwapVMRouter
/// @notice A modified SwapVM router (redeployment of a modified SwapVM is permitted by 1inch)
///         that adds the SolvencyGuard instruction. A maker ships a strategy whose program ends
///         with the SolvencyGuard opcode; the position then physically cannot fill beyond the
///         maker's real backing.
contract OverdraftAquaSwapVMRouter is Simulator, SwapVM, OverdraftAquaOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        OverdraftAquaOpcodes(aqua)
    {}

    function _instructions()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory)
    {
        return _opcodes();
    }
}
