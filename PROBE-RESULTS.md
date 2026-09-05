# PROBE-RESULTS — the Honesty Probe, run against a REAL live 1inch Aqua/SwapVM position

**Author:** Agent H (Honesty Probe) · **Date:** 2026-09-05 · **For:** Overdraft (ETHOnline 2026)

**Bottom line:** For a REAL, live SwapVM concentrated-liquidity position we (1) got a
successful **quote** on live mainnet, (2) executed the matching **swap** on a mainnet fork
and showed `amountOut_quoted == amountOut_executed` **to the wei**, and (3) demonstrated the
**phantom fill** on-chain: the quote engine quotes ~14× the depth the maker can actually
deliver, and the oversized swap **reverts** because `Aqua.pull`'s `transferFrom` exceeds the
maker's real balance. Every number below comes from a real `eth_call` or a real fork
execution, with the block recorded. Nothing is fabricated.

Harness: **`packages/probe/`** — `src/quote.ts` (step 1, live), `src/swap.ts` (steps 2–3,
fork), `src/phantom.ts` (step 4, fork), `src/lib.ts` (order recovery + calldata + error
dictionary). Run instructions at the end.

---

## The blocker `0x89c62b64` — SOLVED (it is an access-gate, not a swap-math guard)

Agent E flagged that an untuned quote `eth_call` reverts with custom-error selector
`0x89c62b64` and left its identity UNKNOWN. **We identified it empirically and by source.**

The recovered `Order`'s program (decoded live) begins with opcode **`0x21`** =
`OnlyTxOriginTokenBalanceNonZero`, gating on an **access token** address `0x26FFc7D3…`:

```
program instructions (decoded from the on-chain Shipped strategy):
  - {"token":"0x26ffc7d378e8e49be2c483295a3e3e511f96a468"}   # opcode 0x21 tx.origin access gate
  - {"fee":"2500","to":"0x8063d4faf54bf8c898dc6ddc689c76ab12b4614a"}  # protocol fee
  - {"sqrtPriceMin":"5224…","sqrtPriceMax":"5775…"}           # concentrated-liquidity bounds
  - {"fee":"10000"}                                            # flat fee
  - {}                                                         # swap curve
  - {"salt":"…"}                                               # per-order salt
```

`0x26FFc7D378E8e49Be2c483295A3e3E511F96a468` is an **OpenZeppelin ERC-721** named
**"Access Token for SwapVM v3.1.2"**, symbol **`RES`** (verified on-chain via `name()`/`symbol()`;
8303 bytes of code; Blockscout confirms `type: ERC-721`). The `0x21` instruction runs
`IERC20(RES).balanceOf(tx.origin) > 0`.

The three observed behaviours (all live `eth_call`, same order, at block 25911095) nail it:

| `from` (tx.origin) | revert selector | decoded |
|---|---|---|
| _none_ → tx.origin = `0x0` | **`0x89c62b64`** | `ERC721InvalidOwner(0x0)` — OZ ERC-721's own `balanceOf(address(0))` revert |
| Binance hot wallet (no RES) | `0x39c4052c` | `TxOriginTokenBalanceIsZero(0x28C6…, 0x26FF…)` — the SwapVM guard itself |
| a **RES holder** | _no revert_ | quote returns `(amountIn, amountOut)` ✅ |

So **`0x89c62b64` == `ERC721InvalidOwner(address)`** (selector confirmed:
`keccak256("ERC721InvalidOwner(address)")[:4] = 0x89c62b64`). It is **not** a min-rate /
deadline / amount / direction guard — it is the OZ ERC-721 access token reverting on a
zero-address balance query, tripped because a plain `eth_call` has `tx.origin = address(0)`.
The 4byte directory's "ERC721InvalidOwner" hit was therefore correct, not a red herring — the
gate literally calls an ERC-721's `balanceOf`. Fix: **set `from`/`tx.origin` to an address that
holds the RES access token.** (On the fork we do that by impersonating a real RES holder.)

We enumerated the full SwapVM custom-error dictionary from source
(github.com/1inch/swap-vm and .../aqua) and encoded it in `src/lib.ts` (`ERROR_SIGS`) so every
revert in the harness is decoded by selector.

---

## STEP 1 — Successful QUOTE on LIVE mainnet

- RPC: `https://ethereum-rpc.publicnode.com` · **block 25911165**
- Router: `0x111111338c5091E8440b67B168bAe16a668AC0De` (AquaSwapVMRouter)
- Position (real, live): maker `0x21cb492117BA484303DA6108c31C6C12f573a67e`,
  strategyHash `0xf2c04aad…3e7d6809`, tokens **wstETH ⇄ 1INCH**.
- Recovery: `keccak256(strategy) == strategyHash` verified 3 ways (Agent E's recipe).

**Tuned quote params that worked:**

| param | value |
|---|---|
| `from` (tx.origin) | `0x26A31136e52D3d89B29901e3c4D94594CFc29C85` (holds the RES access token) |
| tokenIn / tokenOut | wstETH `0x7f39…2Ca0` / 1INCH `0x1111…C302` |
| `TakerTraits` | `default()` — exactIn, threshold = 0 (no deadline/threshold tuning needed) |
| amount | e.g. `1000000000000000` (0.001 wstETH) |

**Quoted results (live `eth_call`, block 25911165):**

| direction | amountIn | amountOut_quoted |
|---|---|---|
| wstETH→1INCH | 0.001 wstETH (`1e15`) | `33303583700832800367` (33.30 1INCH) |
| wstETH→1INCH | 0.01 wstETH (`1e16`) | `333035837008327434966` (333.0 1INCH) |
| wstETH→1INCH | 0.1 wstETH (`1e17`) | `3330358370083217478326` (3330 1INCH) |
| 1INCH→wstETH | 100 1INCH (`1e20`) | `3002604792292196` (0.003 wstETH) |

Output scales linearly with input (concentrated-liquidity band), and the direction reverses
cleanly. The exact rate drifts block-to-block because the maker continuously re-ships the band.

---

## STEPS 2 + 3 — Successful SWAP on an anvil fork, and Quote/Swap diff

- Fork: `anvil --fork-url https://ethereum-rpc.publicnode.com` · **fork block 25911111**
- ACTIVE position `0x94c02945…85535041` (maker `0x21cb…`), confirmed live in Aqua via
  `rawBalances(maker, router, strategyHash, token).tokensCount == 2`, committed > 0.
- Fork cheats used: `anvil_impersonateAccount` (taker = a RES holder, so the `0x21` gate passes),
  `anvil_setBalance` (1 ETH gas), `anvil_setStorageAt` (fund taker's wstETH via balanceOf slot 0),
  `approve(router, …)` for wstETH.

> **Gotcha found & fixed:** with `useTransferFromAndAquaPush` (the default), the **taker's**
> tokenIn is pulled by the **SwapVM router** (spender), not the Aqua contract. Approving Aqua
> makes the swap revert `ERC20: transfer amount exceeds allowance` inside `wstETH.transferFrom`.
> The taker must approve the **router**. (The **maker** side — `Aqua.pull` of tokenOut — still
> uses the maker→Aqua allowance, and the maker already grants Aqua an unlimited allowance.)

**Quote/Swap Consistency (invariant #3), 0.01 wstETH → 1INCH, fork block 25911111:**

| quantity | value |
|---|---|
| amountOut_quoted (fork `eth_call`) | `333115836007273889601` |
| amountOut_executed (`Swapped` event + taker balance delta) | `333115836007273889601` |
| **abs diff** | **`0` — EXACT MATCH ✅** |
| swap tx status | `success`, gasUsed 161383 |

The `Swapped(bytes32,address,address,address,address,uint256,uint256)` event and the taker's
realized 1INCH balance change agree to the wei with the quote. Quote/Swap consistency holds
on-chain for this real position.

---

## STEP 4 — PHANTOM FILL (the money shot), on the SAME REAL position

- Fork block **25911114**, position `0x94c02945…85535041` (real).
- **Virtual (quoted) committed 1INCH:** `9007199254461948500782055423220099` ≈ **9.007e15 1INCH**
  (read live via Aqua `rawBalances`).
- **Maker's REAL 1INCH wallet balance:** `11298437403319785921365` ≈ **11,298 1INCH**
  (the maker `0x21cb…` drains/refills as it trades live — this figure moves; the harness
  reads it fresh and sizes the demo relative to it).
- **Over-commit factor: ≈ 7.97e11 ×** the maker's real balance. The position quotes ~800
  billion times more 1INCH depth than the maker holds.

The harness binary-searches the wstETH input for two targets: **BACKED** ≈ 40% of the maker's
real balance, **PHANTOM** ≈ 140% of it.

| case | amountIn | amountOut_quoted | vs maker real (11,298) | executed on fork |
|---|---|---|---|---|
| **BACKED** | 0.1357 wstETH | `4519374967543227679384` (4,519 1INCH) | within | **✅ SUCCESS — 4,519 1INCH delivered** |
| **PHANTOM** | 0.4748 wstETH | `15817812347648601299424` (15,818 1INCH) | **exceeds** | **❌ REVERT `0xf4059071` `SafeTransferFromFailed()`** |

The quote **happily returns 15,818 1INCH** — depth that lives only in the position's virtual
balance (9e15), not in the maker's wallet (11,298). When the taker tries to actually take it,
`Aqua.pull` runs `IERC20(1INCH).safeTransferFrom(maker, taker, 15818e18)`, the maker's real
balance can't cover it, and the swap **reverts** (`SafeTransferFromFailed()`, the
solidity-utils wrapper around `ERC20: transfer amount exceeds balance`). **This is Overdraft's
thesis, demonstrated on-chain on a real position:** quoted depth ≫ backed depth, and the
excess is a phantom fill that no one can actually execute.

> This is a **REAL** under-backed position (not synthetic). No self-deployed order was needed:
> the live wstETH/1INCH maker commits 9e15 virtual 1INCH against an ~11k–178k real wallet.

---

## Block heights (for reproducibility)

| step | where | block |
|---|---|---|
| Quote (live) | mainnet `eth_call` | 25911165 |
| Swap + diff | anvil fork | 25911111 |
| Phantom fill | anvil fork | 25911114 |

All positions are `maker = 0x21cb492117BA484303DA6108c31C6C12f573a67e`, tokens wstETH/1INCH.
The maker re-ships a fresh `strategyHash` almost every block and docks old ones, so exact
`strategyHash` and the maker's real balance vary run-to-run; the harness re-discovers a live
ACTIVE position and reads balances fresh each time, so the demonstration is reproducible even
as the underlying state moves.

---

## How to run

```bash
# 1) live quote + identify 0x89c62b64 (no fork needed)
cd packages/probe
npx tsx src/quote.ts

# 2) start a fork (separate shell), then swap + phantom
~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
npx tsx src/swap.ts       # steps 2–3: swap + quote/swap diff
npx tsx src/phantom.ts    # step 4: phantom fill
```

Deps resolve via an NTFS junction `packages/probe/node_modules → spikes/sdk/node_modules`
(same trick Agent E used); recreate with
`New-Item -ItemType Junction -Path packages\probe\node_modules -Target spikes\sdk\node_modules`
if missing. Must run under **`tsx`** (swap-vm-sdk's ESM build has an extensionless import that
only bundler-style resolution fixes). Verified: `@1inch/swap-vm-sdk@0.4.1`, `viem@2.56.3`,
anvil 1.8.1, Node v22.17.0.

---

## Confidence

| claim | confidence |
|---|---|
| `0x89c62b64` == `ERC721InvalidOwner(address)`, thrown by the `0x21` RES access-gate on zero tx.origin | **High** — reproduced live 3 ways + source-confirmed |
| Quote returns a real amountOut once tx.origin holds RES | **High** — live `eth_call` |
| Quote/Swap consistency (quoted == executed to the wei) | **High** — real fork swap, `Swapped` event |
| Phantom fill: quote quotes > backed, swap reverts on `Aqua.pull` | **High** — real fork execution, `SafeTransferFromFailed()` |
| Taker approves the **router** (not Aqua) for tokenIn under `useTransferFromAndAquaPush` | **High** — trace-confirmed |
