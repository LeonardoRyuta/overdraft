# Finding — Ethereum Aqua coverage (full population)

**As of 2026-09-07, subgraph synced to block ~25,918,700.**

| metric | value |
|---|---|
| active positions (maker, token) | 1,485 |
| quoted depth | **$25,302,503** |
| backed depth | **$1,605,833** |
| aggregate coverage | **6.3%** |
| phantom depth (quoted − backed) | **$23,903,462** |
| under-backed positions | 1,046 |
| degenerate (committed > token supply, excluded) | 11 |

## How it's measured (reproducible)
1. **Enumerate** every active commitment from the live Studio subgraph (`indexer/subgraph`,
   deployed at `api.studio.thegraph.com/query/1724457/overdraft/...`). Not mocked; not local.
2. **Verify** each position's committed (event-reconstructed `Σ Pushed − Σ Pulled`) against
   on-chain `Aqua.rawBalances(maker, app, strategyHash, token)` — sampled top-15 active, **15/15
   exact match**. Docked positions (`tokensCount = 0xff`) are excluded via the subgraph `active` flag.
3. **Back** each `(maker, token)` with `min(balanceOf(maker), max(allowance→Aqua, allowance→router))`,
   read live on-chain. Reading both allowance targets avoids overstating phantom.
4. **Price** in USD via DefiLlama (keyless); unpriced tokens excluded from the USD headline.

Regenerate: `SUBGRAPH_URL=<studio-url> node packages/coverage/src/run.js --chain ethereum`.

## How to read it (honest interpretation)
6.3% coverage does **not** mean $24M of serious liquidity is at risk. Most under-backed positions
hold **zero** of the token they committed — e.g. the single largest commits **2,420 WETH + 4.44M
USDC**, approves Aqua at max, and holds **$0**. On a five-week-old, Merkl-incentive-seeded protocol,
the population is dominated by unfunded / test / abandoned positions. That is precisely the finding:
**Aqua's *advertised* depth is overwhelmingly phantom, and until Overdraft nobody was measuring it.**
The value of a coverage feed is separating the small backed core from the large phantom tail —
per maker, per token, live.

## vs the earlier sample
An initial Day-1/2 spike scanned only the ~30 most-recent commitments via Blockscout and saw ~97%
coverage — because recent activity happened to be well-funded. The full-population subgraph scan
above is the real picture; the sample was not representative.
