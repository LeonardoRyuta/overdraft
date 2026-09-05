// Orchestrator + CLI: enumerate → read live backing → per-(maker,token) coverage → aggregate.
// Usage: node src/run.js --chain ethereum [--pages 8] [--json]
//   SUBGRAPH_URL set  -> enumerate from the subgraph (live Graph data)
//   otherwise         -> enumerate from Blockscout (keyless)
import { formatUnits } from "viem";
import { enumerateBlockscout, enumerateSubgraph } from "./enumerate.js";
import { rawBalance, readBacking, tokenMeta } from "./reader.js";
import { coverageByMakerToken, aggregateByToken } from "./coverage.js";

export async function scanChain(chain, { subgraphUrl = process.env.SUBGRAPH_URL, maxPages = 6 } = {}) {
  const source = subgraphUrl ? "subgraph" : "blockscout";
  const tuples = subgraphUrl ? await enumerateSubgraph(subgraphUrl) : await enumerateBlockscout(chain, { maxPages });

  // Resolve committed (subgraph provides it; blockscout tuples need a live rawBalances read + liveness filter).
  const commitments = [];
  for (const t of tuples) {
    let committed = t.committed;
    if (committed === undefined) {
      const rb = await rawBalance(chain, t.maker, t.app, t.strategyHash, t.token);
      if (rb.tokensCount === 0 || rb.tokensCount === 0xff) continue; // empty / docked → not live
      committed = rb.committed;
    }
    commitments.push({ maker: t.maker, token: t.token, committed, app: t.app, strategyHash: t.strategyHash });
  }

  const rows = await coverageByMakerToken(commitments, (maker, token) => readBacking(chain, maker, token));
  // attach display metadata + classify degenerate positions (committed > token supply → can never be backed)
  for (const r of rows) {
    const m = await tokenMeta(chain, r.token);
    r.symbol = m.symbol; r.decimals = m.decimals; r.totalSupply = m.totalSupply;
    r.overSupply = m.totalSupply > 0n && r.committed > m.totalSupply;
  }
  const real = rows.filter((r) => !r.overSupply);
  const degenerate = rows.filter((r) => r.overSupply);
  // headline aggregates are over REAL positions only; degenerate/spam reported separately
  return { chain, source, positions: tuples.length, live: commitments.length, rows, real, degenerate, byToken: aggregateByToken(real) };
}

function printReport(res) {
  const f = (x, d) => formatUnits(x, d);
  console.log(`\n# Overdraft coverage — ${res.chain} (source: ${res.source})`);
  console.log(`enumerated ${res.positions} commitments, ${res.live} live, ${res.rows.length} (maker,token) groups`);
  console.log(`real: ${res.real.length}   degenerate (committed > token supply): ${res.degenerate.length}\n`);
  for (const r of res.real) {
    const cov = r.ratio === null ? "n/a" : (r.ratio * 100).toFixed(2) + "%";
    const flag = r.ratio !== null && r.ratio < 0.999 ? " ⚠ UNDER-BACKED" : "";
    console.log(`${cov.padStart(8)} ${flag ? "⚠" : " "} ${r.symbol.padEnd(8)} maker ${r.maker.slice(0, 10)}… ` +
      `committed ${f(r.committed, r.decimals)} backed ${f(r.backed, r.decimals)} (${r.binding})${flag}`);
  }
  if (res.degenerate.length) {
    console.log(`\ndegenerate positions (virtual balance exceeds token total supply — excluded from headline):`);
    for (const r of res.degenerate) {
      console.log(`  ${r.symbol.padEnd(8)} maker ${r.maker.slice(0, 10)}…  committed ${f(r.committed, r.decimals)}  (supply ${f(r.totalSupply, r.decimals)})`);
    }
  }
  console.log(`\nper-token totals (real positions only):`);
  for (const t of res.byToken) {
    const d = t.decimals ?? 18;
    console.log(`  ${(t.symbol || "?").padEnd(8)} quoted ${f(t.quoted, d)}  backed ${f(t.backed, d)}  phantom ${f(t.phantom, d)}  (${t.underBacked}/${t.positions} under-backed)`);
  }
  const under = res.real.filter((r) => r.ratio !== null && r.ratio < 0.999).length;
  console.log(`\nreal under-backed (maker,token) groups: ${under} / ${res.real.length}`);
}

// CLI
const isMain = process.argv[1] && process.argv[1].endsWith("run.js");
if (isMain) {
  const args = process.argv.slice(2);
  const chain = args[args.indexOf("--chain") + 1] || "ethereum";
  const pagesIdx = args.indexOf("--pages");
  const maxPages = pagesIdx > -1 ? Number(args[pagesIdx + 1]) : 6;
  const res = await scanChain(chain, { maxPages });
  if (args.includes("--json")) {
    console.log(JSON.stringify(res, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    printReport(res);
  }
}
