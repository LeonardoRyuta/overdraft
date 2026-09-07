// Position enumeration. Two interchangeable sources behind one shape:
//   { maker, app, strategyHash, token, committed? }
// - blockscout: keyless decoded logs — works today, public RPCs gate eth_getLogs.
// - subgraph:   live Graph data — the production source (satisfies The Graph rule).
import { CHAINS, AQUA } from "./chains.js";

export async function enumerateBlockscout(chain, { maxPages = 6 } = {}) {
  const cfg = CHAINS[chain];
  if (!cfg || !cfg.blockscout) throw new Error(`no blockscout base for ${chain}`);
  const tuples = new Map();
  let params = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${cfg.blockscout}/api/v2/addresses/${AQUA}/logs` + (params ? `?${new URLSearchParams(params)}` : "");
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) break;
    const json = await res.json();
    for (const it of json.items || []) {
      const d = it.decoded;
      if (!d || !String(d.method_call).startsWith("Pushed")) continue;
      const p = Object.fromEntries(d.parameters.map((x) => [x.name, x.value]));
      const key = `${p.maker}|${p.app}|${p.strategyHash}|${p.token}`.toLowerCase();
      if (!tuples.has(key)) tuples.set(key, { maker: p.maker, app: p.app, strategyHash: p.strategyHash, token: p.token });
    }
    if (!json.next_page_params) break;
    params = json.next_page_params;
  }
  return [...tuples.values()];
}

// Paginate the FULL set of active commitments via an id cursor (The Graph caps `first` at 1000).
// Fallback for chains whose Blockscout v2 API is down (e.g. Base): the legacy Etherscan-compatible
// /api getLogs endpoint. Events are non-indexed, so we decode maker/app/strategyHash/token from the
// data words ourselves. Paginates by advancing fromBlock (dedup handles the 1000-cap overlap).
const PUSHED_TOPIC0 = "0x3f18354abbd5306dd1665c2c90f614a4559e39dd620d04fbe5458e613b6588f3";
export async function enumerateBlockscoutLegacy(chain, { pageMax = 30 } = {}) {
  const cfg = CHAINS[chain];
  if (!cfg || !cfg.blockscout) throw new Error(`no blockscout base for ${chain}`);
  const tuples = new Map();
  let from = 0, lastSeen = -1;
  for (let page = 0; page < pageMax; page++) {
    const url = `${cfg.blockscout}/api?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${AQUA}&topic0=${PUSHED_TOPIC0}`;
    let json;
    try { json = await (await fetch(url)).json(); } catch { break; }
    const logs = Array.isArray(json.result) ? json.result : [];
    if (logs.length === 0) break;
    for (const log of logs) {
      const d = log.data.replace(/^0x/, "");
      const word = (i) => d.slice(i * 64, (i + 1) * 64);
      const addr = (w) => "0x" + w.slice(24);
      tuples.set(
        `${addr(word(0))}|${addr(word(1))}|0x${word(2)}|${addr(word(3))}`.toLowerCase(),
        { maker: addr(word(0)), app: addr(word(1)), strategyHash: "0x" + word(2), token: addr(word(3)) }
      );
    }
    const last = parseInt(logs[logs.length - 1].blockNumber, 16);
    if (logs.length < 1000 || last === lastSeen) break; // done, or no progress
    lastSeen = last;
    from = last; // re-scan boundary block; dedup by key absorbs the overlap
  }
  return [...tuples.values()];
}

export async function enumerateSubgraph(url, { pageSize = 1000 } = {}) {
  const out = [];
  let lastId = "";
  for (;;) {
    const query = `{ commitments(where:{active:true, id_gt:"${lastId}"}, first:${pageSize}, orderBy:id, orderDirection:asc) {
      id committed maker { id } token { id } position { app strategyHash } } }`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    const json = await res.json();
    if (json.errors) throw new Error(`subgraph: ${JSON.stringify(json.errors)}`);
    const batch = json.data.commitments;
    for (const c of batch) {
      out.push({ maker: c.maker.id, app: c.position.app, strategyHash: c.position.strategyHash, token: c.token.id, committed: BigInt(c.committed) });
    }
    if (batch.length < pageSize) break;
    lastId = batch[batch.length - 1].id;
  }
  return out;
}
