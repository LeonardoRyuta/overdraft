// Orchestrator + CLI: enumerate → read live backing → per-(maker,token) coverage → aggregate.
// Usage: node src/run.js --chain ethereum [--pages 8] [--json]
//   SUBGRAPH_URL set  -> enumerate from the subgraph (live Graph data)
//   otherwise         -> enumerate from Blockscout (keyless)
import { formatUnits } from "viem";
import { enumerateBlockscout, enumerateSubgraph } from "./enumerate.js";
import { rawBalance, readBacking, tokenMeta } from "./reader.js";
import { coverageByMakerToken, aggregateByToken } from "./coverage.js";
import { getPricesUSD, toUsd } from "./pricing.js";

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

  // USD pricing over real positions (keyless DefiLlama); unpriced tokens excluded from the $ headline
  const prices = await getPricesUSD(chain, real.map((r) => r.token));
  let usdQuoted = 0, usdBacked = 0, usdPhantom = 0, priced = 0, unpriced = 0;
  for (const r of real) {
    const p = prices.get(r.token.toLowerCase());
    r.priceUsd = p ? p.price : null;
    r.usdQuoted = toUsd(r.committed, r.decimals, r.priceUsd);
    r.usdBacked = toUsd(r.backed, r.decimals, r.priceUsd);
    r.usdPhantom = toUsd(r.phantom, r.decimals, r.priceUsd);
    if (r.priceUsd == null) { unpriced++; continue; }
    priced++; usdQuoted += r.usdQuoted; usdBacked += r.usdBacked; usdPhantom += r.usdPhantom;
  }
  const headline = { usdQuoted, usdBacked, usdPhantom, coverageUsd: usdQuoted > 0 ? usdBacked / usdQuoted : null, priced, unpriced };

  // headline aggregates are over REAL positions only; degenerate/spam reported separately
  return { chain, source, positions: tuples.length, live: commitments.length, rows, real, degenerate, byToken: aggregateByToken(real), headline };
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

  const h = res.headline;
  if (h) {
    const usd = (x) => "$" + Math.round(x).toLocaleString("en-US");
    console.log(`\n=== USD HEADLINE — ${res.chain} (real positions, ${h.priced} priced / ${h.unpriced} unpriced) ===`);
    console.log(`  quoted depth : ${usd(h.usdQuoted)}`);
    console.log(`  backed depth : ${usd(h.usdBacked)}`);
    console.log(`  coverage     : ${h.coverageUsd == null ? "n/a" : (h.coverageUsd * 100).toFixed(1) + "%"}`);
    console.log(`  phantom depth: ${usd(h.usdPhantom)}  (quoted − backed)`);
  }
}

// CLI
const isMain = process.argv[1] && process.argv[1].endsWith("run.js");
if (isMain) {
  const args = process.argv.slice(2);
  const chain = args[args.indexOf("--chain") + 1] || "ethereum";
  const pagesIdx = args.indexOf("--pages");
  const maxPages = args.includes("--deep") ? 40 : pagesIdx > -1 ? Number(args[pagesIdx + 1]) : 6;
  const res = await scanChain(chain, { maxPages });
  if (args.includes("--json")) {
    console.log(JSON.stringify(res, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    printReport(res);
  }
}
