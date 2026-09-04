# Overdraft — Prior Art

**Prepared:** 2026-09-04 · Agent D · ETHOnline 2026 hackathon

**Headline verdict — has anyone already built Overdraft?**
**NO — but one project (`marcos-golem/aqua-arkiv-indexer`) has built the diagnostic half of it, and you must name it before a judge does.** It computes a per-maker `coverageRatio` (wallet balance vs. virtual commitments across every app) and exposes a `/api/underfunded` endpoint. It is a **read/index layer only** — no `min(wallet, allowance)` ceiling, no on-chain enforcement, no SwapVM instruction, and by its own `todo.md` it currently *misses* the wallet-drain case it exists to catch. Nobody has shipped the full Overdraft (coverage-with-allowance + fork verification + a quote-refusing SwapVM `SolvencyGuard`).

> **What Overdraft is:** a diagnostic + fix for the gap between quoted (virtual) depth and actually-backed depth on 1inch Aqua. It inspects **already-deployed** Aqua positions and computes `coverage = min(wallet_balance, aqua_allowance) / sum(virtual_balances)` per maker across all chains, verifies it on a fork, and ships a custom SwapVM instruction ("SolvencyGuard") that **refuses to quote beyond real backing** (a quote *ceiling*, enforced on-chain).

All Aqua-context projects below cluster around **ETHGlobal Lisbon 2026 (Jul 24–26)**, the same weekend Aqua opened to developers; Aqua went fully public **28 Jul 2026**.

---

## 1. `ottodevs/plimsoll` → renamed **Doca** (`ottodevs/doca`)

- **Source (confirmed from repo/code):** https://github.com/ottodevs/doca (the `plimsoll` slug 301-redirects to this repo, id `1312041800`, created 2026-07-25). Live: https://doca-finance.pages.dev
- Contracts source-verified on Sourcify (Base 8453): InventorySkewProvider `0x768FDce0cD1b6237811CA50D7758698e7EDe54D9`, DocaApp `0x8A151aF27a0Ae421A2222ed9b6c58cd8AC179694`.

**What it does (confirmed from the Solidity):** Doca is a **budget layer** for Aqua with two pieces.
- **On-chain `InventorySkewProvider.sol`** — an `IProtocolFeeProvider` plugged into SwapVM's stock `AquaDynamicProtocolFeeAmountIn` instruction (**opcode 30**, at pinned `swap-vm#b44977a1`; upstream `main` "has since re-banked the opcode space"). It returns a **fee** that is flat while a strategy's budget is healthy and rises **quadratically** as the outgoing leg drains toward a "waterline". Directional (only surcharges the scarce/outgoing token) and de-leveraging (SwapVM pulls the surcharge from the maker's Aqua balance to `harvestTo`). *Confirmed: the report is accurate.*
- **Off-chain "Harbormaster"** (lives in `web/src/App.tsx`) — watches shipped strategies and, when one crosses its waterline, `dock`s and re-`ship`s it against current wallet balances. Automates the whitepaper's manual "dock chronically underfunded positions" advice.

**What it does NOT do (confirmed from code + comments):**
- It **never refuses, reverts, or caps a quote.** `getFeeBpsAndRecipient(...)` only returns `(feeBps, recipient)`; the fill still executes. A quote ceiling is out of scope for a fee provider.
- Its pricing **deliberately reads only `AQUA.rawBalances`** (virtual balances) — *"never the wallet balance or allowances, which is what the whitepaper says an app should price against."* This is the exact opposite of Overdraft's inputs.
- It prices **cumulative consumption vs. a per-strategy `budget`**, one order at a time; it has no cross-maker/cross-chain aggregate coverage number. Its own `adversarial.test.ts` documents three blind spots: a single large fill settles at the pre-fill base rate; an ERC-20 transfer made *outside* Aqua is invisible to the fee curve; and two strategies on the same wallet price independently (one can look untouched while the shared wallet is already drained).
- **Doca even sketches an unbuilt `IBudgetGuard` SwapVM instruction** (README, "The next layer") whose `OnBreach { Revert, CapOutput, PricePostTradeState }` is conceptually the closest thing anyone has *described* to Overdraft's SolvencyGuard — but it explicitly says **"Not built."** and lists the pipeline-reordering problems (a fee opcode runs before the curve, so it can't cap output after the fact). *This is the single sharpest overlap-of-intent to acknowledge — and it validates that our on-chain ceiling is the un-built piece everyone gestures at.*

**How Overdraft differs:** Doca prices depletion (a **fee** that gets steeper) using **virtual balances only**; Overdraft imposes a **ceiling** (a quote it will **refuse**) computed from **real backing = `min(wallet, allowance)`**. Different layer (fee vs. admission control), different input (virtual-only vs. wallet+allowance), different failure response (charge more vs. don't quote). Doca is per-strategy budget discipline for *one maker who opts in*; Overdraft is a solvency *diagnostic across all makers/chains* plus the enforcement instruction Doca calls out as missing.

**Useful SwapVM learnings extracted from this repo (verified in code):**
- **Opcode 30 = `_aquaDynamicProtocolFeeAmountInXD`** — the dynamic-protocol-fee extension point; stable across the June and `b44977a1` (release-1.2) revisions per the README. `IProtocolFeeProvider.getFeeBpsAndRecipient(orderHash, maker, taker, tokenIn, tokenOut, isExactIn) → (uint32 feeBps, address recipient)`, fee denominator `1e9 == 100%`.
- **`AQUA.rawBalances(maker, app, orderHash, token) → (uint248 balance, ...)`** is how you read an Aqua strategy's virtual balance on-chain. References/shipped amounts can't be read back after trading starts (Doca records them itself in `setWaterline`).
- **Instruction order is security-critical**; DocaApp builds the program `deadline → dynamicFee → flatFee → decay → xyc(concentrate|swap) → salt`. Fees run **before** the curve. Opcodes used: `_deadline`, `_aquaDynamicProtocolFeeAmountInXD`, `_flatFeeAmountInXD`, `_decayXD`, `_xycConcentrateGrowLiquidity2D`, `_xycSwapXD`, `_salt`.
- **Router skew gotcha:** the live 12-chain routers (June, `eip712Domain()` = `1.0.0`) predate the order-data layout the current hackathon template (`swap-vm#b44977a1`) targets — new template orders **revert against the June router**. Doca (and Sluice) deploy their **own** `AquaSwapVMRouter` wired to the canonical live Aqua registry. Expect to do the same on a fork.
- `contracts/test/utils/SwapVMHelpers.ts` in the repo is a complete reference implementation of `MakerTraits`/`TakerTraits` bit-packing (flag bit offsets, the 40-byte `tokenA++tokenB` order-data prefix, slice-index packing) — worth copying rather than re-deriving.
- **Doca's own "Prior art" section** names two more opcode-30 neighbours: **RiverSwap** (1st, ETHGlobal NY 2026) — same `IProtocolFeeProvider` slot but the fee is set by an **auction winner**; and **`progressiveFeeIn` (opcode 37, `FeeExperimental.sol`)** — prices *trade size* against the inbound reserve, not cumulative consumption, and is not wired into `AquaOpcodes` (unreachable from the Aqua router). Neither is a solvency check.

---

## 2. **Sluice** (`subvisual/sluice`)

- **Source (confirmed):** https://github.com/subvisual/sluice — description "A strategy composer for 1inch Aqua. ETHGlobal Lisbon 2026", created 2026-07-25.

**What it does (confirmed from README):** An Aqua strategy **composer/authoring** tool. You describe an objective in plain language ("earn fees on ETH/USDC"), commit a **budget of tokens you already hold**, and Sluice returns concrete, risk-rated strategies; one signature ships the approved ones. LLM composition runs in an Intel TDX enclave (0G) and returns **signed** recommendations; a **deterministic validator** re-composes if a recommendation exceeds budget or breaks safety rules, then a deterministic compiler emits real SwapVM bytecode (never model-authored code). Notably it shipped **"the first generic Aqua subgraph"** (The Graph, mainnet + Base) to feed maker-book context.

**What it does NOT do:** It operates **before a strategy exists** — safe authoring/deployment. It does not inspect already-deployed positions for solvency, computes no `min(wallet, allowance)/virtual` coverage ratio over the live population, and ships no on-chain enforcement instruction. Its budget check is a pre-ship input constraint, not a post-deployment audit.

**How Overdraft differs — the lifecycle line:** **Sluice = before creation; Overdraft = after deployment.** Sluice helps you *author* one safe strategy from a budget you hold; Overdraft *inspects what is already live on-chain* across all makers/chains and asks whether the quoted depth is actually backed — then enforces it. (Their generic Aqua subgraph is worth reusing as an indexing reference.)

---

## 3. HookRank & Uniswap/hooklist (adjacent, different protocol)

Both are **Uniswap v4 hook** tooling — **not** 1inch Aqua, and **not** solvency.
- **hooklist** (Uniswap Foundation): a curated **registry/directory** of v4 hooks. Static metadata (what a hook is/does), not runtime solvency. *Category confirmed as a registry; treat as one-line context.*
- **HookRank:** hook **analytics/leaderboard** — ranks v4 hooks by static/volume metrics (TVL, swaps). No notion of a maker's wallet-vs-commitment coverage.

**How Overdraft differs:** different protocol (Uniswap v4 hooks vs. 1inch Aqua/SwapVM) and different question — they catalogue/rank hooks by activity; Overdraft measures whether a maker's advertised depth is solvent and refuses quotes that aren't. *(Note: these two were not exhaustively re-verified today; they are cited as category context, not as Aqua competitors.)*

---

## 4. Blockaid / Blowfish (transaction simulation)

Blockaid and Blowfish are **transaction-simulation / wallet-security** vendors: before you sign, they simulate a single transaction and tell you the **balance/approval changes and whether it's malicious** ("what does this tx do to my balances / is this a scam"). They are point-in-time, per-transaction, wallet-side risk tools.

**How Overdraft differs:** Blockaid/Blowfish answer *"what will this one transaction do to me right now?"* — a single-tx forward simulation. Overdraft answers *"can this already-deployed position honour what it advertises over its lifetime?"* — a **standing, position-level solvency property** (`min(wallet, allowance)` vs. summed virtual depth) across every strategy a maker has shipped, on every chain, plus an on-chain instruction that keeps quotes inside that backing. Different subject (a lifetime position vs. one tx), different actor (protocol/market-maker infra vs. end-user wallet), different output (a coverage ratio + quote ceiling vs. a pre-sign risk verdict).

---

## Has anyone already built Overdraft?

### Search coverage (what I actually checked)
- **GitHub repo search** (via API, sorted by recency): `1inch aqua {solvency, coverage, dashboard, indexer, analytics, monitor, explorer, underfunded, subgraph}`, `SolvencyGuard`, `aqua maker wallet balance`, `arkiv aqua`, `aqua+coverage+ratio`, plus the registry address `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`. (GitHub **code** search for the address returned HTTP 401 — unauthenticated code search is blocked; repo search is unaffected.)
- **GitHub read of the primary targets' source** — Doca (`InventorySkewProvider.sol`, `DocaApp.sol`, `observe/decide`, `SwapVMHelpers.ts`, README), Sluice README, and every candidate surfaced by search.
- **Web/showcase:** ETHGlobal Lisbon 2026 showcase + The Graph's Lisbon-2026 winners writeup; general web search for a Dune coverage dashboard, an Aqua explorer, and Twitter/X mentions of an Aqua solvency/coverage tool.

### Candidates found and adjudicated
| Project | Source | What it is | Solvency/coverage of *deployed* positions? | On-chain refuse-to-quote? |
|---|---|---|---|---|
| **`marcos-golem/aqua-arkiv-indexer`** | https://github.com/marcos-golem/aqua-arkiv-indexer | Read layer indexing Aqua strategy events into Arkiv; computes per-maker `coverageRatio` + `/api/underfunded` | **YES — the diagnostic half** | **No** (explicitly "Out: SwapVM opcodes… any new on-chain contract") |
| **Doca** (`ottodevs/doca`) | https://github.com/ottodevs/doca | Budget layer: opcode-30 fee provider + off-chain re-ship | Partial — per-strategy budget, virtual-balances-only, no wallet/allowance | No (fee only; `IBudgetGuard` sketched but **not built**) |
| **Sluice** (`subvisual/sluice`) | https://github.com/subvisual/sluice | Strategy **composer** (before ship) | No (pre-ship budget input, not a live audit) | No |
| **Baywatch Radar** (`mcmoodoo/baywatch`) | https://github.com/mcmoodoo/baywatch | Self-defending MM that prices **toxic flow** via cross-AMM Graph data → SwapVM tolls | No (zero solvency/coverage/wallet content in README) | No (re-prices/tolls, doesn't refuse for backing) |
| **Aqua0 / AquaZero0** | https://ethglobal.com/showcase/aqua0-u2krx ; https://x.com/1inch/status/2082451623847010536 | **Cross-chain** Aqua AMM marketplace (Curve/UniV3 curves + LayerZero); 1inch-incubated | No | No |
| ArcBook, BookerBob | https://thegraph.com/blog/ethglobal-lisbon-2026-winners/ | Order-book pricing curves; address-history/toxic-flow risk | No | No |
| 1inch's own Aqua product | https://1inch.com/aqua | Liquidity **leaderboard**, position visualizations, provider profiles | No — activity/position viz, not backing-vs-commitment | No |
| CUM-Circuit (`JSeam2/CUM-Circuit`) | https://github.com/JSeam2/CUM-Circuit | Noir ZK private deposit/withdraw circuit | No (unrelated) | No |

### Verdict: **NO** (with one important near-miss)
No project ships **Overdraft as specified** — a cross-chain, cross-maker coverage ratio using **`min(wallet, allowance)`** over summed virtual depth, fork-verified, plus a SwapVM instruction that **refuses to quote** beyond backing. The closest is **`aqua-arkiv-indexer`**, which independently arrived at the same *diagnostic framing* ("a maker can look live everywhere and be unable to settle"; per-maker `coverageRatio`; `/api/underfunded`). **Name it first, and draw these lines:**
1. **Coverage formula:** it uses **wallet balance only**; Overdraft uses **`min(wallet_balance, aqua_allowance)`** — the allowance ceiling is a distinct, real way a promise goes unbacked that the indexer ignores.
2. **Diagnostic vs. fix:** it is an **off-chain read layer** and states outright it adds **no SwapVM opcode and no on-chain contract**. Overdraft's differentiator is the on-chain **SolvencyGuard** instruction that *enforces* the ceiling at quote time — the exact "not built" piece Doca also gestures at with `IBudgetGuard`.
3. **It admits it's broken at its own core job:** its `todo.md` (found 25 Jul 2026) says solvency is recomputed **only on Aqua events**, so a wallet drained by a plain ERC-20 `Transfer` — the precise "silent illiquidity" it exists to detect — is **currently missed**; it keeps vouching `underfunded: false` while the maker goes insolvent. Overdraft recomputes against live wallet+allowance and verifies on a fork.
4. **No fork verification, single-chain PoC:** it is a mainnet-only proof of concept with unverified historical replay; Overdraft is cross-chain and fork-verified.

**Confidence:** High that no full equivalent exists in public repos/showcases as of 2026-09-04. Caveats: GitHub *code* search (vs. repo search) was blocked unauthenticated, and X/Twitter is only searchable secondhand via web results — a stealth/private build can't be ruled out. Everything above is **confirmed from the source repo/code** except HookRank/hooklist (category context, secondhand) and any project marked as read from a showcase/blog.

---

## How Overdraft differs from all prior art (the sharpest paragraph)

Every adjacent project touches one edge of the same problem — Aqua lets one wallet back many strategies, so advertised depth can exceed real backing — but each stops short of Overdraft's specific claim. **Doca** raises a *fee* as a strategy's budget drains, priced from **virtual balances only**, and never refuses a quote; **Sluice** helps you *author* a safe strategy *before* you ship it from a budget you already hold; **Baywatch** re-prices *toxic flow*, not insolvency; **Aqua0** makes Aqua *cross-chain* but doesn't check backing; and **`aqua-arkiv-indexer`** computes the right-shaped *coverage ratio* but only as an **off-chain read layer**, using **wallet balance without the allowance ceiling**, on a single chain, and — per its own bug log — currently blind to the wallet-drain it exists to detect. **Overdraft is the only project that (a) computes coverage as `min(wallet_balance, aqua_allowance) / Σ(virtual_balances)` per maker across all chains — capturing both under-funding *and* under-approval; (b) verifies that solvency claim on a fork; and (c) enforces it on-chain with a custom SwapVM `SolvencyGuard` instruction that refuses to quote beyond real backing — a quote *ceiling*, the exact enforcement layer that Doca sketches as `IBudgetGuard` but leaves "not built."** It is the diagnostic *and* the fix, where prior art has one or the other, on one edge of the problem, on one chain.
