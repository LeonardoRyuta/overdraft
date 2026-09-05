# @overdraft/probe — the Honesty Probe

A runnable harness that, for a **REAL live 1inch Aqua/SwapVM position**, builds a `quote` and
a `swap` and compares them — proving Overdraft's thesis on-chain: **quoted (virtual) depth can
vastly exceed the depth the maker can actually back**, so oversized fills are *phantom* and
revert when executed.

See **`../../PROBE-RESULTS.md`** for the captured numbers, block heights, and the identity of
the `0x89c62b64` blocker.

## Scripts

| script | what it does | network |
|---|---|---|
| `src/quote.ts` | Recovers a real `Order` from its on-chain `Shipped` event, builds quote calldata, `eth_call`s the router, and identifies the `0x89c62b64` access-gate revert. Iterates to a **successful quote**. | live mainnet |
| `src/swap.ts` | Picks an **ACTIVE** position, quotes it on a fork, then executes the real `swap` and diffs `amountOut_quoted` vs `amountOut_executed` (Quote/Swap Consistency). | anvil fork |
| `src/phantom.ts` | **The money shot.** On the same real position, executes a BACKED swap (succeeds) and a PHANTOM swap sized within the quoted-but-unbacked depth (reverts on `Aqua.pull`). | anvil fork |
| `src/lib.ts` | Shared: order recovery, quote/swap calldata, `rawBalances`, RES-holder lookup, full SwapVM/Aqua custom-error dictionary. | — |

## Run

```bash
# Step 1 — live quote (no fork)
npx tsx src/quote.ts

# Steps 2–4 — start a mainnet fork first, in a separate shell:
anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
# then:
npx tsx src/swap.ts
npx tsx src/phantom.ts
```

## Notes

- **Run under `tsx`**, not plain `node`: `@1inch/swap-vm-sdk@0.4.1`'s ESM build has an
  extensionless import that only bundler-style resolution fixes.
- Dependencies resolve via an NTFS **junction** `node_modules → ../../spikes/sdk/node_modules`.
  Recreate if missing (PowerShell):
  `New-Item -ItemType Junction -Path node_modules -Target ..\..\spikes\sdk\node_modules`
- The demo taker impersonates a holder of the SwapVM **RES access token** (`0x26FFc7D3…`) so the
  order's `OnlyTxOriginTokenBalanceNonZero` (opcode `0x21`) gate passes on the fork.
- Under `TakerTraits.useTransferFromAndAquaPush` (default) the taker approves the **SwapVM
  router** (not Aqua) for tokenIn.
- Zero credentials: positions are discovered via keyless Blockscout decoded-logs; all quotes and
  swaps run against the public RPC / your local fork.
