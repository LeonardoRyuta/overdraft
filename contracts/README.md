# Overdraft contracts (Foundry)

The **fix** half of Overdraft: a custom SwapVM instruction that makes a position refuse to fill
more than its maker can actually back.

- **`src/SolvencyGuard.sol`** — a SwapVM instruction. Placed after the swap curve, it reverts when
  the computed output exceeds the maker's real backing:
  `min(ERC20(tokenOut).balanceOf(maker), allowance(maker, Aqua))`. A position built with it can
  never advertise depth it cannot fill.
- **`src/OverdraftAquaSwapVMRouter.sol`** — a modified `AquaSwapVMRouter` (redeploying a modified
  SwapVM is explicitly permitted by 1inch) that appends SolvencyGuard at the next opcode slot,
  leaving all stock opcode numbers unchanged.
- **`test/SolvencyGuard.t.sol`** — proves on a mainnet fork that the guard reverts iff
  `requested > min(wallet, allowance)`, including the **allowance-bound** case wallet-only tools miss.
- **`test/Probe.t.sol`** — reads a live position's coverage on a fork; cross-checks the TS engine.

## Dependencies (swap-vm is NOT vendored)

`swap-vm` is license-restricted (`LicenseRef-Degensoft-SwapVM-1.1`), so we don't commit it. Fetch it:

```bash
cd contracts
forge install 1inch/swap-vm@v1.0.2     # -> lib/swap-vm
cd lib/swap-vm && npm install          # its deps are npm-based (@openzeppelin, @1inch/*)
cd ../..
```

`forge-std` is vendored (MIT). Remappings are pinned in `remappings.txt`.

## Build & test

```bash
forge build            # solc 0.8.30 + via_ir (swap-vm requires it) — first build is slow (~minutes)
forge test -vv         # fork tests read the `mainnet` RPC in foundry.toml
```
