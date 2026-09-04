# RECON-PROTOCOL — 1inch Aqua + SwapVM

**Author:** Agent A (protocol recon) · **Date:** 2026-09-04 · **For:** Overdraft (ETHOnline 2026)

**Sources read (raw source, `main` branch, verbatim):**
- `1inch/aqua`: `src/Aqua.sol`, `src/AquaRouter.sol`, `src/interfaces/IAqua.sol`, `src/libs/Balance.sol`, `README.md`
- `1inch/swap-vm`: `src/SwapVM.sol`, `src/libs/VM.sol`, `src/libs/OpcodeList.sol`, `src/libs/MakerTraits.sol`, `src/opcodes/Opcodes.sol`, `src/opcodes/AquaOpcodes.sol`, `src/instructions/{Controls,Whitelist,TokenValidators,Balances,XYCSwap}.sol`, `src/strategies/Strategies.sol`, `src/routers/AquaSwapVMRouter.sol`, `src/interfaces/ISwapVM.sol`, `test/invariants/CoreInvariants.t.sol`, `README.md`

> **Cross-cutting clarification (read this first — it reframes the whole project).**
> There are **two different "strategy/position" hashes** and they are easy to conflate:
> 1. **Aqua-native strategy** created by `Aqua.ship(app, strategy, tokens, amounts)` → key `strategyHash = keccak256(strategy)` (raw bytes; `strategy` is the app-specific encoded blob).
> 2. **SwapVM order** (the thing that actually swaps) — hashed as `orderHash = keccak256(abi.encode(order))` for Aqua orders. **SwapVM then uses `orderHash` *as the `strategyHash`* when it calls Aqua.** See `SwapVM.sol:168,222` (`AQUA.safeBalances(order.maker, address(this), orderHash, …)`) and `SwapVM.sol:273,279,361` (`AQUA.push/pull(…, orderHash, …)`). Here the Aqua `app` = the **SwapVM router address** (`address(this)`).
>
> So for a live *SwapVM* position, the Aqua mapping key is `(maker = order.maker, app = SwapVMRouter, strategyHash = keccak256(abi.encode(order)), token)`. When Overdraft measures coverage of SwapVM positions, that is the tuple to read. Positions shipped directly to a *different* Aqua app use `keccak256(strategy)` instead. Do not assume `keccak256(abi.encode(strategy))` for either — neither uses that exact form (see Q2).

---

## Q1 — Position creation + events

**Verdict:** Two creation paths. (A) Aqua-native: `Aqua.ship(...)` emits `Shipped` + one `Pushed` per token. (B) SwapVM order: **no creation tx and no creation event** — an order is an off-chain object (signed) or a lazily-materialized Aqua position on first swap. **Index `Shipped`/`Pushed`/`Docked`/`Pulled` from the Aqua contract; there is no "OrderCreated" event.**

**(A) Aqua-native creation — `Aqua.ship`** (`aqua/src/Aqua.sol:40-52`):
```solidity
function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external returns (bytes32 strategyHash) {
    strategyHash = keccak256(strategy);
    ...
    emit Shipped(msg.sender, app, strategyHash, strategy);
    for (...) { ... emit Pushed(msg.sender, app, strategyHash, tokens[i], amounts[i]); }
}
```
Immutability enforced at `Aqua.sol:48`: `require(balance.tokensCount == 0, StrategiesMustBeImmutable(...))` — a `(maker,app,strategyHash,token)` slot can be written only once.

**Exact event signatures** (`aqua/src/interfaces/IAqua.sol`), **none of the params are `indexed`** (they are all non-indexed — verified in source, no `indexed` keyword anywhere):
```solidity
event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
event Docked(address maker, address app, bytes32 strategyHash);
event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
```
Topic0 hashes (computed from the canonical signatures above):
- `Shipped(address,address,bytes32,bytes)`
- `Docked(address,address,bytes32)`
- `Pulled(address,address,bytes32,address,uint256)`
- `Pushed(address,address,bytes32,address,uint256)`
> Because **nothing is indexed**, you cannot filter these logs by maker/token via topics — you must fetch all logs for the Aqua address and decode the data. This matters for Q7.

**(B) SwapVM swap event** (`swap-vm/src/SwapVM.sol:64-72`, emitted at `:242`) — all non-indexed:
```solidity
event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
```
There is **no** "order created" event in SwapVM. For Aqua orders, the position's virtual balances are set by the maker calling `Aqua.ship(app = SwapVMRouter, strategy = abi.encode(order-equivalent), …)` OR pushed in; the first `Aqua` `Shipped`/`Pushed` with `app == SwapVMRouter` is the on-chain birth of a SwapVM Aqua position.

**Confidence: High.**

---

## Q2 — strategyHash derivation

**Verdict:** The premise `keccak256(abi.encode(strategy))` is **wrong for both paths.** Aqua-native uses `keccak256(strategy)` over the **raw `bytes`** the maker supplies (the `abi.encode` happens *outside*, in the caller). SwapVM Aqua orders use `keccak256(abi.encode(order))` over the **`Order` struct**, and that value is what is stored in Aqua as the `strategyHash`.

**Aqua path** (`aqua/src/Aqua.sol:41`): `strategyHash = keccak256(strategy);` — `strategy` is `bytes calldata`. What goes *into* that blob is app-defined. Per the Aqua README example, an XYCSwap app expects `abi.encode(XYCSwap.Strategy{...})`, and the README notes the struct must lead with `maker` "to make strategyHash unique per user":
```solidity
struct Strategy { address maker; address token0; address token1; /* …immutable params… */ }
```
So effectively `strategyHash = keccak256(abi.encode(Strategy))` **only because the caller chose to `abi.encode` a struct** — the contract just hashes raw bytes. If a maker ships a differently-encoded blob, the hash is of those exact bytes. **UNKNOWN:** the full field list/order of every app's `Strategy` struct — it is per-app, and the README truncates XYCSwap's with `// …`. The SwapVM `Strategies.sol` library builds *program bytecode* (not an `abi.encode`d struct) for limit/concentrated orders, so for SwapVM the relevant hash is the Order hash below, not a `Strategy` struct.

**SwapVM path** (`swap-vm/src/SwapVM.sol:109-120`, `ISwapVM.sol:17-21`):
```solidity
struct Order { address maker; MakerTraits traits; bytes data; }   // MakerTraits is a uint256 user-defined value type

function hash(ISwapVM.Order calldata order) public view returns (bytes32) {
    if (order.traits.useAquaInsteadOfSignature()) return keccak256(abi.encode(order));   // Aqua orders
    return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order.maker, order.traits, keccak256(order.data)))); // signed orders (EIP-712)
}
```
- **Aqua orders:** `orderHash = keccak256(abi.encode(Order{maker (address), traits (uint256), data (bytes)}))`. Field order = `maker, traits, data`. `data` = `tokenA(20) ‖ tokenB(20) ‖ program-and-hook slices` (see `MakerTraits.tokens` at `MakerTraits.sol:212` and `MakerTraits.program` at `:219`).
- **Signed orders:** EIP-712 typed-data hash with `ORDER_TYPEHASH = keccak256("Order(address maker,uint256 traits,bytes data)")` (`SwapVM.sol:75-81`), i.e. `_hashTypedDataV4(keccak256(abi.encode(TYPEHASH, maker, traits, keccak256(data))))`.

**Confidence: High** (both hash forms read from source). Field lists of per-app `Strategy` structs: **Low / partly UNKNOWN.**

---

## Q3 — Virtual balance read path

**Verdict:** Nested mapping is `mapping(maker => mapping(app => mapping(strategyHash => mapping(token => Balance))))`, `private`. Read it with the public view **`rawBalances(maker, app, strategyHash, token)`** (never reverts) or **`safeBalances(maker, app, strategyHash, token0, token1)`** (reverts unless both tokens are in an active strategy).

Mapping declaration (`aqua/src/Aqua.sol:21-24`):
```solidity
mapping(address maker => mapping(address app => mapping(bytes32 strategyHash => mapping(address token => Balance)))) private _balances;
```

`Balance` struct (`aqua/src/libs/Balance.sol:11-14`) — **single storage slot**, `amount` in low 248 bits, `tokensCount` in top 8 bits (`BalanceLib.load/store` at `Balance.sol:24-42`):
```solidity
struct Balance { uint248 amount; uint8 tokensCount; }
```
- `amount` (`uint248`): the virtual balance / committed allowance for that token in the strategy.
- `tokensCount` (`uint8`): number of tokens in the strategy. **Sentinel values:** `0` = inactive/never-created, `0xff` (`_DOCKED`, `Aqua.sol:19`) = docked/revoked. Any `1..0xfe` = active with that many tokens.

**Getters** (`IAqua.sol`, impl `Aqua.sol:26-38`):
```solidity
function rawBalances(address maker, address app, bytes32 strategyHash, address token)
    external view returns (uint248 balance, uint8 tokensCount);
function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1)
    external view returns (uint256 balance0, uint256 balance1);   // reverts if either token not in active strategy
```

**Exact `eth_call` for Overdraft** (recommend `rawBalances` — it never reverts, so you can probe liveness via `tokensCount`):
- Selector: `rawBalances(address,address,bytes32,address)` → `keccak256(sig)[0:4]`.
- `to` = Aqua contract; `data` = selector ‖ `abi.encode(maker, app, strategyHash, token)` (4 × 32-byte words).
- For a **SwapVM Aqua position**: `app` = SwapVM router address, `strategyHash` = `keccak256(abi.encode(order))`.
- Decode return: word0 low-248 bits = `balance` (`uint248`), word1 = `tokensCount` (`uint8`). `tokensCount==0` → slot empty; `==0xff` → docked; else active.

`coverage = min(walletBalance(token), erc20Allowance(maker → app/router, token)) / Σ committed amounts` — the committed amount per token is exactly `rawBalances(...).balance`. Note tokens live in the maker EOA; `Aqua.pull` uses `IERC20(token).safeTransferFrom(maker, to, amount)` (`Aqua.sol:68`), so the real cap is `min(ERC20.balanceOf(maker), ERC20.allowance(maker, Aqua))` — allowance is granted **to the Aqua contract**, not to the app/router (the router calls `Aqua.pull`, and Aqua does the `transferFrom`).

**Confidence: High.**

---

## Q4 — Verified-counterparty check ⚠️ (project-blocker analysis)

**Verdict:** There is **NO global "verified counterparty" registry and NO mandatory on-chain counterparty gate.** Aqua's `pull`/`push` have **zero caller authorization** (anyone can call). The "verified counterparty" is an **optional, per-order instruction** the maker *chooses* to embed in their program bytecode — `PrivateOrder` (0x2b), `WhitelistCoequal` (0x2c), or `WhitelistSequential` (0x2d) — which checks `ctx.query.taker` (= `msg.sender` of `swap()`). **If the maker's program omits these opcodes, any address can take the order.** On a fork this is trivial to satisfy: you just `swap()` from (or impersonate) an allowed taker; usually no impersonation is even needed.

**Evidence the base layer is unauthenticated:**
- `Aqua.pull` (`aqua/src/Aqua.sol:63-70`) and `Aqua.push` (`:72-80`) have **no `require(msg.sender == …)`**. The only implicit auth is that the mapping is keyed on `msg.sender` as `app` for `pull` (`_balances[maker][msg.sender][...]`, `:64`) — so a caller can only pull against the app-slot it *is*. The SwapVM router is that app.
- SwapVM `swap()` for Aqua orders **skips signature verification entirely** (`swap-vm/src/SwapVM.sol:221-226`): `if (useAquaInsteadOfSignature) { read safeBalances } else { require(recoverOrIsValidSignature(...)) }`. So an Aqua order needs **no maker signature at swap time** — solvency/authorization is whatever the maker baked into the program.

**Where the counterparty check lives (when present)** — `swap-vm/src/instructions/Whitelist.sol`:
- `PrivateOrder.exec` (`Whitelist.sol:47-50`):
  ```solidity
  function exec(Context memory ctx, bytes calldata args) internal pure {
      uint80 sender = uint80(uint160(ctx.query.taker));
      require(sender == parse(args), PrivateOrderInvalidTaker());   // args = last 10 bytes of allowed taker
  }
  ```
  `ctx.query.taker` is set to `msg.sender` in `swap()` (`SwapVM.sol:149` / `:205`: `taker: msg.sender`). Only the **low 80 bits (last 10 bytes)** of the address are compared (packing trade-off documented at `Whitelist.sol:15-17`).
- `WhitelistCoequal.exec` (`Whitelist.sol:108-118`): loops allowed takers; on match jumps to `nextPC`, else falls through (permissionless continuation).
- `WhitelistSequential.exec` (`Whitelist.sol:204-224`): time-phased whitelist; reverts `WhitelistSequentialTimeViolation` before a taker's unlock window.

Related but distinct taker gates (`swap-vm/src/instructions/TokenValidators.sol`): `OnlyTakerTokenBalanceNonZero` (0x23), `OnlyTakerTokenBalanceGte` (0x24), `OnlyTakerTokenSupplyShareGte` (0x25), `OnlyTxOriginTokenBalanceNonZero` (0x26) — these gate on the taker's *token holdings/tx.origin*, not identity.

**Foundry mainnet-fork bypass — concrete recipe:**
1. Pick a live Aqua order (see Q7). Decode its program bytecode.
2. **If no `0x2b/0x2c/0x2d` opcode is present:** no counterparty gate. Call `AquaSwapVMRouter.swap(order, amount, takerTraitsAndData)` from any funded EOA. Done — no impersonation.
3. **If `PrivateOrder`/`WhitelistCoequal`/`WhitelistSequential` present:** the gate compares only the **last 10 bytes** of `ctx.query.taker` against the embedded allowed taker(s). On a fork, run the swap **from the allowed taker address** via `vm.prank(allowedTaker)` / `vm.startPrank(allowedTaker)` (Foundry cheatcode; no private key needed since you control the fork). Fund that address with the input token + set its ERC20 allowance to the router. For `WhitelistSequential`, also `vm.warp` to a timestamp ≥ the taker's unlock window.
4. Nothing to patch in a storage slot — the check reads calldata (`ctx.query.taker`) and the embedded program bytes, both of which you control as the caller. There is **no admin role, no registry mapping slot** to overwrite.
5. To make the *maker* side work you must ensure the maker's Aqua virtual balance is active and the maker's real ERC20 `balanceOf`/`allowance(maker→Aqua)` cover `amountOut` — else `Aqua.pull`'s `safeTransferFrom` reverts. On a fork you can `deal()` tokens to the maker and `vm.prank(maker)` to `approve(Aqua, ...)` if needed.

**This is the opposite of a blocker — it is the enabler.** The absence of a mandatory counterparty registry is *why* Overdraft's premise works: coverage can be under-collateralized precisely because the base layer trusts the maker's embedded rules and the maker's real wallet balance/allowance, which can drift below the sum of committed virtual balances.

**Confidence: High** (all citations from current source).

---

## Q5 — SwapVM instruction set + opcode numbering (CURRENT, re-banked)

**Verdict:** Opcodes are a **banked `enum Opcode`** (`swap-vm/src/libs/OpcodeList.sol:16-292`) — the value is the enum ordinal (byte). A new instruction is a **Solidity `library`** exposing `Opcode constant opcode`, `build(...)`, `parse(...)`, and `exec(Context memory ctx, bytes calldata args)`, and is wired into a dispatcher's `_runOpcode` if-chain. **There is no Solidity `interface` to implement** — it's a structural convention + enum slot + dispatcher registration. This is confirmed against `main` at `OpcodeList.sol` (re-banked layout, matches ottodevs/plimsoll note).

**Current allocated opcodes** (from `OpcodeList.sol` enum ordinals; `_xx` = reserved-free-slot placeholders, unallocated):

| Bank | Opcode | # | Bank | Opcode | # |
|---|---|---|---|---|---|
| Core 0x00–0x0f | `Stop` | 0x00 | Fees 0x70–0x8f | `FeeFlatIn` | 0x70 |
| | `Revert` | 0x01 | | `FeeFlatOut` | 0x71 |
| | `Salt` | 0x02 | | `FeeProtocol` | 0x80 |
| | `Jump` | 0x03 | Balances 0x90–0xaf | `StaticBalances` | 0x90 |
| | `Extruction` | 0x04 | | `DynamicBalances` | 0x91 |
| Debug 0x10–0x1f | `PrintSwapRegisters` | 0x10 | | `DutchAuctionBalanceIn` | 0x94 |
| | `PrintSwapQuery` | 0x11 | | `DutchAuctionBalanceOut` | 0x95 |
| | `PrintVM` | 0x12 | | `PiecewiseLinearScaleBalanceIn` | 0x98 |
| | `PrintFreeMemoryPointer` | 0x13 | | `PiecewiseLinearScaleBalanceOut` | 0x99 |
| | `PrintGasLeft` | 0x14 | | `Decay` | 0x9c |
| | `PrintFee` | 0x15 | | `TWAPSwap` | 0x9d |
| | `PatchSwapRegisters` | 0x1a | Rates 0xb0–0xcf | `RequireMinRate` | 0xb0 |
| Guards 0x20–0x3f | `Deadline` | 0x20 | | `AdjustMinRate` | 0xb1 |
| | `OnlyTakerTokenBalanceNonZero` | 0x23 | | `OraclePriceAdjuster` | 0xb2 |
| | `OnlyTakerTokenBalanceGte` | 0x24 | | `BaseFeeAdjuster` | 0xb4 |
| | `OnlyTakerTokenSupplyShareGte` | 0x25 | Swap curves 0x50–0x6f | `XYCSwap` | 0x50 |
| | `OnlyTxOriginTokenBalanceNonZero` | 0x26 | | `XYCConcentrateSwap` | 0x51 |
| | `PrivateOrder` | 0x2b | | `LimitSwap` | 0x53 |
| | `WhitelistCoequal` | 0x2c | | `LimitSwapFullAmount` | 0x54 |
| | `WhitelistSequential` | 0x2d | | `PeggedSwap` | 0x58 |
| | `JumpIfDirection` | 0x30 | Invalidators 0x40–0x4f | `InvalidateBit` | 0x40 |
| | `JumpIfTokenIn` | 0x31 | | `InvalidateTokenIn` | 0x41 |
| | `JumpIfTokenOut` | 0x32 | | `InvalidateTokenOut` | 0x42 |
| | | | | `ValidateSeriesEpoch` | 0x48 |

- Banks: `0x00–0x0f` core control; `0x10–0x1f` debug (only in `*Debug` opcode sets); `0x20–0x3f` conditions/access guards; `0x40–0x4f` invalidators/epochs; `0x50–0x6f` swap curves; `0x70–0x8f` fees; `0x90–0xaf` balances; `0xb0–0xcf` rates; `0xd0–0xef` unallocated; `0xf0–0xff` **reserved, never allocate** (`OpcodeList.sol:275`, kept for a possible 2-byte-opcode escape prefix).
- **Dispatch:** VM reads program as `[opcode(1) ‖ argLen(1) ‖ args(argLen)]…` (`VM.sol:134-146`), then `ctx.vm.dispatch(ctx, opcode, args)`. Concrete dispatchers: `Opcodes._runOpcode` (full set, `swap-vm/src/opcodes/Opcodes.sol:45-87`) and `AquaOpcodes._runOpcode` (reduced Aqua set, `AquaOpcodes.sol:27-45`). A router binds `_dispatch → _runOpcode` (`AquaSwapVMRouter.sol:26-28`).

**Where "SolvencyGuard" plugs in:**
1. Add a slot to the `Opcode` enum in an **unallocated** bank — e.g. an unused guard slot `0x21` / `0x22` / `0x27–0x2a` (guards bank fits it semantically) or an unallocated `0xd0` slot.
2. Write `library SolvencyGuard` mirroring `Whitelist`/`TokenValidators` shape: `Opcode constant opcode = Opcode.SolvencyGuard; function build(...); function parse(...); function exec(Context memory ctx, bytes calldata args) internal view { … }`. In `exec`, read `ctx.query.maker`, `ctx.query.tokenIn/tokenOut`, `ctx.swap.*` and (via an external call) `AQUA.rawBalances(...)` + ERC20 `balanceOf/allowance`, then `require(coverage OK)`.
3. Register it: add `else if (opcode == SolvencyGuard.opcode.asU8()) SolvencyGuard.exec(ctx, args);` to a custom dispatcher extending `Opcodes`/`AquaOpcodes`, and deploy a router extending `SwapVM` + that dispatcher (pattern: `AquaSwapVMRouter`).

> **README discrepancy to flag:** `swap-vm/README.md` shows a custom-router example overriding `function _instructions() … returns (function(...)[] memory)`. The **current source does not use `_instructions()`** — dispatch is the `_runOpcode` if-chain + `_dispatch` override. Trust the source (`Opcodes.sol` / `AquaSwapVMRouter.sol`), not the README snippet, for wiring SolvencyGuard.

**Confidence: High** (opcode table + dispatch read directly from current `main`). README wiring snippet: stale.

---

## Q6 — Invariants (canonical list)

**Verdict:** The 7 named invariants are confirmed **in the README prose**, but there is **no `CoreInvariants` *contract*** that programs inherit at runtime. Invariants live in a **test harness** `test/invariants/CoreInvariants.t.sol` (a Foundry helper you inherit in *tests*). Its aggregate `assertAllInvariantsWithConfig` wires **6** dedicated assert-functions; the 7th ("Strategy Liveness") is a design property described in the README, not a standalone assert in the aggregate. A custom program does **not** "inherit and run" invariants on-chain — you validate a new instruction by writing a Foundry test that calls `assertAllInvariants(...)`.

**README's seven** (`swap-vm/README.md`): 1. Exact In/Out Symmetry · 2. Swap Additivity · 3. Quote/Swap Consistency · 4. Price Monotonicity · 5. Rounding Favors Maker · 6. Balance Sufficiency · 7. Strategy Liveness. ✅ matches the brief's list.

**Actual assert functions** (`swap-vm/test/invariants/CoreInvariants.t.sol`):
- `assertSymmetryInvariant` (`:224`) — `exactIn(X)→Y ⇒ exactOut(Y)→X` within tolerance.
- `assertAdditivityInvariant` (`:270`) — split-vs-whole trade consistency.
- `assertQuoteSwapConsistencyInvariant` (`:336`) — `quote()` == `swap()` amounts.
- `assertMonotonicityInvariant` (`:374`) — larger trades ≥ equal-or-worse price.
- `assertRoundingFavorsMakerInvariant` (`:426`) — `amountIn` ceil, `amountOut` floor (matches `XYCSwap.exec` at `XYCSwap.sol:40-43`).
- `assertBalanceSufficiencyInvariant` (`:516`) — cannot exceed available liquidity; **always run** (`:210-217`, not behind a skip flag).
- Aggregators: `assertAllInvariants` (`:89`) → `assertAllInvariantsWithConfig` (`:107`); `assertBatchInvariants` (`:546`); `_getDefaultConfig` (`:561`).
- **"Strategy Liveness"** has **no dedicated `assert*` function** in the aggregate; it is the README property that AMM curves stay live when a reserve is depleted (see e.g. `XYCSwap` behavior). Treat items 1–6 as machine-checked, item 7 as a design invariant. *(UNKNOWN: whether a Liveness assert exists in another file under `test/invariants/` — only `CoreInvariants.t.sol` was read.)*

**How a custom program "runs" them:** inherit the harness in a test, per README:
```solidity
contract MyInstructionTest is Test, OpcodesDebug, CoreInvariants {
    function test_MaintainsInvariants() public {
        ISwapVM.Order memory order = createOrderWithMyInstruction();
        assertAllInvariantsWithConfig(swapVM, order, tokenIn, tokenOut, _getDefaultConfig());
    }
}
```
For SolvencyGuard: since it's a *guard* (revert-or-continue, doesn't touch `amountIn/amountOut`), it should be invariant-neutral — write a test asserting invariants still hold when the guard passes, plus explicit revert tests when coverage is insufficient.

**Confidence: High** for the 6 asserted + names; **Med** on Strategy-Liveness having no assert (only one invariants file inspected).

---

## Q7 — Cleanest enumeration of ALL live positions on a chain

**Verdict:** **There is no enumerable set and no registry — event log replay is the only path.** Enumerate by scanning the **Aqua contract's `Shipped` logs** (creation), reconciling against `Docked` (revocation) and `Pushed`/`Pulled` (balance deltas), then confirming current state per `(maker,app,strategyHash,token)` via `rawBalances` `eth_call`. Recommendation: **a lightweight indexer / log-scan** (self-rolled or subgraph), not on-chain enumeration. There is **no SDK helper and no subgraph** documented.

**Why no on-chain enumeration:**
- `Aqua`'s only state is the `private` nested mapping `_balances` (`Aqua.sol:21-24`). Mappings are **not enumerable**; there is **no array/EnumerableSet of makers, apps, or strategyHashes**, and no `getAllX` view. The contract exposes only point-lookups (`rawBalances`/`safeBalances`).
- `strategyHash` for SwapVM orders = `keccak256(abi.encode(order))` — you can only reconstruct it if you know the full `Order`, which itself only appears on-chain inside `Shipped`'s `strategy` bytes (Aqua-native) or is off-chain (signed orders). So logs are the sole discovery source.

**Recommended pipeline:**
1. `eth_getLogs` on the Aqua address for topic0 = `Shipped(address,address,bytes32,bytes)` across the chain's history (chunk by block range). Each gives `(maker, app, strategyHash, strategy)` — the strategy blob is fully self-describing (data-availability by design, `IAqua` docstring on `ship`).
2. Collect `Docked(address,address,bytes32)` and `Pulled`/`Pushed` to track lifecycle and running virtual balances. **All params are non-indexed**, so you cannot topic-filter by maker — decode every log's data.
3. For "live" set: a `(maker,app,strategyHash)` is live iff, for its tokens, `rawBalances(...).tokensCount ∈ [1, 0xfe]` (not `0`, not `0xff`). Confirm with a batched `eth_call` (multicall) per token.
4. Coverage = for each live position, `min(ERC20.balanceOf(maker), ERC20.allowance(maker, Aqua)) / Σ rawBalances(...).amount` over the strategy's tokens.

**Options ranked:**
- ✅ **Log scan + `rawBalances` confirm (self-rolled indexer):** fully grounded in what the contract exposes; deterministic; no external dependency. Best for the hackathon.
- ⚠️ **Subgraph:** same data, more infra; only worth it if you need a queryable API. No official Aqua subgraph found (**UNKNOWN** if one exists).
- ❌ **On-chain enumerable read:** impossible — no enumerable structure.
- ❌ **SDK helper:** none documented (`@1inch/aqua` npm referenced but README documents no enumerate/list helper — **UNKNOWN** if the JS SDK ships one; do not assume).

**Confidence: High** (grounded in the mapping being `private` + non-enumerable and events being the only discovery surface).

---

## Blockers & open questions

1. **No blocker for the core thesis.** Q4 confirms the base layer is permissionless and Aqua orders are signature-free at swap time; coverage under-collateralization is structurally possible and forkable. SolvencyGuard has a clean plug-in point (Q5).
2. **Two-hash disambiguation is a correctness risk.** Whoever indexes must not assume `keccak256(abi.encode(strategy))`. For SwapVM positions the Aqua key is `(order.maker, SwapVMRouter, keccak256(abi.encode(Order)), token)`. Get the `Order`/`data` layout exactly right (`MakerTraits` bit-packing, `data` slice order) before computing hashes — see `MakerTraits.sol` (only partially read; **verify `_getDataSlice`/`OrderDataSlices` offsets before implementing the hash**).
3. **Deployment addresses — Medium confidence.** Aqua README lists `Aqua ≈ 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`, `SwapVM router ≈ 0x111111338c5091e8440b67b168bae16a668ac0de` (vanity `0x1111…`), 16 chains incl. Ethereum mainnet. A web search returned a *different* value (`0x8fdd04…`) — **do not hardcode; verify the exact mainnet address on Etherscan / from the repo's `deployments/` before forking.**
4. **`Strategy` struct field lists are per-app and partly UNKNOWN.** The XYCSwap struct in the README is truncated (`// …`). If Overdraft needs to reconstruct/verify Aqua-native (non-SwapVM) strategy hashes, read each app's exact struct. For SwapVM orders this is moot (program-bytecode based).
5. **Strategy-Liveness invariant** has no dedicated assert in `CoreInvariants.t.sol`; only 6 of 7 are machine-checked in the aggregate (Med confidence — only one invariants file inspected).
6. **README wiring is stale** re: `_instructions()`. Use the `_runOpcode`/`_dispatch` pattern from current source for SolvencyGuard.

### Confidence summary
| Q | Topic | Confidence |
|---|---|---|
| 1 | Creation + events | High |
| 2 | strategyHash derivation | High (structs: Low/partial UNKNOWN) |
| 3 | Virtual balance read path | High |
| 4 | Verified-counterparty / fork bypass | High |
| 5 | Instruction set + opcodes + plug-in | High (README snippet stale) |
| 6 | Invariants | High (Liveness: Med) |
| 7 | Enumeration path | High |
