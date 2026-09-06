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
