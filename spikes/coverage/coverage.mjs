// Overdraft — pure coverage math (spike). No I/O here so it is testable
// independent of chain data. This is "the novel part": turning virtual
// balances + real backing into a solvency ratio.

/**
 * Coverage is computed per (maker, token), NOT per position, because:
 *   - wallet balance and Aqua allowance are token-specific and shared across
 *     all of a maker's positions in that token;
 *   - virtual commitments are per-token.
 * One maker balance backs many positions => the honest denominator is the SUM
 * of virtual balances that maker has committed in that token.
 *
 *   backed(maker,token)    = min(walletBalance, aquaAllowance)
 *   committed(maker,token) = Σ virtualBalance over that maker's positions in token
 *   coverage(maker,token)  = backed / committed        (in [0, ∞), capped view at 1.0)
 *   phantom(maker,token)   = max(0, committed - backed) // depth quoted but not backed
 *
 * All amounts are token base units (BigInt). Cross-token / network-wide USD
 * rollups require a price source (FLAGGED: not yet wired — see README).
 */

/** @param {bigint} walletBalance @param {bigint} allowance @param {bigint} committed */
export function coverageForMakerToken(walletBalance, allowance, committed) {
  const backed = walletBalance < allowance ? walletBalance : allowance;
  // ratio as a float for reporting; keep exact bigints for the phantom figure.
  let ratio;
  if (committed === 0n) ratio = null;            // nothing committed => undefined, not 0
  else ratio = Number(backed) / Number(committed);
  const phantom = committed > backed ? committed - backed : 0n;
  return { backed, committed, ratio, phantom, bindingConstraint:
    walletBalance < allowance ? "wallet" : (allowance < walletBalance ? "allowance" : "equal") };
}

/**
 * Aggregate a flat list of position commitments into per-(maker,token) coverage.
 * @param {Array<{maker:string, token:string, virtual:bigint}>} positions
 * @param {(maker:string, token:string)=>Promise<{wallet:bigint, allowance:bigint}>} readBacking
 */
export async function coverageByMakerToken(positions, readBacking) {
  const committedMap = new Map(); // key: maker|token -> {maker, token, committed, count}
  for (const p of positions) {
    const key = `${p.maker.toLowerCase()}|${p.token.toLowerCase()}`;
    const cur = committedMap.get(key) || { maker: p.maker, token: p.token, committed: 0n, count: 0 };
    cur.committed += p.virtual;
    cur.count += 1;
    committedMap.set(key, cur);
  }
  const out = [];
  for (const { maker, token, committed, count } of committedMap.values()) {
    const { wallet, allowance } = await readBacking(maker, token);
    out.push({ maker, token, positions: count, ...coverageForMakerToken(wallet, allowance, committed) });
  }
  return out;
}

// --- self-test: proves the engine is correct before we have live data -----
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("coverage.mjs")) {
  const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}: ${a} !== ${b}`); process.exitCode = 1; } else console.log(`ok   ${m}`); };

  // 1inch's marketing example: $100k wallet backing 3 positions quoting $300k total.
  const U = (n) => BigInt(n) * 10n ** 6n; // USDC-like 6dp
  const wallet = U(100_000), allowance = U(100_000);
  const positions = [
    { maker: "0xMAKER", token: "0xUSDC", virtual: U(100_000) },
    { maker: "0xMAKER", token: "0xUSDC", virtual: U(100_000) },
    { maker: "0xMAKER", token: "0xUSDC", virtual: U(100_000) },
  ];
  const rows = await coverageByMakerToken(positions, async () => ({ wallet, allowance }));
  const r = rows[0];
  eq(r.committed, U(300_000), "committed = 300k");
  eq(r.backed, U(100_000), "backed = 100k (min wallet/allowance)");
  eq(Math.round(r.ratio * 100), 33, "coverage ratio ~33%");
  eq(r.phantom, U(200_000), "phantom depth = 200k");

  // fully backed case
  const full = coverageForMakerToken(U(50_000), U(50_000), U(40_000));
  eq(full.phantom, 0n, "fully backed => 0 phantom");
  eq(full.ratio > 1, true, "over-backed ratio > 1");

  console.log("\ncoverage engine self-test complete.");
}
