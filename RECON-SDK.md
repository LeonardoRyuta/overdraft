# RECON-SDK — 1inch Aqua / SwapVM TypeScript SDKs

Agent B recon for the **Overdraft** project (ETHOnline 2026). Everything below was
observed by installing the packages and reading their shipped `.d.ts` files + running
them at runtime. Nothing here is guessed; unknowns are marked **UNKNOWN**.

Recon date: 2026-09-04. Node v22.17.0, npm 10.9.2 (both present).

---

## TL;DR

- Both SDKs install cleanly and the API surface is real. ✅
- **Honesty Probe is FEASIBLE: quote, swap, and hashOrder calldata are separately
  constructible from the same `Order`, and produce three distinct 4-byte selectors**
  (`0x44aa5f14`, `0xf4d2d412`, `0xf5d08521`). ✅ (proof below)
- One real packaging gotcha: `@1inch/swap-vm-sdk`'s **native-Node ESM build is broken**.
  Use `tsx`/esbuild/vite/next (bundler resolution) or CommonJS `require()`. Details below.
- `Order`, `MakerTraits`, `TakerTraits`, `AquaAMMStrategy` live in **swap-vm-sdk**, NOT
  aqua-sdk. The plan's grouping was slightly off; corrected here.

---

## 1. Resolved package names + versions

Queried directly from `https://registry.npmjs.org/...` (npmjs.com website 403s bots).

| Package | Latest | dist-tags | First published | Latest published | License |
|---|---|---|---|---|---|
| `@1inch/aqua-sdk` | **0.3.1** | latest=`0.3.1`, next=`0.3.1-rc.0` | 2025-11-17 | 2026-08-18 | `LicenseRef-Degensoft-Aqua-Source-1.1` |
| `@1inch/swap-vm-sdk` | **0.4.1** | latest=`0.4.1`, next=`0.4.1-rc.0` | 2025-11-17 | 2026-08-18 | `LicenseRef-Degensoft-SwapVM-1.1` |
| `@1inch/sdk-core` | **0.1.3** (transitive dep of aqua-sdk) | — | — | — | — |

- Package names in the plan are **CORRECT** (`@1inch/aqua-sdk`, `@1inch/swap-vm-sdk`). ✅
- Both list `homepage: github.com/1inch/sdks` (the TS SDK monorepo — its `main`
  package.json is not publicly fetchable → **UNKNOWN**, but npm is authoritative).
- `github.com/1inch/aqua` is the **Solidity** protocol (`@1inch/aqua`, a Foundry repo),
  not the TS SDK. Don't confuse the two.
- Maintainers: `1inch-robot`, `k06a`, `zumzoom`, et al. — genuine 1inch org publishers.
- aqua-sdk versions: `0.1.0 … 0.3.1`. swap-vm-sdk versions: `0.1.0 … 0.4.1`.

## 2. Install — exact commands

Ran in `spikes/sdk/`:

```bash
npm init -y
npm install @1inch/aqua-sdk @1inch/swap-vm-sdk viem
```

Result: `added 18 packages … found 0 vulnerabilities`. **No failures.** ✅
Installed: `@1inch/aqua-sdk@0.3.1`, `@1inch/swap-vm-sdk@0.4.1`, `@1inch/sdk-core@0.1.3`
(transitive), `viem@2.56.3`. viem is deduped across all three.

To run the spike (use tsx, see gotcha in §6):

```bash
npx tsx read-positions.ts [makerAddress]
# or: npm run read-positions
```

## 3. Verified API surface

### `@1inch/aqua-sdk@0.3.1` — top-level exports (observed at runtime)
`ABI, AQUA_CONTRACT_ADDRESSES, Address, AquaProtocolContract, DockedEvent, HexString,
NetworkEnum, PulledEvent, PushedEvent, ShippedEvent`

**`AquaProtocolContract`** (class) — encode/decode for the 4 core Aqua methods:
```ts
new AquaProtocolContract(address: Address)
// statics:
AquaProtocolContract.encodeShipCallData(args: ShipArgs): HexString
AquaProtocolContract.encodeDockCallData(args: DockArgs): HexString
AquaProtocolContract.buildShipTx(contractAddress: Address, params: ShipArgs): CallInfo
AquaProtocolContract.buildDockTx(contractAddress: Address, params: DockArgs): CallInfo
AquaProtocolContract.calculateStrategyHash(strategy: HexString): HexString
// instance:
.ship(params: ShipArgs): CallInfo
.dock(params: DockArgs): CallInfo
```
Types: `ShipArgs = { app: Address; strategy: HexString; amountsAndTokens: {amount: bigint; token: Address}[] }`,
`DockArgs = { app: Address; strategyHash: HexString; tokens: Address[] }`.
⚠️ There is **NO `push`/`pull` calldata builder class method** — but `push`, `pull`,
`rawBalances`, `safeBalances` ARE in the exported `AQUA_ABI`, so read/write them via viem.

**`AQUA_CONTRACT_ADDRESSES`**: `Record<NetworkEnum, Address>`. Observed value — **same
address on ALL 16 chains**: `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`.
Verified deployed on Ethereum mainnet (5619 bytes of bytecode).

**`ABI.AQUA_ABI`** (namespace export `aqua.ABI.AQUA_ABI`): full Aqua ABI. Relevant
**view** functions for reading positions:
- `rawBalances(maker, app, strategyHash, token) -> (uint248 balance, uint8 tokensCount)` — the **virtual (raw) balance** per token. This is the coverage denominator input.
- `safeBalances(maker, app, strategyHash, token0, token1) -> (uint256 balance0, uint256 balance1)`.
Write functions: `ship`, `dock`, `push(maker,app,strategyHash,token,amount)`, `pull(...)`.
Events: `Shipped`, `Docked`, `Pushed`, `Pulled` — all **fully non-indexed** (data-only).

**Event classes** (`ShippedEvent`, `DockedEvent`, `PushedEvent`, `PulledEvent`): each has
`static TOPIC: HexString` and `static fromLog(log: LogLike): TEvent`.
`ShippedEvent` fields: `{ maker, app, strategyHash, strategy }`. TOPIC =
`0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0`.

### `@1inch/swap-vm-sdk@0.4.1` — top-level exports (observed at runtime)
`ABI, AQUA_SWAP_VM_CONTRACT_ADDRESSES, Address, AquaAMMStrategy, AquaPeggedAmmStrategy,
AquaProgramBuilder, AquaXYCAmmStrategy, HexString, MakerTraits, NetworkEnum, Order,
ProgramBuilder, RegularProgramBuilder, SwapVMContract, SwapVmProgram, SwappedEvent,
TakerTraits, instructions`

**`SwapVMContract`** (class) — THE Honesty-Probe class:
```ts
new SwapVMContract(address: Address)
// statics (calldata builders — separate for each op):
SwapVMContract.encodeQuoteCallData(args: QuoteArgs): HexString
SwapVMContract.encodeSwapCallData(args: SwapArgs): HexString
SwapVMContract.encodeHashOrderCallData(order: Order): HexString
SwapVMContract.buildQuoteTx(contractAddress: Address, args: QuoteArgs): CallInfo
SwapVMContract.buildSwapTx(contractAddress: Address, args: SwapArgs): CallInfo
SwapVMContract.buildHashOrderTx(contractAddress: Address, order: Order): CallInfo
// instance conveniences:
.quote(args: QuoteArgs): CallInfo
.swap(args: SwapArgs): CallInfo
.hashOrder(order: Order): CallInfo
```
`QuoteArgs === SwapArgs === { order: Order; tokenIn: Address; tokenOut: Address;
amount: bigint; takerTraits: TakerTraits }`.
Result types (for decoding eth_call output): `QuoteResult = { amountIn, amountOut }`,
`SwapResult = { amountIn, amountOut, orderHash }`.
On-chain `quote` and `swap` functions confirmed present in the exported `SwapVM.abi`.

**`AQUA_SWAP_VM_CONTRACT_ADDRESSES`**: `Record<NetworkEnum, Address>`. Observed —
**same on all 16 chains**: `0x111111338c5091e8440b67b168bae16a668ac0de`
(the `AquaSwapVMRouter`; EIP-712 domain name `"1inch SwapVM v1.0"`, version `1.0.2`).

**`Order`** (class):
```ts
new Order(maker: Address, traits: MakerTraits, program: SwapVmProgram)
Order.new({ maker, traits, program }): Order
Order.decode(encoded: HexString): Order
Order.ABI  // tuple(address maker, uint256 traits, bytes data)
.hash(domain?): HexString   // Aqua mode = keccak256(encode()); EIP-712 mode needs domain
.encode(): HexString        // ABI-encoded order tuple
.build(): { maker, traits: bigint, data }
```

**`MakerTraits`** (class): packed uint256 flags + hooks. `.default()` sets
`useAquaInsteadOfSignature=true`. `MakerTraits.new(...)`, `.with(partial)`, `.encode(maker?)
-> {traits: bigint, hooksData}`, `.decode(traits, hooksData?)`.

**`TakerTraits`** (class): `exactIn`, `threshold`, `deadline`, hooks/callbacks, `signature`.
`.default()` (exactIn + transferFromAndAquaPush), `.new(partial)`, `.with(...)`, `.encode()
-> HexString`, `.decode(packed)`, `.validate(amountIn, amountOut)`.

**Strategies (for building programs):**
- `AquaAMMStrategy` (abstract base) — `withProtocolFee(bps, receiver)`, `withDecayPeriod`,
  `withFeeTokenIn(bps)`, `withTxOriginAccessToken(token)`, `withSalt(salt)`.
- `AquaXYCAmmStrategy extends AquaAMMStrategy` — `.new()`, `.newConcentrate(prices)`,
  `.build(): SwapVmProgram`. (constant-product x*y=k)
- `AquaPeggedAmmStrategy extends AquaAMMStrategy`.
- `AquaProgramBuilder` / `RegularProgramBuilder` — low-level VM program builders
  (jump, deadline, xycSwapXD, fees, decay, debug ops, …).

**`SwappedEvent`**: `{ orderHash, maker, taker, tokenIn, tokenOut, amountIn, amountOut }`,
`static TOPIC`, `static fromLog(log)`. Useful for indexing realized swaps.

### `@1inch/sdk-core@0.1.3` — shared primitives
`Address, AddressHalf, HexString, Interaction, NetworkEnum, assert*`.
- `Address`: `new Address(str)`, `.toString(): 0x…`, `.isZero()`, `.isNative()`, `Address.ZERO_ADDRESS`, `Address.NATIVE_CURRENCY`, `.fromBigInt()`.
- `NetworkEnum`: ETHEREUM=1, OPTIMISM=10, CRONOS=25, BINANCE=56, GNOSIS=100, UNICHAIN=130,
  POLYGON=137, MONAD=143, SONIC=146, ZKSYNC=324, HYPEREVM=999, ROBINHOOD=4663,
  COINBASE=8453, ARBITRUM=42161, AVALANCHE=43114, LINEA=59144.
- `CallInfo = { to: 0x…; data: 0x…; value: bigint }`. `LogLike = { data, topics }`.

## 4. Plan-assumption checklist

| Plan assumed | Reality | Status |
|---|---|---|
| `@1inch/aqua-sdk` exists/installs | v0.3.1, installs clean | ✅ |
| `@1inch/swap-vm-sdk` exists/installs | v0.4.1, installs clean | ✅ |
| `AquaProtocolContract` | in aqua-sdk, ship/dock encoders + calculateStrategyHash | ✅ |
| `AQUA_CONTRACT_ADDRESSES` | in aqua-sdk, `Record<NetworkEnum, Address>` | ✅ |
| `AQUA_SWAP_VM_CONTRACT_ADDRESSES` | in **swap-vm-sdk**, `Record<NetworkEnum, Address>` | ✅ |
| `Order` | in **swap-vm-sdk** (not aqua-sdk) | ✅ (location differs) |
| `MakerTraits` | in **swap-vm-sdk** | ✅ (location differs) |
| `AquaAMMStrategy` | in **swap-vm-sdk** (+ XYC/Pegged subclasses) | ✅ (location differs) |
| "typed calldata for quote, swap AND hash operations" | `SwapVMContract.encode{Quote,Swap,HashOrder}CallData` | ✅ **CONFIRMED** |
| Read maker positions / virtual balances via SDK | `AQUA_ABI.rawBalances` (view) + `Shipped` events; no dedicated `getPositions()` helper — you compose it yourself | ⚠️ partial |

Notes / corrections for the plan:
- There is **no one-call "read all positions for a maker" helper**. You discover positions
  from `Shipped` events (maker→app→strategyHash) and read per-token virtual balances via
  `rawBalances`. The SDK gives you the ABI + event decoders; you compose the query.
- `push`/`pull` have no dedicated builder method (only ship/dock do); use the ABI directly.

## 5. Can we construct QUOTE and SWAP calldata separately? → **YES.** ✅

Executed against installed v0.4.1 (built one `Order` via `AquaXYCAmmStrategy`, then called
each encoder independently):

```
QUOTE calldata selector = 0x44aa5f14   (encodeQuoteCallData)
SWAP  calldata selector = 0xf4d2d412   (encodeSwapCallData)
HASH  calldata selector = 0xf5d08521   (encodeHashOrderCallData)
order.hash() (Aqua mode) = 0x5261dfdf… (keccak256 of ABI-encoded order)
all three distinct = true
```

Three separate static methods, three distinct 4-byte selectors, all derivable from the
**same `Order`** without executing anything. This is exactly what the Honesty Probe needs:
construct a QUOTE and a SWAP for the same position independently and compare. `buildQuoteTx`
/ `buildSwapTx` return ready-to-`eth_call` `{to,data,value}` `CallInfo` objects pointing at
the AquaSwapVMRouter (`0x1111…c0de`). Reproduce via the `=== Honesty Probe ===` section of
`spikes/sdk/read-positions.ts`.

## 6. ⚠️ Real gotcha: swap-vm-sdk ESM build is broken under native Node

`@1inch/swap-vm-sdk@0.4.1`'s `dist/index.mjs` does
`import ... from '@1inch/byte-utils/dist/constants'` (no `.js` extension), and
`@1inch/byte-utils` ships **no `"exports"` map** (only `"main"`), so Node's native ESM
loader throws:
```
ERR_MODULE_NOT_FOUND: Cannot find module '.../@1inch/byte-utils/dist/constants'
  imported from .../@1inch/swap-vm-sdk/dist/index.mjs
```
- `@1inch/aqua-sdk` ESM is **NOT** affected (imports resolve fine).
- **Workarounds that WORK (all verified):**
  1. **`tsx` / esbuild / vite / Next.js** — bundler resolution adds the extension. ✅ (the spike runs under `npx tsx`.)
  2. **CommonJS `require('@1inch/swap-vm-sdk')`** — CJS resolves extensionless paths. ✅
- Plain `node someFile.mjs` importing swap-vm-sdk will fail. Since Overdraft's app will run
  under a bundler (Next/Vite) or tsx, this is a non-blocker — just don't invoke raw Node ESM.

## 7. Spike script

`spikes/sdk/read-positions.ts` (run: `npx tsx read-positions.ts [maker]`). It:
1. resolves `AQUA_CONTRACT_ADDRESSES` + `AQUA_SWAP_VM_CONTRACT_ADDRESSES` for a chain,
2. connects to a public RPC and confirms the Aqua contract is deployed,
3. discovers a maker's positions from `Shipped` events (best-effort; public RPCs cap
   `eth_getLogs` ranges — use an archive node/indexer for production),
4. reads per-token virtual balances via `rawBalances` (coverage denominator),
5. runs the Honesty-Probe proof (separate quote/swap/hash calldata).

RPC verified working: `https://ethereum-rpc.publicnode.com` (mainnet, block ~25.9M).
`https://eth.llamarpc.com` failed at recon time (HTTP error) — publicnode is the default.

### Outstanding dependency (blocker for *live* position data, not for the SDK)
- **Need a real maker address that has an active Aqua position.** With the zero-address
  placeholder the script runs end-to-end and proves the Honesty Probe, but returns 0
  positions. Public-RPC `eth_getLogs` range limits prevented auto-discovery during recon;
  supply a known maker (`npx tsx read-positions.ts 0x<maker>`) or point `RPC_URL` at an
  archive/indexer to get real balances. **UNKNOWN**: a confirmed live maker on mainnet.
- The token list for a position is **not** in the `Shipped` event; derive it from the
  `ship()` tx calldata or by tracking `Pushed`/`Pulled` events. Left as a follow-up in the
  spike (positions come back with `tokens: []`).
