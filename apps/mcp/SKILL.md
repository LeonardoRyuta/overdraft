---
name: aqua-coverage
description: >-
  Interrogate 1inch Aqua liquidity coverage in natural language — which makers are
  over-committed, how much quoted depth is phantom, and which positions advertise more
  than exists. Use when asked about Aqua solvency, coverage, phantom depth, or
  over-committed makers on Ethereum / Base / Arbitrum.
---

# Aqua Coverage (Overdraft MCP)

Reusable infrastructure: an MCP server that answers questions about **1inch Aqua
liquidity coverage** — the gap between *quoted* (virtual-balance) depth and *actually
backed* depth (`min(wallet, allowance→Aqua)`) — across every live position on a chain.

Enumeration is load-bearing on **The Graph**: when `SUBGRAPH_URL` points at the Overdraft
subgraph, positions are read from live Graph data; otherwise it falls back to a keyless
Blockscout read for local development. The backed side is always read live on-chain.

## When to use
- "Which makers are most over-committed on Base?"
- "What is total phantom depth on Ethereum right now?"
- "Does maker 0x… have enough backing for what it quotes?"
- "Are any Aqua positions advertising more than the token's supply?"

## Tools
- `aqua_coverage_summary(chain)` — network totals: quoted vs backed (USD), aggregate
  coverage, phantom depth, counts of under-backed and degenerate positions.
- `aqua_most_overcommitted(chain, limit)` — worst-coverage positions, ascending.
- `aqua_degenerate_positions(chain)` — positions whose virtual balance exceeds token supply.
- `aqua_maker_coverage(chain, maker)` — per-token coverage for one maker.

`chain` ∈ `ethereum | base | arbitrum` (default `ethereum`).

## Setup
```bash
cd apps/mcp && npm install
# optional but recommended — use live Graph data instead of the Blockscout fallback:
export SUBGRAPH_URL="https://api.studio.thegraph.com/query/<id>/overdraft-aqua/<version>"
node src/server.js          # stdio MCP server
```

Register with any MCP client (Claude Desktop / Code, etc.) as a stdio server running
`node apps/mcp/src/server.js`. Every figure is read live — nothing is mocked.
