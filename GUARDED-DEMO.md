# GUARDED-DEMO — SolvencyGuard, before/after, on a mainnet fork

**Author:** Agent J (payoff demo) · **Date:** 2026-09-05 · **For:** Overdraft (ETHOnline 2026)

**Bottom line:** The same overcommit that lets an **UNGUARDED** SwapVM/Aqua position quote depth
its maker cannot fill is refused **CLEANLY, at quote time**, by a position whose program ends
with the **SolvencyGuard** instruction. Both sides run through the **real `quote` entrypoint** of
our `OverdraftAquaSwapVMRouter`, deployed on a mainnet fork against the **real Aqua registry**,
with **real Aqua virtual balances** shipped via `Aqua.ship`. The only difference between control
and fix is **one opcode byte** appended to the program.

Deliverable test: **`contracts/test/GuardedDemo.t.sol`** — 4 tests, all PASS under
`forge test --match-contract GuardedDemo`.

---

## The numbers (from real forked runs, fork block **25911229–25911238**)

Fork: `vm.createSelectFork(vm.rpcUrl("mainnet"))` → publicnode (`ethereum-rpc.publicnode.com`),
latest block at run time (observed **25911224, 25911229, 25911238** across runs). The fork block
drifts run-to-run because it tracks mainnet head; **the quoted numbers are byte-identical at every
block** because the demo ships its own position and does not depend on live third-party state.
(To pin a block exactly, use `vm.createSelectFork(vm.rpcUrl("mainnet"), 25911238)`.)

Scenario (our own maker, `makeAddr("overdraftMaker")` = `0x4482…a893`):

| quantity | value |
|---|---|
| tokenIn / tokenOut | 1INCH `0x1111…C302` / WETH `0xC02a…56Cc2` |
| virtual `balanceIn` (1INCH) shipped to Aqua | 1,000,000 · 1e18 |
| virtual `balanceOut` (WETH) shipped to Aqua | 1,000,000 · 1e18 |
| taker amountIn (exact-in) | 100,000 · 1e18 1INCH |
| **maker's REAL WETH backing** = min(wallet, allowance→Aqua) | **5 · 1e18 (5 WETH)** |

**Curve:** `XYCSwap` constant-product → `amountOut = amountIn·balanceOut / (balanceIn+amountIn)`
= `100000·1e18 · 1e6·1e18 / (1e6·1e18 + 100000·1e18)` = **90,909.090909… WETH**.

| case | via | result |
|---|---|---|
| **BEFORE — unguarded** | `router.quote(unguardedOrder, 1INCH, WETH, 100000e18, exactIn)` | returns **`amountOut = 90909090909090909090909`** (≈ **90,909.09 WETH**) |
| overcommit vs real backing | `amountOut / backing` | **18,181×** (quotes 90,909 WETH backed by 5 WETH) |
| **AFTER — guarded** | `router.quote(guardedOrder, …)` (same inputs, same 5 WETH backing) | **REVERTS `SolvencyGuard.InsufficientCoverage(0x4482…a893, WETH, 90909090909090909090909, 5000000000000000000)`** |
| **AFTER — but fully backed** | guarded order, maker backed with 90,910 WETH | quote **succeeds**, returns the same `90909…909` — the guard blocks only the overcommit, not the trade |

So the identical program, identical maker, identical 5 WETH backing: the unguarded position
advertises **90,909 WETH** of phantom depth; the guarded position **refuses to quote it** and
names exactly what's missing (`requested = 90909e18`, `backed = 5e18`).

---

## What's REAL vs SIMPLIFIED (honesty)

**Real:**
- **Real Aqua registry** (`0x1111113CCf…6a90a`) on a **real mainnet fork** — `Aqua.ship`,
  `Aqua.safeBalances`, and the maker's real ERC20 `balanceOf`/`allowance` are all the genuine
  on-chain code paths.
- **Real router** — our `OverdraftAquaSwapVMRouter` (compiles + fork-tested elsewhere), the exact
  contract Overdraft proposes. The quote runs the real `SwapVM.quote` → `runLoop` → VM dispatch →
  `XYCSwap` curve → (guarded) `SolvencyGuard`.
- **Real quote path.** The phantom `amountOut` is what `SwapVM.quote` actually returns; the guard
  revert is what `SwapVM.quote` actually throws. Not a unit stub — the full router entrypoint.
- **Real ship recipe.** We ship `strategy = abi.encode(order)` so `keccak256(strategy)` equals the
  `orderHash = keccak256(abi.encode(order))` that `SwapVM.quote` keys Aqua on — Agent E's verified
  recovery recipe (RECON-ORDER.md), run forward. The test asserts `shippedHash == orderHash`.
- **Same phantom mechanism as the live position.** Agent H's probe (PROBE-RESULTS.md) showed the
  live wstETH/1INCH maker quoting 15,818 1INCH against ~11,298 real → the oversized swap reverts
  `SafeTransferFromFailed` at `Aqua.pull`. This demo reproduces that structure (virtual
  `balanceOut` ≫ real backing) on a **position we control**, and shows the guard catching it at
  **quote** time instead of letting it revert at **execution** time.

**Simplified (deliberately, and why it doesn't weaken the claim):**
1. **Our own synthetic position, not a live third-party order.** We ship our own maker + virtual
   balances so we can (a) control the backing to sit below the phantom quote and (b) attach the
   guarded/unguarded programs. Overdraft's guard is a **maker-opt-in instruction**, so the
   honest demonstration is a maker who adds it — exactly this. The *phantom-on-a-live-order* half
   is already proven separately in PROBE-RESULTS.md; this file proves the *fix*.
2. **Simplest curve (`XYCSwap` constant-product), no access-token gate, no fees, no
   concentrated-liquidity band.** The live order used a `0x21` RES-NFT access gate + fees + a
   concentrated curve. None of that is needed to exhibit "virtual depth ≫ real backing"; XYCSwap
   is the minimal curve that quotes, so the demo isolates the guard's behavior. The guard logic is
   curve-agnostic — it reads `ctx.swap.amountOut` after whatever curve ran.
3. **We assert the guarded quote reverts (not the swap).** That is the whole point: the guard
   moves the failure from *execution-time revert* (a wasted, grief-y taker tx) to *quote-time
   refusal*. The unguarded swap's execution-time revert is already demonstrated on a real order
   in PROBE-RESULTS.md (STEP 4), so we do not re-run it here; this test focuses on the quote.

---

## A subtlety worth recording: the opcode BYTE is shifted by −1

`AquaOpcodes._opcodes()` builds a fixed-size `function[35]` array of instruction pointers, then
reinterprets it as a **dynamic** array by `mstore`-ing the length over its first word. That write
**clobbers fixed element[0]** (a `_notInstruction`) and shifts every remaining entry down by one.
So the runtime opcode **byte** for an instruction is its **position in the source literal minus 1**:

- `XYCSwap._xycSwapXD` — literal position 18 → **runtime byte 17 (0x11)**
- `Controls._salt` — literal position 21 → **runtime byte 20 (0x14)**

The **SolvencyGuard** opcode is appended by the router's *own* dynamic-array builder (which does
**not** shift), so it is exactly `router.solvencyGuardOpcode()` = **34 (0x22)**.

The test pins this empirically: `test_Unguarded_QuotesPhantomDepth` asserts the returned
`amountOut` equals the constant-product formula, which only holds if byte 17 really dispatched to
`XYCSwap`. (An earlier wrong guess of byte 18 reverted with `ConcentrateMissingSqrtPriceMin()` —
i.e. byte 18 is the concentrate curve, confirming the −1 shift.)

---

## Programs used

VM program bytes are `[opcode(1) | argLen(1) | args(argLen)]…`.

- **Unguarded (control):** `0x11 00  0x14 00` = `XYCSwap` then `Salt` (a no-op included only to
  make this order's hash distinct from the guarded one, so their immutable Aqua slots don't
  collide).
- **Guarded (fix):** `0x11 00  0x22 00` = the **same** `XYCSwap` curve, then **SolvencyGuard**
  (0 args). Byte `0x22` == `router.solvencyGuardOpcode()` == 34.

Order framing (both): `Order{ maker, traits = 1<<254 (useAquaInsteadOfSignature), data = program }`.
No hooks, no receiver, so `data == program` and all order-data-slice offsets are 0.

---

## How to run

```bash
cd contracts
export PATH="$HOME/.foundry/bin:$PATH"     # Foundry
forge test --match-contract GuardedDemo -vv
```

No separate `anvil` is needed — the test forks in-process via the `mainnet` RPC endpoint pinned in
`contracts/foundry.toml` (`ethereum-rpc.publicnode.com`). First compile is slow (solc 0.8.30 +
via_ir); incremental after.

Expected: **4 passed** —
`test_Unguarded_QuotesPhantomDepth`, `test_Guarded_RefusesToQuote`,
`test_Guarded_AllowsWhenFullyBacked`, `test_BeforeAfter_SameBacking`.

---

## Confidence

| claim | confidence |
|---|---|
| Unguarded quote returns phantom depth (90,909 WETH vs 5 WETH backing) via real `router.quote` | **High** — real forked run, exact constant-product value asserted |
| Guarded quote reverts `InsufficientCoverage(maker, WETH, 90909e18, 5e18)` for the same backing | **High** — `vm.expectRevert` on the precise selector + args |
| Guard blocks only the overcommit (fully-backed guarded quote succeeds) | **High** — asserted |
| Ship recipe (`strategy = abi.encode(order)`, `keccak256(strategy) == orderHash`) | **High** — asserted in-test; matches RECON-ORDER |
| SolvencyGuard opcode byte == 34; XYCSwap byte == 17 (the −1 shift) | **High** — empirically pinned by curve-output assertion |
