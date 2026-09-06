#!/usr/bin/env node
// Overdraft MCP server — lets any agent interrogate 1inch Aqua liquidity coverage
// in natural language. Data is load-bearing on The Graph: enumeration comes from the
// Overdraft subgraph when SUBGRAPH_URL is set (else Blockscout for local dev), and the
// backed side is read live on-chain. Reusable infrastructure, not an end-user app.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scanChain } from "@overdraft/coverage/src/run.js";

const CHAINS = ["ethereum", "base", "arbitrum"];
const chainArg = z.enum(CHAINS).default("ethereum");

// Scans are moderately expensive (log enumeration + many eth_calls), so cache per chain.
const cache = new Map();
async function getScan(chain, refresh) {
  const hit = cache.get(chain);
  if (hit && !refresh) return hit;
  const data = await scanChain(chain, { maxPages: 8 });
  cache.set(chain, data);
  return data;
}

const usd = (x) => "$" + Math.round(x || 0).toLocaleString("en-US");
const pct = (r) => (r == null ? "n/a" : (r * 100).toFixed(1) + "%");

const server = new McpServer({ name: "overdraft", version: "0.1.0" });

server.registerTool(
  "aqua_coverage_summary",
  {
    title: "Aqua coverage summary",
    description:
      "Network-wide 1inch Aqua liquidity coverage for a chain: total quoted (virtual) depth vs " +
      "actually-backed depth in USD, aggregate coverage ratio, phantom depth (quoted minus backed), " +
      "and counts of under-backed and degenerate positions.",
    inputSchema: { chain: chainArg, refresh: z.boolean().optional() },
  },
  async ({ chain, refresh }) => {
    const s = await getScan(chain, refresh);
    const h = s.headline;
    const under = s.real.filter((r) => r.ratio !== null && r.ratio < 0.999).length;
    const text =
      `1inch Aqua coverage — ${chain} (source: ${s.source})\n` +
      `quoted depth:       ${usd(h.usdQuoted)}\n` +
      `backed depth:       ${usd(h.usdBacked)}\n` +
      `aggregate coverage: ${pct(h.coverageUsd)}\n` +
      `phantom depth:      ${usd(h.usdPhantom)}   (quoted − backed)\n` +
      `real positions:     ${s.real.length}  (${under} under-backed)\n` +
      `degenerate:         ${s.degenerate.length}  (virtual balance exceeds token supply)`;
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "aqua_most_overcommitted",
  {
    title: "Most over-committed Aqua makers",
    description:
      "The positions with the worst coverage on a chain — makers most likely to fail to honour the " +
      "depth they quote. Sorted by coverage ascending.",
    inputSchema: { chain: chainArg, limit: z.number().int().min(1).max(50).default(10) },
  },
  async ({ chain, limit }) => {
    const s = await getScan(chain);
    const rows = s.real.filter((r) => r.ratio !== null).sort((a, b) => a.ratio - b.ratio).slice(0, limit);
    const lines = rows.map(
      (r) => `${pct(r.ratio).padStart(7)}  ${(r.symbol || "?").padEnd(8)} maker ${r.maker}  phantom ${usd(r.usdPhantom)} (binding: ${r.binding})`
    );
    return { content: [{ type: "text", text: `Most over-committed on ${chain}:\n` + (lines.join("\n") || "(none)") }] };
  }
);

server.registerTool(
  "aqua_degenerate_positions",
  {
    title: "Degenerate Aqua positions",
    description:
      "Positions whose committed virtual balance EXCEEDS the token's entire total supply — they can " +
      "never be backed, and would poison any naive phantom-depth sum. Reported separately from real positions.",
    inputSchema: { chain: chainArg },
  },
  async ({ chain }) => {
    const s = await getScan(chain);
    const lines = s.degenerate.map((r) => `${(r.symbol || "?").padEnd(8)} maker ${r.maker} token ${r.token} (virtual balance > total supply)`);
    return { content: [{ type: "text", text: `Degenerate positions on ${chain} (${s.degenerate.length}):\n` + (lines.join("\n") || "(none)") }] };
  }
);

server.registerTool(
  "aqua_maker_coverage",
  {
    title: "Coverage for a specific maker",
    description: "Coverage detail for a given maker address on a chain: each (token) position's quoted, backed, coverage and phantom.",
    inputSchema: { chain: chainArg, maker: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  },
  async ({ chain, maker }) => {
    const s = await getScan(chain);
    const rows = s.rows.filter((r) => r.maker.toLowerCase() === maker.toLowerCase());
    if (rows.length === 0) return { content: [{ type: "text", text: `No live Aqua positions found for ${maker} on ${chain}.` }] };
    const lines = rows.map(
      (r) => `${(r.symbol || "?").padEnd(8)} coverage ${pct(r.ratio)}  quoted ${usd(r.usdQuoted)}  backed ${usd(r.usdBacked)}  phantom ${usd(r.usdPhantom)}${r.overSupply ? "  [degenerate]" : ""}`
    );
    return { content: [{ type: "text", text: `Coverage for ${maker} on ${chain}:\n` + lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("overdraft-mcp: ready (stdio)");
