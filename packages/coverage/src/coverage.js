// Overdraft coverage math — pure, no I/O, testable in isolation.
// coverage(maker,token) = min(wallet, allowance) / Σ virtual committed
// Computed per (maker, token): wallet balance and Aqua allowance are token-specific
// and shared across all of a maker's positions in that token; commitments are per-token.

/** @param {bigint} wallet @param {bigint} allowance @param {bigint} committed */
export function coverageForMakerToken(wallet, allowance, committed) {
  const backed = wallet < allowance ? wallet : allowance;
  const ratio = committed === 0n ? null : Number(backed) / Number(committed);
  const phantom = committed > backed ? committed - backed : 0n;
  const binding = wallet < allowance ? "wallet" : allowance < wallet ? "allowance" : "equal";
  return { backed, committed, ratio, phantom, binding };
}

/**
 * Aggregate raw position commitments into per-(maker,token) coverage rows.
 * @param {Array<{maker:string, token:string, committed:bigint, app?:string, strategyHash?:string}>} commitments
 * @param {(maker:string, token:string)=>Promise<{wallet:bigint, allowance:bigint}>} readBacking
 */
export async function coverageByMakerToken(commitments, readBacking) {
  const grouped = new Map();
  for (const c of commitments) {
    const key = `${c.maker.toLowerCase()}|${c.token.toLowerCase()}`;
    const g = grouped.get(key) || { maker: c.maker, token: c.token, committed: 0n, positions: 0 };
    g.committed += c.committed;
    g.positions += 1;
    grouped.set(key, g);
  }
  const rows = [];
  for (const g of grouped.values()) {
    const { wallet, allowance } = await readBacking(g.maker, g.token);
    rows.push({ ...g, ...coverageForMakerToken(wallet, allowance, g.committed) });
  }
  return rows.sort((a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity));
}

/** Per-token network aggregates. Cross-token USD totals need a price source (not wired). */
export function aggregateByToken(rows) {
  const byToken = new Map();
  for (const r of rows) {
    const t = byToken.get(r.token.toLowerCase()) || { token: r.token, symbol: r.symbol, decimals: r.decimals, quoted: 0n, backed: 0n, phantom: 0n, positions: 0, underBacked: 0 };
    t.quoted += r.committed;
    t.backed += r.backed;
    t.phantom += r.phantom;
    t.positions += r.positions;
    if (r.ratio !== null && r.ratio < 0.999) t.underBacked += 1;
    byToken.set(r.token.toLowerCase(), t);
  }
  return [...byToken.values()];
}

// self-test — proves the math against 1inch's own marketing example
if (process.argv[1] && process.argv[1].endsWith("coverage.js") && process.argv.includes("--test")) {
  const U = (n) => BigInt(n) * 10n ** 6n;
  const rows = await coverageByMakerToken(
    [0, 1, 2].map(() => ({ maker: "0xM", token: "0xT", committed: U(100_000) })),
    async () => ({ wallet: U(100_000), allowance: U(100_000) })
  );
  const r = rows[0];
  const ok = (c, m) => console.log(`${c ? "ok  " : "FAIL"} ${m}`) || (c || (process.exitCode = 1));
  ok(r.committed === U(300_000), "committed 300k");
  ok(r.backed === U(100_000), "backed 100k");
  ok(Math.round(r.ratio * 100) === 33, "coverage 33%");
  ok(r.phantom === U(200_000), "phantom 200k");
  console.log("coverage math self-test done.");
}
