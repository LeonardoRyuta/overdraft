# @overdraft/coverage

The coverage engine — computes, per `(maker, token)`, how much of an Aqua position's
**quoted** (virtual) depth is actually **backed** on-chain:

```
coverage = min(wallet_balance, allowance→Aqua) / Σ virtual committed
phantom  = max(0, committed − backed)
```

## Architecture

- **Enumeration** is pluggable (`src/enumerate.js`):
  - `subgraph` — live Graph data (set `SUBGRAPH_URL`); the production source.
  - `blockscout` — keyless decoded logs; works today because public RPCs gate `eth_getLogs`.
- **State reads** (`src/reader.js`) are live `eth_call`s via viem: `rawBalances` for the
  committed virtual balance (source-of-truth, live) + ERC-20 `balanceOf`/`allowance`.
- **Math** (`src/coverage.js`) is pure and unit-tested against 1inch's own example
  (100k backing 300k → 33% coverage, 200k phantom).

## Run

```bash
npm install
npm test                       # pure-math self-test
npm run scan                   # live scan of Ethereum via Blockscout
node src/run.js --chain base --pages 10
SUBGRAPH_URL=<studio-url> node src/run.js --chain ethereum   # once the subgraph is live
```

## Notes / honest limits
- Coverage is per `(maker, token)` — wallet/allowance/commitments are all token-specific.
- A network-wide **USD** phantom figure needs a price source (not wired yet); per-token
  phantom is exact.
- Blockscout enumeration paginates recent history; the full-population headline number
  should come from the subgraph (complete from `startBlock`).
