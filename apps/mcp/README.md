# @overdraft/mcp

An MCP server that lets any agent query **1inch Aqua liquidity coverage** in natural
language. The Graph is the load-bearing data source (Overdraft subgraph via `SUBGRAPH_URL`);
a keyless Blockscout read is the local-dev fallback. The backed side is read live on-chain.

See [`SKILL.md`](./SKILL.md) for the agent-facing description and tool list.

## Run

```bash
npm install
export SUBGRAPH_URL="https://api.studio.thegraph.com/query/<id>/overdraft-aqua/<version>"  # optional
node src/server.js
```

Smoke test (stdio JSON-RPC):

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node src/server.js
```

## Tools
`aqua_coverage_summary` · `aqua_most_overcommitted` · `aqua_degenerate_positions` · `aqua_maker_coverage`
