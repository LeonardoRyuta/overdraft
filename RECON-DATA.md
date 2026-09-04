# RECON-DATA — Live Aqua Activity Measurement

**Agent C · Overdraft (ETHOnline 2026)**
**Snapshot time:** 2026-09-04, ~16:30–17:15 UTC
**As-of blocks (headline caveat):** Ethereum block **25,905,217**; Base block **50,875,242**. All counts below are as of these heights. Fast chains (Arbitrum, BNB, etc.) advance thousands of blocks per minute — treat their "recent-window" numbers as a same-day snapshot, not a fixed height.

---

## TL;DR headline numbers

- **Registry is deployed on all 16 claimed chains** (verified by `eth_getCode`, identical bytecode everywhere — same 11,238-hex-char runtime, same prefix `0x60806040526004361015...`). Verified as a named, source-verified contract **"AquaRouter"** on Etherscan and Basescan.
- **Only ONE chain has meaningful live activity: Ethereum.** Every other chain is between "a few positions" and "essentially dormant."
- **Base — the only chain I could scan end-to-end over public RPC — has ≈127 net live positions** (432 `Shipped` − 305 `Docked`, full-history scan, 0 errors).
- **Ethereum live population is UNKNOWN** (public RPCs are non-archive / API-key-gated). What IS measured: Ethereum is high-churn and live *right now* (441 `Shipped` / 544 `Docked` over the last ~6.3 days; last tx ~10 min before snapshot). Net flow was **negative** in that window → the population is NOT simply growing; it's a churny, roughly steady-state set driven by a few automated makers.
- **Total quoted depth (sum of virtual balances): UNKNOWN.** Not derivable from event logs or public RPC alone (balances live in a non-enumerable mapping `balances[maker][app][strategyHash][token]`). One sampled live Base position held ~1,732 BNKR (a low-cap token) — i.e., individual positions are small (hundreds–low-thousands of dollars order of magnitude), not whales.

---

## How the protocol works (so the counts are interpretable)

Source: `github.com/1inch/aqua` (`src/Aqua.sol`, `src/interfaces/IAqua.sol`, README).

The registry (`Aqua.sol`, aka "AquaRouter") emits exactly four events. **None of their parameters are `indexed`**, so `topic0` is a plain keccak of the signature and all data sits in the log data field. Computed and on-chain-verified topic0 hashes:

| Event | Signature | topic0 | Meaning |
|---|---|---|---|
| **Shipped** | `Shipped(address,address,bytes32,bytes)` | `0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0` | **Position/strategy CREATED** |
| **Docked** | `Docked(address,address,bytes32)` | `0xd173a1d140c154eb1ce9298d251d5eb8c4089cc2d16e70f1067bdc810c6fe004` | **Position CLOSED** |
| Pushed | `Pushed(address,address,bytes32,address,uint256)` | `0x3f18354abbd5306dd1665c2c90f614a4559e39dd620d04fbe5458e613b6588f3` | Virtual balance added |
| Pulled | `Pulled(address,address,bytes32,address,uint256)` | `0x3ad61047071575417c75e3311e5d46ff042e292b5dd8769ff18b4b254098ca7a` | Virtual balance removed (during a fill) |

(Pushed/Pulled topic0 were confirmed against real on-chain logs; `event=`-name lookups via api.openchain.xyz decoded them to `Pushed`/`Pulled`, cross-validating the keccak implementation.)

**Live positions ≈ (# Shipped) − (# Docked).** A strategy is immutable once shipped; `dock()` removes it. Positions are re-shipped frequently by automated makers → high `Shipped` churn, so raw `Shipped` count massively overstates the live set. Total tx count (below) also overstates it (mixes ship/dock/multicall/fills).

---

## Per-chain table

Legend for "how derived":
- **FULL RPC** = complete `eth_getLogs` sweep from deploy→head in 10k-block chunks against a full-history public RPC (high confidence).
- **EXPLORER TX** = total transaction count from the block explorer page (indexes full history; but counts ALL tx types, not positions — upper bound / activity proxy only).
- **RECENT RPC** = short recent-window `eth_getLogs` (public node retention only — a live-pulse signal, NOT a total).
- **PRUNED** = public RPC is non-archive/API-key-gated; full history not obtainable without a key or archive node.

| Chain | ChainID | Registry deployed? | Live positions (Shipped−Docked) — how derived + uncertainty | Notes / activity signal |
|---|---|---|---|---|
| **Ethereum** | 1 (0x1) | ✅ getCode non-empty; Etherscan "AquaRouter", verified | **UNKNOWN total** (RPCs archive-gated). Live pulse: **441 Shipped / 544 Docked over last ~6.3 days** (blocks 25,859,624–25,905,223, RECENT RPC via flashbots+mevblocker, cross-validated). Net **−103** in window. | **151,042 total txns** (Etherscan). By far the most active chain. Last tx ~10 min before snapshot → **live now**. High churn = a handful of bots re-shipping. |
| **Base** | 8453 (0x2105) | ✅ Basescan "AquaRouter", verified | **≈127 live** = 432 Shipped − 305 Docked. **FULL RPC** sweep deploy(48,839,900)→head, 204 chunks, **0 errors**. High confidence. | 455 total txns (Basescan). Deployed 2026-07-19. Sampled position: ~1,732 BNKR pushed. |
| **Arbitrum One** | 42161 (0xa4b1) | ✅ getCode non-empty | **UNKNOWN** (arb1 RPC prunes history; 0 events in last 10k blocks = quiet now). | 181 total txns (Arbiscan). Last tx 2026-09-01. Low. |
| **Optimism** | 10 (0xa) | ✅ Optimistic Etherscan "AquaRouter" | **UNKNOWN** (RPC pruned). Very low. | **26 total txns.** Last tx 2026-09-04 (live-ish, trivial volume). |
| **Polygon** | 137 (0x89) | ✅ Polygonscan "AquaRouter" | **UNKNOWN** (RPC pruned; 0 in last 10k). | 450 total txns. Last tx 2026-08-29. |
| **BNB Chain** | 56 (0x38) | ✅ getCode non-empty | **UNKNOWN** (all public BSC RPCs non-archive). 0 in last 10k blocks. | Merkl-targeted chain, yet no live churn observed at snapshot. bscscan blocked to WebFetch. |
| **Unichain** | 130 (0x82) | ✅ Uniscan "AquaRouter" | **≈ single digits** (EXPLORER TX). | **14 total txns.** Last tx **2026-08-17** (18 days stale) → effectively dormant. |
| **Avalanche C** | 43114 (0xa86a) | ✅ Snowscan "AquaRouter" | **≈ 0–2** (EXPLORER TX). | **4 total txns.** Last tx 2026-08-24. Dormant. |
| **Gnosis** | 100 (0x64) | ✅ getCode non-empty | **UNKNOWN** (RPC pruned to ~132 blocks). | Explorer is Blockscout (Cloudflare-blocked to WebFetch). Likely near-zero by analogy. |
| **Linea** | 59144 (0xe708) | ✅ Lineascan "AquaRouter" | **≈ 0–2** (EXPLORER TX). | **4 total txns.** Last tx 2026-08-21. Dormant. |
| **zkSync Era** | 324 (0x144) | ✅ getCode non-empty | **UNKNOWN** (RPC pruned). | Non-standard VM; deterministic-address deploy still present. |
| **Sonic** | 146 (0x92) | ✅ Sonicscan "AquaRouter" | **≈ 0–2** (EXPLORER TX). | **6 total txns.** Last tx 2026-08-12. Dormant. |
| **Cronos** | 25 (0x19) | ✅ getCode non-empty | **UNKNOWN** (RPC pruned to ~88 blocks). | No The-Graph support (see matrix). |
| **Monad** | 143 (0x8f) | ✅ getCode non-empty | **UNKNOWN** (RPC rejected all getLogs — 80/80 chunks errored). | New chain. Count not obtainable via this RPC. |
| **HyperEVM** | 999 (0x3e7) | ✅ getCode non-empty | **UNKNOWN** (RPC returns code at all heights; can't bound deploy; 45M-block span too large to sweep). | — |
| **Robinhood Chain** | 4663 (0x1237) | ✅ getCode non-empty (block ~54.4M) | **UNKNOWN** (Blockscout behind Cloudflare; RPC 0 in last 10k blocks). | RWA L2 (Arbitrum tech), launched 2026-07-01. Merkl-targeted chain. RPC: `https://rpc.mainnet.chain.robinhood.com`. |

**Deployment confidence:** 16/16 registry deployments are directly RPC-verified. All returned byte-identical runtime code (deterministic CREATE2 / same-address deploy), and 9 are additionally confirmed as source-verified "AquaRouter" on their Etherscan-family explorers.

---

## The Graph coverage matrix (for our 16 target chains)

Source: The Graph Networks Registry JSON (`raw.githubusercontent.com/graphprotocol/networks-registry/main/public/TheGraphNetworksRegistry.json`, parsed directly).

| Chain | In registry | Subgraphs | Substreams | Firehose | Indexing implication |
|---|---|---|---|---|---|
| Ethereum (`mainnet`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Base (`base`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Arbitrum (`arbitrum-one`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Unichain (`unichain`) | ✅ | ✅ | ✅ | ✅ | Full support |
| BNB (`bsc`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Optimism (`optimism`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Polygon (`matic`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Avalanche (`avalanche`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Gnosis (`gnosis`) | ✅ | ✅ | ❌ | ❌ | **Subgraphs only** |
| zkSync Era (`zksync-era`) | ✅ | ✅ | ❌ | ❌ | **Subgraphs only** |
| Linea (`linea`) | ✅ | ✅ | ✅ | ✅ | Full support |
| Sonic (`sonic`) | ✅ | ✅ | ❌ | ❌ | **Subgraphs only** |
| **Cronos** (`cronos`) | ✅ present | ❌ | ❌ | ❌ | **NO services at all — indexing gap** |
| **Monad** (`monad`) | ✅ | ❌ | ✅ | ✅ | **NO subgraphs** (Substreams/Firehose only) |
| **HyperEVM** (`hyper-evm`) | ✅ | ❌ | ✅ | ✅ | **NO subgraphs** (Substreams/Firehose only) |
| **Robinhood** (`robinhood`) | ✅ | ❌ | ✅ | ✅ | **NO subgraphs** (Substreams/Firehose only) |

**Gaps that constrain any "we index the whole ecosystem via subgraphs" claim:**
- **Cronos:** no Graph services whatsoever.
- **Robinhood Chain, Monad, HyperEVM:** Substreams/Firehose exist but **NO Subgraph Studio support**. A subgraph-only indexing stack cannot cover them; you'd need a Substreams-based pipeline (or direct RPC) for these three — and Robinhood is one of the Merkl-incentivized chains.
- Gnosis / zkSync / Sonic: subgraphs work but no Substreams (fine for a subgraph approach; limits Substreams-only designs).

Net: **12 of 16 chains have subgraph support; 4 do not.** Substreams reaches 12 of 16 as well (missing Gnosis, zkSync, Sonic, Cronos). **No single Graph product covers all 16.**

---

## Merkl incentive program — status: LIVE (month 2 of 3)

Sources: blog.merkl.xyz (1inch Aqua launch post), 1inch.com/blog incentive post, The Defiant, TradingView/CoinMarketCal (28 Jul 2026).

- **Size:** 10M 1INCH (5M direct volume rewards + 5M partner co-incentives) **+ 500k USDC** DAO boost. Some sources total it as "10.5M 1INCH + 500k USDC."
- **Structure:** 3-month campaign, front-loaded **50% / 30% / 20%** across months 1/2/3. 80+ 1INCH-paired markets. Distributed via **Merkl**; program operator Degensoft Ltd. No sign-up — fills in eligible markets auto-qualify.
- **Chains:** launch/priority chains named as **Ethereum, BNB Chain, Robinhood Chain** (BNB = first co-incentive partner).
- **Timing:** announced 2026-07-28; ~3-month run ⇒ **active as of 2026-09-04 (month 2).** It should be seeding new positions right now — consistent with Ethereum's live churn, and a reason the population may grow (or at least stay churny) through ~late October 2026.

---

## Quoted depth (sum of virtual balances) — UNKNOWN

Not derivable today from logs/public RPC:
- Balances live in `balances[maker][app][strategyHash][token]` — a **non-enumerable mapping**. There's no on-chain "list all positions" or "total depth" call.
- `Pushed`/`Pulled` events give per-event deltas, but reconstructing net current depth per (maker, strategy, token) requires replaying **all** Pushed/Pulled from deploy on every chain — which needs archive access we don't have for 15 of 16 chains.

**Concrete scale sample (one live Base position):** a `Pushed` of `0x5deda4a8b27fa44567` = **1,732.67 BNKR** (token `0x22af…6f3b`, 18 decimals, symbol "BNKR"). BNKR is a low-cap token → this position is order-of-magnitude hundreds-to-low-thousands of USD, **not** institutional size. Suggests total depth is modest, but a real total is **UNKNOWN**.

**To get a real quoted-depth number we need:** Agent A's read-path (a getter/multicall that reads `balances[...]` for a set of live (maker, strategy, token) tuples) + Agent B's SDK to enumerate live positions from `Shipped`−`Docked`, then batch-read balances and price them. Alternatively, an Etherscan-family API key (to pull full `Pushed`/`Pulled` history per chain) or an archive RPC.

---

## Method limitations / caveats (so nobody over-trusts a number)

1. **No block-explorer API key and no archive RPC.** Etherscan V2 API returned `Missing/Invalid API Key`; publicnode/most public RPCs reject historical `eth_getLogs`/`eth_getCode` as "archive requests." This is why only **Base** has a full-history position count. Everything else is either explorer-tx-count (upper bound) or a recent-window pulse.
2. **Public RPC nodes disagree on head/return stale data** — observed height mismatches between endpoints. Base numbers used `mainnet.base.org` (full history) exclusively for the sweep.
3. **Explorer "total transactions" ≠ positions.** It mixes ship/dock/push/pull/multicall/fills. On Base, 455 txns → only 127 net live positions (≈3.6 txns per net position). Do not treat 151,042 ETH txns as 151,042 positions.
4. Counts labeled UNKNOWN are genuinely not measured — not zero. (Notably Monad, where the RPC errored on every chunk.)

---

## BOTTOM-LINE VERDICT

**Lean HARD on "we built the tool the ecosystem needs" — NOT "we audited a giant live ecosystem."**

The live population is **small and concentrated**:
- **15 of 16 chains are between "a handful of positions" and dormant** (single-digit to low-hundreds of total txns; several with last activity weeks ago).
- The only chain with real, live, high-frequency activity is **Ethereum** — and even there it's **churn from a few automated makers**, not thousands of distinct LPs (net position flow was *negative* over the last 6 days).
- **Base, the one chain we counted precisely, has ~127 live positions.** A whole-ecosystem live population plausibly numbers in the **low hundreds to perhaps low thousands**, dominated by Ethereum — but the ecosystem-wide total is **UNKNOWN** and provably NOT "massive."
- Individual positions are **small** (sampled ~1.7k low-cap tokens), and total quoted depth is **UNKNOWN**.

This is *good* for the pivot: a sparse, brand-new (deployed 2026-07-19), Merkl-incentivized-but-still-thin ecosystem with **fragmented indexing support** (4 chains lack subgraphs; Cronos has nothing) is exactly the setting where a purpose-built tool that can *find, count, and value every live position across all 16 chains* — including the Substreams-only RWA chains The Graph's subgraph product can't touch — is the compelling story. "We scanned the whole ecosystem" is technically true but unimpressive because the ecosystem is tiny; "we're the missing measurement/indexing layer this fragmented, incentive-pumped protocol needs" is the strong narrative.

---

### Evidence appendix (key raw calls)

- `eth_getCode` at `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` returned identical 11,238-hex runtime on all 16 chains via public RPCs (chainIds 0x1,0x2105,0xa4b1,0xa,0x89,0x38,0xa86a,0x64,0x82,0xe708,0x144,0x92,0x19,0x8f,0x3e7,0x1237).
- Etherscan `…/address/0x1111113ccf…`: "AquaRouter", verified, 151,042 txns, live to 2026-09-04 16:28 UTC.
- Basescan same address: "AquaRouter", verified, 455 txns, created 47 days ago.
- Base full sweep: `eth_getLogs`(address=registry, topics=[[Shipped,Docked]], deploy→head, 10k chunks) ⇒ Shipped=432, Docked=305, 204 chunks, 0 errors.
- Ethereum 6.3-day window: `eth_getLogs` via `rpc.flashbots.net` / `rpc.mevblocker.io` (agreeing) ⇒ Shipped=441, Docked=544 over blocks 25,859,624–25,905,223.
- topic0 hashes computed with a from-scratch keccak-256 (validated: Pushed/Pulled hashes matched live on-chain logs and api.openchain.xyz name-lookups).
- The Graph coverage parsed from the official networks-registry JSON.
- Merkl: blog.merkl.xyz + 1inch.com/blog + The Defiant.
