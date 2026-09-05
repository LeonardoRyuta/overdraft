# RECON — Browser (Day 2)

**Prepared:** 2026-09-05 · Agent G · ETHOnline 2026 hackathon
**Method:** WebFetch (public URLs, no auth) + WebSearch. Every claim is cited. UNKNOWN is marked where auth blocked me or a source was missing.

---

## Q1 — Submission deadline (recheck): Sept 13 or Sept 16?

**VERDICT: CONFIRMED — Sunday, September 13th 2026 at 12:00 pm EDT.** Not Sept 16. (Sept 16 is the outer bound of the hacking *window* / event span, but the hard submission cutoff is Sept 13 noon EDT.)

Verbatim, from the official ETHGlobal event details page (fetched twice, consistent):

> "All projects must be submitted by **Sunday, September 13th 2026** at **12:00 pm EDT**."

- Source (primary): https://ethglobal.com/events/ethonline2026/info/details

**Does judging run after the deadline? YES — CONFIRMED.** ETHGlobal async events use two rounds *after* submission:

> "For most async events, there are two rounds of judging. The first round is asynchronous, and the second round is live judging at the event. The judging criteria for both rounds is the same and the first round of async judging is used to screen projects." — "Typically, only the top 20% of projects advance to the live judging session."

Also confirmed from the details page:
- Two submission modes: "Finalist and Partner Prizes" (requires live presentation) vs "Partner Prizes Only" (async review only).
- Live finalists get 7 minutes: "4 minutes for the demo, followed by 3 minutes for Q&A."
- **"the majority of prizes are paid out to projects that do not advance to the live judging"** and **"partners do not have access to the results of the first round of judging"** — i.e., partner prizes (1inch, The Graph) are judged independently of the finalist screening. Good news: you do not need to reach the top-20% finalist round to win the 1inch/Graph bounties.
- Sources: https://ethglobal.com/events/ethonline2026/info/details ; corroborated by the shared ETHGlobal async-event judging text surfaced across event pages (e.g. https://ethglobal.com/events/ethonline2025/info/details).

**Note on exact judging dates:** the specific dates/times of the async and live rounds are **not published** on the details page (UNKNOWN — confirm in Discord if it matters). What *is* confirmed: judging happens after the Sept 13 12:00 pm EDT cutoff.

**Implication for the plan:** the internal execution plan (`ethonline-2026-plan.md`) still lists "Sept 16 — Ship" and treats Sept 16 as the deadline in several places (Days 9–10 = "Sept 12–13", Day 13 = "Sept 16"). **That is wrong — the real cut is Sept 13 12:00 pm EDT.** The build calendar needs to compress by ~3 days; treat Sept 13 morning as the ship-and-freeze point.

---

## Q2 — Public 1inch Aqua / SwapVM ORDERS API (high value)

**VERDICT: PARTIAL. There is a public, unauthenticated Aqua *analytics* surface that can list open strategies, but NO documented public endpoint that returns the full Order object / SwapVM program.** For the full program you still parse on-chain `Shipped` events (or index them yourself). Details below.

### What IS public (unauthenticated)

**1inch MCP Server — `aqua` tool.** 1inch ships an MCP server at `https://api.1inch.com/mcp/protocol` whose `aqua` tool is explicitly **public / no auth required**. Documented operations:
- `list_opened` (list currently-open Aqua strategies), `maker_stats`, `strategy_overview`, `strategy_activity`, `strategy_volume`.
- Described as "read-only 1inch Aqua strategy analytics: maker stats, strategy lists, overview, activity, volume."
- Auth: "Aqua strategy analytics ... work without authentication." (Other MCP tools — swaps, Business APIs — need an API key/OAuth.)
- Sources: https://business.1inch.com/portal/documentation/ai-integration/mcp-server ; https://business.1inch.com/portal/documentation/ai-integration/overview

**A "read-only REST API for protocol analytics."** 1inch's own messaging lists three Aqua build surfaces: *"a read-only REST API for protocol analytics, the TypeScript SDK for on-chain operations, and an aqua tool on the 1inch MCP Server."* This implies the MCP `aqua` tool is backed by a REST analytics API — but **the concrete REST base URL / route for that analytics API is NOT published on any public doc page I could reach** (UNKNOWN — the MCP host is `api.1inch.com/mcp/protocol`; the standalone REST route is undisclosed). Source: search-surfaced 1inch messaging (https://business.1inch.com/whats-new and the "What's New" surface); treat the REST route as unconfirmed until you sniff it from the MCP tool or ask 1inch.

### What is NOT public (the gap for our use case)

- **No documented endpoint returns the full `Order` / `program` bytes.** Both official SDK READMEs are explicit that the *strategy/program* is obtained off-chain by parsing events, with only a vague "or from api" aside and no endpoint named:
  - `@1inch/swap-vm-sdk` README swap example: `const encodedOrder = '0x...' // fetched from ship event or from api`, and the `quote` param doc: `order — The maker's order (fetched from ship event or from api)`.
  - `@1inch/aqua-sdk` README swap/dock examples: `const strategy = '0x' // parsed from ship events or fetched from api`.
  - The "api" referenced here is never given a URL. The *reliable, documented* path is event parsing.
  - Source (local, from installed packages): `C:\Users\leona\Documents\overdraft\spikes\sdk\node_modules\@1inch\swap-vm-sdk\README.md`, `...\@1inch\aqua-sdk\README.md`.
- **The 1inch Developer Portal's ~13 REST APIs do NOT include an Aqua orders API.** Documented list = Swap, Orderbook, Spot Price, Token, Token Details, Charts, Balance, Portfolio, Transaction Gateway, History, Traces, Gas Price, Web3 RPC, NFT, Domains — all under `https://api.1inch.dev/...` and **all require an API key**. None is Aqua/SwapVM orders. (The "Orderbook API" is the classic Limit Order Protocol, not Aqua.) Sources: https://business.1inch.com/portal/documentation ; https://medium.com/1inch-network/new-apis-added-to-the-1inch-developer-portal-b3f596ce9714
- **No public Aqua subgraph from 1inch.** A search claim that "1inch exposes on-chain DeFi data through multiple subgraphs" could not be verified for Aqua specifically; I found no official 1inch Aqua subgraph on The Graph. (Prior art note: the closest generic Aqua subgraph is community-built — Sluice claimed "the first generic Aqua subgraph," per PRIOR-ART.md.) Status: UNKNOWN/none-found for an *official* 1inch Aqua subgraph.

### Practical takeaway for Overdraft

The `aqua` MCP tool's `list_opened` is a **fast, free, keyless way to enumerate open strategies/makers** for discovery (and cross-check our own index) — but to build real quote/swap calldata you need the **full `Order` (maker + program + traits)**, which the analytics surface is not documented to return. So the canonical path remains: enumerate `Shipped` events on-chain (via `@1inch/aqua-sdk` `ShippedEvent` / `@1inch/swap-vm-sdk`) → reconstruct the `Order` → `Order.parse(...)` → build `quote`/`swap` calldata. That is exactly the design the plan already assumes; **no public API shortcuts the "full program" step.** Consider using the MCP `aqua` tool as a *seed list* and a sanity check against our index.

---

## Q3 — The Graph Subgraph Studio deploy + live query on the free plan

**VERDICT: CONFIRMED — a Studio-deployed Ethereum-mainnet subgraph CAN be queried live on the free plan (via the development query URL), without publishing to the decentralized network. It qualifies as "live Graph data" for the hackathon.** Watch two limits.

### Deploy flow (verbatim)
1. `graph auth <DEPLOY KEY>` — authenticate the CLI with the deploy key from your Subgraph's details page in Studio.
2. `graph deploy <SUBGRAPH_SLUG>` — pushes to Studio; you'll be prompted for a version label.
- Source: https://thegraph.com/docs/en/subgraphs/developing/deploying/using-subgraph-studio/ (redirects to `.../deploying-publishing/using-subgraph-studio/`) ; corroborated https://github.com/graphprotocol/docs/blob/main/website/src/pages/en/subgraphs/developing/deploying/using-subgraph-studio.mdx

### Live query WITHOUT publishing — YES
- The docs state you can "test your Subgraph in the playground" and **"Integrate your Subgraph in staging using the development query URL."** So deploying to Studio gives you a live, queryable **development query URL** immediately — no decentralized-network publish needed.
- **You need an API key to query** (the Studio-issued key). This is expected and free.
- Source: https://thegraph.com/docs/en/subgraphs/developing/deploying/using-subgraph-studio/

### Free-tier limits / gotchas (the ones that matter)
- **Development query URL is limited to 3,000 queries/day.** This is the endpoint you get pre-publish. Fine for a demo/frontend, but do NOT hammer it in a loop.
- **Free Plan overall = 100,000 queries/month** with full access to the Studio testing environment; beyond that you're billed in GRT. Source: https://thegraph.com/docs/en/subgraphs/providers/subgraph-studio/introduction/
- **Max 3 unpublished subgraphs per account** before you must archive or publish. Keep the slug count low.
- Ethereum mainnet is explicitly a supported network (Subgraphs + Firehose/Substreams). Source: https://thegraph.com/docs/en/supported-networks/

**Gotcha to flag for the team:** the free/dev endpoint (3k/day) is enough to *demo* live Graph data and satisfy The Graph's "no mocked/local data" rule, but it is a low ceiling. If the frontend leaderboard polls aggressively you can blow through 3,000/day fast. Either (a) publish to the decentralized network for a higher-throughput query URL under the 100k/mo free allotment, or (b) cache/materialize results server-side and rate-limit the browser. Decide before demo day. (Whether the *published* query URL also draws from the same 100k free bucket vs. requiring GRT for mainnet queries beyond free tier — treat as a soft UNKNOWN; the 100k/mo free figure is the operative number.)

---

## Q4 — 1inch "Build an Aqua App" prize: on-chain execution wording

**VERDICT: CONFIRMED — a LOCAL FORK transaction SATISFIES the requirement. No public testnet/mainnet tx is required.**

Verbatim qualification requirements from the ETHGlobal prize page:
1. **"Official Aqua/SwapVM contracts must be used (redeployments of a modified SwapVM contract is allowed)"**
2. **"Onchain execution of token transfers should be presented during the final demo (local forks are ok)"**
3. **"Proper Git commit history (no single-commit entries on the final day)"**

Prize: **💧 Build an Aqua App — $5,000** (1st $2,500 / 2nd $1,500 / 3rd $1,000). Task: *"Create a custom Aqua app that implements a sophisticated DeFi position. If you use SwapVM, you may modify SwapVM opcodes and define your own instructions."* Projects that **use SwapVM are scored higher**. There is also a separate **$2,000 Continuity pool** (1st $1,500 / 2nd $500) for teams extending existing projects — note this if you're worried about the "must be new" framing, though Overdraft is Start-Fresh.

- Source: https://ethglobal.com/events/ethonline2026/prizes

**Read on "(local forks are ok)":** the parenthetical explicitly blesses fork execution — so the plan's approach (Foundry fork, impersonate a verified counterparty, execute the token transfer against the guarded/unguarded position) meets the letter of the requirement. The two things you MUST still show: (a) real *onchain execution of token transfers* in the demo (a fork tx counts, but it must be an actual executed transfer with visible balance movement — not a dry-run/quote), and (b) official Aqua/SwapVM contracts (redeployed modified SwapVM is fine). No linked external "1inch hackathon guidance" doc beyond the prize page itself was found (UNKNOWN if a separate 1inch guide exists; the prize page is authoritative).

---

## Q5 — Anything new for Aqua in the last week (quick sweep)

**VERDICT: One item Agent D's PRIOR-ART.md does not surface as an existing tool — the 1inch `aqua` MCP tool's `list_opened` / analytics (a first-party "list open strategies" surface).** No new third-party explorer/indexer/orders tool found in the last week.

- **1inch first-party `aqua` MCP tool (public, keyless).** `list_opened`, `maker_stats`, `strategy_overview`, `strategy_activity`, `strategy_volume` at `https://api.1inch.com/mcp/protocol`. This is a *first-party* "list open strategies + per-strategy volume/activity" analytics surface. PRIOR-ART.md notes 1inch's own Aqua product has a liquidity leaderboard / position viz, but does not call out this **queryable, unauthenticated MCP/analytics** path. Relevance: it partially overlaps our "discovery/leaderboard" framing (1inch already exposes maker stats + strategy lists), so lean the pitch harder on the parts 1inch does NOT do — `min(wallet, allowance)` coverage, fork verification, and the on-chain SolvencyGuard. Sources: https://business.1inch.com/portal/documentation/ai-integration/mcp-server ; https://business.1inch.com/portal/documentation/ai-integration/overview
- **1inch Observability dashboard** — charts on-chain Aqua swap volume down to minute buckets, refreshed ~every 3h, shows max/avg RPS. This is 1inch-internal ops telemetry (traffic/volume), **not** solvency/coverage. Category context only; not a competitor. Source: https://business.1inch.com/whats-new
- **Aqua full frontend** — messaging says the full front-end / public interface lands "early 2026 / Q1 2026." As of now it's position viz + a liquidity leaderboard, per PRIOR-ART.md — still no coverage/solvency number. Sources: search-surfaced 1inch messaging (https://business.1inch.com/whats-new).
- **No new competitor found.** No new third-party Aqua explorer, indexer, orders API, or solvency/coverage tool surfaced in the last week beyond the projects already adjudicated in PRIOR-ART.md (Doca, Sluice, Baywatch, Aqua0, aqua-arkiv-indexer). Caveat: web search cannot see private repos or unindexed X posts (same caveat Agent D noted).

---

## Confidence & caveats
- Q1 (deadline), Q3 (Studio live query), Q4 (fork OK) — **high confidence**, first-party sources, quoted verbatim.
- Q2 — **high confidence there is no public API returning full Order/program**; the `aqua` MCP analytics surface is real and keyless, but its exact REST route and whether it can emit full programs is UNKNOWN (undisclosed on public docs). Verify by calling the MCP `aqua` tool directly during the spike.
- Q5 — sweep only; private/stealth builds and unindexed social cannot be ruled out.
- Auth-blocked / not-reachable: none returned 403/500 to the fetch tool this session; the only gaps are *undisclosed* endpoints (Aqua REST analytics base URL), marked UNKNOWN above.
