# CLAUDE.md — Overdraft

Agent handoff for this repo. Read this first, then the referenced docs. (Secrets and prize
strategy are **not** here — they live in gitignored local files; see "Local-only files".)

## What this is
Overdraft measures the gap between 1inch **Aqua**'s *quoted* (virtual-balance) liquidity and its
*actually-backed* liquidity, across chains — then verifies it on a fork and ships a custom **SwapVM
instruction (`SolvencyGuard`)** that makes a position refuse to quote beyond real backing. ETHGlobal
ETHOnline 2026 hackathon. Public repo, live site + subgraphs deployed.

Core measurement, per `(maker, token)`:
`coverage = min(walletBalance, allowance→Aqua) / Σ virtual_committed` ; `phantom = max(0, committed − backed)`.

## Repo map (polyglot monorepo)
- `packages/coverage/` — the coverage **engine** (Node ESM + viem). `src/run.js` (CLI/orchestrator),
  `src/coverage.js` (pure math + self-test), `src/enumerate.js` (subgraph / Blockscout v2 / legacy),
  `src/reader.js` (live eth_call reads), `src/pricing.js` (DefiLlama), `src/chains.js` (per-chain config).
- `indexer/subgraph/` — The Graph **subgraph** (AssemblyScript). One schema, per chain via `networks.json`
  (mainnet + base). Indexes Aqua `Shipped/Pushed/Pulled/Docked`.
- `indexer/substreams/` — Rust **Substreams** module; builds to `.spkg`; reaches Firehose-only chains.
- `contracts/` — Foundry. `src/SolvencyGuard.sol` + `src/OverdraftAquaSwapVMRouter.sol` (the custom
  instruction + modified router); `test/{SolvencyGuard,GuardedDemo,Probe}.t.sol` (fork tests).
  **swap-vm is a NOT-vendored dependency** (license-restricted) — see Setup.
- `packages/probe/` — the **Honesty Probe** (TS): quote-vs-swap on an anvil fork + phantom-fill.
- `apps/mcp/` — **MCP server** + `SKILL.md` over the subgraph (Graph AI track).
- `apps/web/` — the public **showcase site** (single `index.html`) incl. the live dashboard and an
  interactive guarded-swap demo. Reads `public/coverage-*.json`. Deploys to GitHub Pages.
- `spikes/` — throwaway exploration. Research/evidence: `RECON-*.md`, `PRIOR-ART.md`,
  `PROBE-RESULTS.md`, `GUARDED-DEMO.md`, `findings/`.

## Verified facts (numbers drift — re-run to refresh)
- Aqua registry (deterministic, all 16 chains): `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`
- SwapVM router (the Aqua "app" for SwapVM positions): `0x111111338c5091E8440b67B168bAe16a668AC0De`
- `rawBalances(maker, app, strategyHash, token) → (uint248 amount, uint8 tokensCount)`;
  tokensCount `0`=empty, `0xff`=docked, `1..0xfe`=live. Allowance is granted to the **Aqua** contract.
- strategyHash for SwapVM positions = `keccak256(abi.encode(Order{maker,traits,data}))`, app = router
  (NOT `keccak256(abi.encode(strategy))`). The `Shipped` event's `strategy` bytes **are** `abi.encode(Order)`.
- `SolvencyGuard` opcode = **`0x22`** (`router.solvencyGuardOpcode()`). `AquaOpcodes._opcodes()` shifts
  opcode bytes by −1 via an array trick (e.g. XYCSwap runs at byte `0x11`).
- Verified-counterparty is an **optional** per-order opcode, not a mandatory gate — fork swaps need at
  most `vm.prank` an allowed taker.
- Headline (Ethereum, full population, live subgraph): ~1,485 active positions, ~$25.3M quoted /
  ~$1.6M backed = **~6.3% coverage**, ~$23.9M phantom, ~1,046 under-backed, 11 degenerate. Base:
  ~134 positions, ~52% coverage. Every active position was cross-checked against on-chain `rawBalances`.

## Live endpoints
- Site: https://leonardoryuta.github.io/overdraft/ (Pages, auto-deploys from `apps/web` on push via
  `.github/workflows/pages.yml`).
- Subgraphs (Studio, dev query URL, no key needed, ~3k q/day):
  `https://api.studio.thegraph.com/query/1724457/overdraft/v0.0.1` (mainnet) and `.../overdraft-base/v0.0.1`.

## Setup / how to run each piece
- Engine: `cd packages/coverage && npm i && node src/run.js --chain ethereum` (`--deep` = more Blockscout
  pages; `SUBGRAPH_URL=<studio url>` = use Graph data; `--json` writes a snapshot). Math self-test: `node src/coverage.js --test`.
- Contracts: `cd contracts && forge install 1inch/swap-vm@v1.0.2 && (cd lib/swap-vm && npm i) && forge test -vv`.
  swap-vm license = `LicenseRef-Degensoft-SwapVM-1.1` (don't vendor/redistribute); forge-std IS vendored.
  Needs solc 0.8.30 + `via_ir` (first build is slow). Fork RPC in `foundry.toml`.
- Subgraph: `cd indexer/subgraph && npm i && npx graph codegen && npx graph build`. Deploy:
  `npx graph auth <STUDIO_KEY>` (key in `.env`, gitignored) then `npx graph deploy overdraft`
  (or `--network base` + `... overdraft-base`). Slugs must be created in the Studio dashboard first.
- Substreams: `cd indexer/substreams` → builds to `.spkg` (Rust GNU toolchain + `substreams` CLI;
  running live needs a Firehose endpoint + `SUBSTREAMS_API_TOKEN`).
- MCP: `cd apps/mcp && npm i && node src/server.js` (`SUBGRAPH_URL` to use Graph data). See its `SKILL.md`.
- Web: static; regenerate snapshots with the engine's `--json` into `apps/web/public/coverage-<chain>.json`.

## Gotchas (learned the hard way)
- **Public RPCs gate `eth_getLogs`** ("archive requires token") — enumerate via the subgraph or Blockscout,
  never raw getLogs. Reliable reads: `ethereum-rpc.publicnode.com` (CORS-OK), `eth.drpc.org`.
- **Base's `base.blockscout.com` v2 API 500s** → engine falls back to the legacy `/api` getLogs
  (`chains.js` `logsApi:"legacy"`, decodes non-indexed data manually).
- **Snapshots are point-in-time and go stale fast** — a maker at 119% coverage in a 4-day-old snapshot
  read 1.3% live (they drained backing). The web dashboard uses snapshots; the DEX demo reads backing LIVE.
- The `~6.3%` phantom figure is dominated by **unfunded/test positions** on a young, incentive-seeded
  protocol — frame it as a **monitoring/configuration gap, not "Aqua is broken"** (Aqua has 8 audits).

## Status
Done: coverage engine + headline; ETH + Base subgraphs live; Substreams `.spkg`; SolvencyGuard (compiles
+ 4 fork tests + before/after demo); Honesty Probe (real phantom-fill); MCP + SKILL; public multi-chain
showcase with an interactive guarded-swap demo. Remaining (mostly user-driven): record the 4-min demo
video; submit to each track; (Uniswap Stack Contribution is a weak fit — see the local plan). **Deadline:
Sun Sept 13 2026, 12:00 EDT.**

## Conventions / local-only files
- Commits: **no `Co-Authored-By: Claude` trailer** (deliberate — history was rewritten to remove it).
  Commit as `LeonardoRyuta`. Small, honest, frequent commits.
- Gitignored, local to the build machine (not on GitHub): `ethonline-2026-plan.md` (strategy source of
  truth), `docs/{PRIZE-TRACKS,DAY1-ASSESSMENT,VIDEO-SCRIPT,SUBMISSION,WEB-BRIEF}.md`,
  `indexer/subgraph/.env` (Studio deploy key), `contracts/lib/swap-vm/`, all `node_modules/`.
- Never fabricate a number — every figure is read from live chain state and cross-checked. Never mock
  The Graph data (local/mocked datasets are a disqualifier); query the live Studio subgraph.
