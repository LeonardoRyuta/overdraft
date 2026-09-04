// Overdraft live spike v2 — REAL Aqua coverage, zero credentials.
// Enumeration: Blockscout keyless decoded-logs API (public RPCs gate eth_getLogs).
// State reads: eth_call via public RPC (works fine).  Run from spikes/sdk:
//   node coverage-blockscout.mjs
//
// This is a spike, not production. Production enumeration is Substreams/subgraph;
// Blockscout here is a live cross-check that needs no API key. NOT a mock — every
// number is read from live mainnet state.

import { createPublicClient, http, fallback, formatUnits } from "viem";
import { mainnet } from "viem/chains";

const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";       // AquaRouter (verified on Blockscout)
const BLOCKSCOUT = "https://eth.blockscout.com";

const client = createPublicClient({
  chain: mainnet,
  transport: fallback([ http("https://ethereum-rpc.publicnode.com"), http("https://eth.drpc.org") ]),
});

const aquaReadAbi = [{
  type: "function", name: "rawBalances", stateMutability: "view",
  inputs: [ { name: "maker", type: "address" }, { name: "app", type: "address" },
    { name: "strategyHash", type: "bytes32" }, { name: "token", type: "address" } ],
  outputs: [ { name: "balance", type: "uint248" }, { name: "tokensCount", type: "uint8" } ],
}];
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

// Pull Pushed events (position token commitments) from Blockscout, paginated.
async function fetchPushed(maxPages = 4) {
  const tuples = new Map(); // key maker|app|hash|token -> {maker, app, strategyHash, token, block}
  let url = `${BLOCKSCOUT}/api/v2/addresses/${AQUA}/logs`;
  let params = null;
  for (let page = 0; page < maxPages; page++) {
    const full = params ? `${url}?${new URLSearchParams(params)}` : url;
    const res = await fetch(full, { headers: { accept: "application/json" } });
    if (!res.ok) { console.log(`  blockscout page ${page} http ${res.status}`); break; }
    const json = await res.json();
    let nPushed = 0;
    for (const it of json.items || []) {
      const d = it.decoded;
      if (!d || !String(d.method_call).startsWith("Pushed")) continue;
      const p = Object.fromEntries(d.parameters.map((x) => [x.name, x.value]));
      const key = `${p.maker}|${p.app}|${p.strategyHash}|${p.token}`.toLowerCase();
      if (!tuples.has(key)) tuples.set(key, { maker: p.maker, app: p.app, strategyHash: p.strategyHash, token: p.token, block: it.block_number });
      nPushed++;
    }
    console.log(`  blockscout page ${page}: ${json.items?.length ?? 0} logs, ${nPushed} Pushed, ${tuples.size} distinct positions`);
    if (!json.next_page_params) break;
    params = json.next_page_params;
  }
  return [...tuples.values()];
}

const meta = new Map(); // token -> {symbol, decimals}
async function tokenMeta(token) {
  if (meta.has(token)) return meta.get(token);
  let symbol = "?", decimals = 18;
  try { symbol = await client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }); } catch {}
  try { decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }); } catch {}
  const m = { symbol, decimals }; meta.set(token, m); return m;
}

async function main() {
  const head = await client.getBlockNumber();
  console.log(`head block ${head}. enumerating live Aqua positions via Blockscout...`);
  const positions = await fetchPushed();
  console.log(`\n${positions.length} distinct (maker,app,strategyHash,token) commitments seen. Reading live state via eth_call:\n`);

  let live = 0;
  const rows = [];
  for (const pos of positions) {
    let committed, tokensCount;
    try {
      [committed, tokensCount] = await client.readContract({
        address: AQUA, abi: aquaReadAbi, functionName: "rawBalances",
        args: [pos.maker, pos.app, pos.strategyHash, pos.token] });
    } catch (e) { console.log(`  rawBalances failed for ${pos.strategyHash.slice(0,10)}: ${String(e).slice(0,80)}`); continue; }
    if (tokensCount === 0 || tokensCount === 0xff) continue; // empty / docked -> not live
    live++;
    const { symbol, decimals } = await tokenMeta(pos.token);
    let wallet = 0n, allowAqua = 0n, allowApp = 0n;
    try { wallet = await client.readContract({ address: pos.token, abi: erc20Abi, functionName: "balanceOf", args: [pos.maker] }); } catch {}
    try { allowAqua = await client.readContract({ address: pos.token, abi: erc20Abi, functionName: "allowance", args: [pos.maker, AQUA] }); } catch {}
    try { allowApp = await client.readContract({ address: pos.token, abi: erc20Abi, functionName: "allowance", args: [pos.maker, pos.app] }); } catch {}
    // allowance is granted to the Aqua contract (Aqua does the transferFrom). Use the larger of the two observed, prefer Aqua.
    const allowance = allowAqua > 0n ? allowAqua : allowApp;
    const backed = wallet < allowance ? wallet : allowance;
    const ratio = committed === 0n ? null : Number(backed) / Number(committed);
    const phantom = committed > backed ? committed - backed : 0n;
    rows.push({ pos, symbol, decimals, committed, tokensCount, wallet, allowAqua, allowApp, allowance, backed, ratio, phantom });
  }

  const f = (x, d) => formatUnits(x, d);
  rows.sort((a, b) => (a.ratio ?? 9e9) - (b.ratio ?? 9e9)); // worst coverage first
  for (const r of rows) {
    console.log("─────────────────────────────────────────────────────────");
    console.log(`maker ${r.pos.maker}`);
    console.log(`  app/router  ${r.pos.app}`);
    console.log(`  strategy    ${r.pos.strategyHash}`);
    console.log(`  token       ${r.pos.token}  ${r.symbol} (${r.decimals}dp)  tokensCount=${r.tokensCount}`);
    console.log(`  committed   ${f(r.committed, r.decimals)} ${r.symbol}  (virtual balance)`);
    console.log(`  wallet      ${f(r.wallet, r.decimals)} ${r.symbol}`);
    console.log(`  allowance   ${f(r.allowAqua, r.decimals)} (->Aqua) / ${f(r.allowApp, r.decimals)} (->app)`);
    console.log(`  backed      ${f(r.backed, r.decimals)} ${r.symbol}  = min(wallet, allowance)`);
    console.log(`  COVERAGE    ${r.ratio === null ? "n/a" : (r.ratio * 100).toFixed(2) + "%"} ${r.ratio !== null && r.ratio < 0.999 ? "  ⚠ UNDER-BACKED" : ""}`);
    console.log(`  phantom     ${f(r.phantom, r.decimals)} ${r.symbol}`);
  }
  console.log("\n=========================================================");
  console.log(`positions seen: ${positions.length} | live: ${live} | coverage computed: ${rows.length}`);
  const under = rows.filter((r) => r.ratio !== null && r.ratio < 0.999).length;
  console.log(`under-backed (coverage < 100%): ${under}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
