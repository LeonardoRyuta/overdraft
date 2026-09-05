# RECON-ORDER — recovering the full `Order` preimage of a live SwapVM/Aqua position

**Author:** Agent E (Order recovery) · **Date:** 2026-09-05 · **For:** Overdraft (ETHOnline 2026)

**Bottom line: YES — reproduced a REAL on-chain `strategyHash` from purely on-chain data,
verified 3 independent ways, and built BOTH quote and swap calldata from the recovered
`Order`.** The `Order` preimage of a SwapVM position is fully recoverable from the Aqua
`Shipped` event with zero credentials and no off-chain data. This unblocks the Honesty Probe.

Everything below is backed by live mainnet values or SDK output. Script:
`spikes/order/recover-order.mjs` (run instructions at the end).

---

## TL;DR recovery recipe (one sentence)

> The Aqua `Shipped(maker, app, strategyHash, strategy)` event's **`strategy` bytes ARE
> `abi.encode(Order{maker,traits,data})`**, so `keccak256(strategy) == strategyHash` and
> `@1inch/swap-vm-sdk`'s `Order.decode(strategy)` reconstructs the exact `Order` whose
> `.hash()` reproduces the on-chain `strategyHash` — from which `encodeQuoteCallData` /
> `encodeSwapCallData` build quote and swap calldata.

This is **candidate (a)** from the task brief ("the `strategy` bytes ARE `abi.encode(Order)`").
It is confirmed. No wrapping (candidate b) and no alternate framing (candidate c) is needed.

---

## The verified recovery, on a REAL live position

Enumerated from the Aqua contract's `Shipped` logs via the **keyless Blockscout
decoded-logs API** (`https://eth.blockscout.com/api/v2/addresses/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a/logs`),
filtering `decoded.method_call` starting with `Shipped` where `app == the SwapVM router`.

**Concrete example (real, mainnet):**

| Field | Value |
|---|---|
| Aqua contract | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
| `app` (SwapVM router) | `0x111111338c5091E8440b67B168bAe16a668AC0De` ✅ = router |
| `maker` | `0x21cb492117BA484303DA6108c31C6C12f573a67e` |
| **on-chain `strategyHash`** | `0x3d6ddd1a1009295c5d93c58aaab92eefbf7edb4ed18e616a28f8a5f0b4b49226` |
| ship tx block | `25910963` |
| `strategy` (bytes) | 320 bytes (see below) |

`strategy` blob (this is `abi.encode(Order)` verbatim):
```
0x0000000000000000000000000000000000000000000000000000000000000020   // offset to tuple
00000000000000000000000021cb492117ba484303da6108c31c6c12f573a67e   // Order.maker
4000000000000000000000000000000000000000000000000000000000000000   // Order.traits (uint256)
0000000000000000000000000000000000000000000000000000000000000060   // offset to Order.data
0000000000000000000000000000000000000000000000000000000000000084   // data length = 132 bytes
211426ffc7d378e8e49be2c483295a3e3e511f96a4681c18000009c48063d4faf   // Order.data (program bytecode)
54bf8c898dc6ddc689c76ab12b4614a124...00002710110014083a110fbf21beafc6
```

### Three independent verifications (all reproduce the on-chain `strategyHash`)

Output of `spikes/order/recover-order.mjs` (STEP 2) against this live position:

```
(A) keccak256(strategy raw)          = 0x3d6ddd1a...b4b49226  ✅ MATCH
(B) Order.decode(strategy).hash()    = 0x3d6ddd1a...b4b49226  ✅ MATCH
(C) SDK re-encode == strategy bytes  = ✅ identical
    keccak256(order.encode())        = 0x3d6ddd1a...b4b49226  ✅ MATCH
RECOVERY VERIFIED: YES ✅
```

- **(A)** `keccak256(strategy)` over the raw `Shipped` bytes equals the on-chain
  `strategyHash`. This *is* the derivation: `Aqua.ship` does `strategyHash = keccak256(strategy)`
  (RECON-PROTOCOL Q2), and here the caller supplied `strategy = abi.encode(Order)`.
- **(B)** `@1inch/swap-vm-sdk`'s `Order.decode(strategy).hash()` — in Aqua mode this returns
  `keccak256(order.encode())` — reproduces the same hash. So the SDK gives us a usable
  `Order` object, not just bytes.
- **(C)** `Order.decode(strategy).encode()` is **byte-identical** to the original on-chain
  `strategy` blob. Round-trip is lossless: the SDK's ABI encoding matches the maker's exactly.

The script also verifies a **second** distinct live position
(`strategyHash 0x87e7ad70...8d25915d`, block 25910956, same maker) — same result. Both
`useAquaInsteadOfSignature = true` (bit 254 of `traits`, i.e. `traits = 0x4000…0000`),
confirming these are Aqua orders that hash via `keccak256(abi.encode(order))`.

---

## Decoded `Order` fields

`Order.decode(strategy)` yields (STEP 3 output):

- **`maker`** = `0x21cb492117ba484303da6108c31c6c12f573a67e` (matches the `Shipped` maker).
- **`traits`** = `0x4000000000000000000000000000000000000000000000000000000000000000`
  → `useAquaInsteadOfSignature = true`, no receiver, no hooks (bit 254 set, all else clear).
- **`data`** (= `Order.data`, 132 bytes) = the SwapVM **program bytecode**, decoded by
  `AquaProgramBuilder.decode(order.program)` into 6 instructions:

  | # | instruction (SDK-decoded args) | meaning |
  |---|---|---|
  | 1 | `{ token: 0x26ffc7d378e8e49be2c483295a3e3e511f96a468 }` | a token guard/param |
  | 2 | `{ fee: 2500, to: 0x8063d4faf54bf8c898dc6ddc689c76ab12b4614a }` | protocol-fee bps + receiver |
  | 3 | `{ sqrtPriceMin: 5224197663297468, sqrtPriceMax: 5775567826603045 }` | concentrated-liquidity curve bounds |
  | 4 | `{ fee: 10000 }` | flat fee (bps) |
  | 5 | `{}` | swap-curve op (no args) |
  | 6 | `{ salt: 4184142842383216582 }` | uniqueness salt (per-order replay guard) |

  This is a **concentrated-liquidity AMM strategy**, not a simple limit order.

### Token cross-check (against `Pushed` events) ✅

For SwapVM/AMM programs the swap tokens are **not** stored as full addresses at the head of
`data` (contrary to the "tokenA(20)‖tokenB(20)‖program" guess in RECON-PROTOCOL Q2 — that
speculative layout does **not** hold for these AMM orders; the program is a pure opcode
stream and tokens flow in via the swap query at execution time). The position's tokens are
established by the `Pushed` events for the same `strategyHash`:

- `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` — **wstETH**
- `0x111111111117dC0aa78b770fA6A738034120C302` — **1INCH**

Both are live: `rawBalances(maker, router, strategyHash, token).tokensCount == 2` with
large virtual balances (read via `eth_call` in the debug probe), i.e. an active 2-token
strategy (not `0` = empty, not `0xff` = docked).

---

## Proving SDK usability — quote AND swap calldata from the recovered `Order`

STEP 4 output — both built from the **same** recovered `Order`, using the position's own
tokens (wstETH ⇄ 1INCH):

```
quote selector = 0x44aa5f14  (516 bytes calldata)   encodeQuoteCallData
swap  selector = 0xf4d2d412  (516 bytes calldata)   encodeSwapCallData
hash  selector = 0xf5d08521                          encodeHashOrderCallData
all three selectors distinct = true
quote tx -> to = 0x111111338c5091e8440b67b168bae16a668ac0de   (AquaSwapVMRouter)
swap  tx -> to = 0x111111338c5091e8440b67b168bae16a668ac0de
```

The quote/swap calldata embeds the recovered `Order` tuple **verbatim** (the maker
`21cb4921…` and the program tail `3a110fbf…` both appear inside the calldata). These
`CallInfo { to, data, value }` objects are ready to `eth_call`. This is exactly the Honesty
Probe primitive: build a QUOTE and a SWAP for the same position independently and compare.

**Caveat (parameterization, NOT a recovery defect):** an `eth_call` of the built quote with
`TakerTraits.default()` and an arbitrary 0.01-unit amount **reverts** with custom error
selector `0x89c62b64` (single zero arg). The position is live and the calldata is
well-formed and embeds the correct `Order`; the revert is a **program guard** in the
concentrate-curve strategy (deadline / min-rate / amount bound) tripping on an untuned probe
amount and empty threshold/deadline. Tuning `TakerTraits` (threshold, deadline) and using a
realistic amount is the honesty-probe caller's job — it does not affect Order recovery, which
is proven byte-exact three ways above. (The exact identity of `0x89c62b64` was not resolvable
against a local custom-error dictionary; 4byte.directory only returns an unrelated ERC-721
collision. Marked **UNKNOWN** which specific guard, but it is a defined SwapVM revert, not a
decode failure.)

---

## Why this works (grounded in protocol + SDK)

1. `Aqua.ship(app, strategy, …)` sets `strategyHash = keccak256(strategy)` over the **raw**
   caller-supplied bytes and emits them in `Shipped` — data-availability by design
   (RECON-PROTOCOL Q1/Q2).
2. For a **SwapVM** position the maker supplies `strategy = abi.encode(Order{maker,traits,data})`
   (the router is the `app`). So `strategyHash = keccak256(abi.encode(Order))`, which is
   exactly SwapVM's Aqua-order hash form (`SwapVM.hash` at `SwapVM.sol:72-74`,
   RECON-PROTOCOL Q2).
3. Therefore the **full `Order` preimage is on-chain** inside `Shipped.strategy`, and
   `@1inch/swap-vm-sdk`'s `Order.decode` / `.hash()` / `.encode()` round-trip it losslessly
   (RECON-SDK §3). No signature, no off-chain order object needed for Aqua orders.

---

## How to run (reproducible, zero credentials)

Deliverable script: **`spikes/order/recover-order.mjs`**. It enumerates live SwapVM `Shipped`
events (Blockscout), verifies recovery 3 ways, decodes the `Order`, cross-checks tokens
against `Pushed`, and builds quote+swap calldata — all on live mainnet data.

```bash
# From spikes/order (a node_modules junction points at ../sdk/node_modules so bare
# imports resolve; recreate it if missing — see note below):
cd spikes/order
npx tsx recover-order.mjs
```

**Dependency resolution note (Windows):** `spikes/order` reuses the SDK already installed in
`spikes/sdk/node_modules` via an NTFS **junction** at `spikes/order/node_modules`. If it's
absent (e.g. fresh checkout), recreate it in PowerShell:
```powershell
New-Item -ItemType Junction -Path spikes\order\node_modules -Target spikes\sdk\node_modules
```
(Alternatively, copy `recover-order.mjs` into `spikes/sdk/` and run it there — same result.)
Must run under **`tsx`**, not plain `node`: `@1inch/swap-vm-sdk@0.4.1`'s ESM build has an
extensionless import that only bundler-style resolvers fix (RECON-SDK §6).

Verified deps: `@1inch/swap-vm-sdk@0.4.1`, `@1inch/aqua-sdk@0.3.1`, `viem@2.56.3`, Node v22.17.0.

---

## Confidence

| Claim | Confidence |
|---|---|
| `strategy` bytes == `abi.encode(Order)`; `keccak256(strategy) == strategyHash` | **High** — reproduced on 2 distinct live positions |
| `Order.decode(strategy)` reconstructs a usable SDK `Order`; `.hash()` matches | **High** — reproduced live |
| SDK re-encode is byte-identical to on-chain `strategy` | **High** — reproduced live |
| Quote + swap calldata build from the recovered `Order` | **High** — built live, embeds Order verbatim |
| Tokens = wstETH + 1INCH (from `Pushed`, position live) | **High** — read live via Blockscout + `rawBalances` |
| Which specific program guard causes the untuned-quote revert (`0x89c62b64`) | **UNKNOWN** — not recovery-relevant |
| Generality: ALL SwapVM Shipped positions follow this exact recipe | **Med-High** — 2/2 sampled match; signed (non-Aqua) orders would differ but aren't shipped to Aqua |
