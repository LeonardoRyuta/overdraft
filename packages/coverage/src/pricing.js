// Keyless USD pricing via DefiLlama (https://coins.llama.fi) — no API key required.
// Used to turn per-token quoted/backed/phantom into a single USD headline figure.
// Tokens DefiLlama can't price are reported as UNPRICED (never guessed).

const LLAMA_CHAIN = { ethereum: "ethereum", base: "base", arbitrum: "arbitrum" };

/** @returns Map<tokenAddrLower, {price:number, decimals:number, symbol:string}> */
export async function getPricesUSD(chain, tokens) {
  const key = LLAMA_CHAIN[chain] || chain;
  const ids = [...new Set(tokens.map((t) => t.toLowerCase()))].map((t) => `${key}:${t}`);
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    let json;
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${batch.join(",")}`);
      if (!res.ok) continue;
      json = await res.json();
    } catch { continue; }
    for (const [id, v] of Object.entries(json.coins || {})) {
      const addr = id.split(":")[1];
      if (v && typeof v.price === "number") out.set(addr.toLowerCase(), { price: v.price, decimals: v.decimals, symbol: v.symbol });
    }
  }
  return out;
}

/** USD value of a base-unit bigint amount given token decimals + price. */
export function toUsd(amount, decimals, price) {
  if (price == null) return null;
  // amount/10^decimals * price, done in float (reporting only)
  return (Number(amount) / 10 ** decimals) * price;
}
