// Overdraft — dependency-free on-chain read helpers (spike, not production).
// Node 18+ (uses global fetch, BigInt). No npm deps on purpose: the spike must
// run even if SDK installs are flaky. Production will use viem + the 1inch SDK.

/** Public RPC endpoints confirmed reachable from this machine on 2026-09-04.
 *  (llamarpc -> 521, ankr -> needs key, cloudflare-eth -> flaky getCode.) */
export const RPCS = {
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  base:     ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
};

/** Aqua core registry — deterministic same address across chains (verified). */
export const AQUA_REGISTRY = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";

let _id = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method} rpc error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** Try each endpoint for a chain until one answers. */
export async function call(chain, method, params) {
  const urls = RPCS[chain];
  if (!urls) throw new Error(`no RPC configured for chain ${chain}`);
  let lastErr;
  for (const url of urls) {
    try { return await rpc(url, method, params); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export const getCode = (chain, addr) => call(chain, "eth_getCode", [addr, "latest"]);
export const ethCall = (chain, to, data, block = "latest") =>
  call(chain, "eth_call", [{ to, data }, block]);
export const getLogs = (chain, filter) => call(chain, "eth_getLogs", [filter]);
export const blockNumber = (chain) => call(chain, "eth_blockNumber", []);

// --- minimal ABI encoding (only what the spike needs) --------------------

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addr32 = (a) => pad(a);

// Canonical ERC-20 selectors (standard, not protocol-specific).
export const ERC20 = {
  balanceOf:  (owner)          => "0x70a08231" + addr32(owner),
  allowance:  (owner, spender) => "0xdd62ed3e" + addr32(owner) + addr32(spender),
  decimals:   ()               => "0x313ce567",
  symbol:     ()               => "0x95d89b41",
};

/** Decode a single uint256 return value to BigInt. */
export const toUint = (hex) => (hex && hex !== "0x" ? BigInt(hex) : 0n);

// --- ERC-20 reads --------------------------------------------------------

export const erc20BalanceOf = (chain, token, owner) =>
  ethCall(chain, token, ERC20.balanceOf(owner)).then(toUint);
export const erc20Allowance = (chain, token, owner, spender) =>
  ethCall(chain, token, ERC20.allowance(owner, spender)).then(toUint);
export const erc20Decimals = (chain, token) =>
  ethCall(chain, token, ERC20.decimals()).then((h) => Number(toUint(h)));

// --- Aqua virtual-balance read (READ PATH — TO BE FILLED FROM AGENT A) ----
//
// The nested mapping is:
//   maker => app => strategyHash => token => Balance
// We must NOT guess the getter selector or the Balance struct layout.
// Agent A (RECON-PROTOCOL.md, Q3) is resolving the exact public view fn +
// struct from github.com/1inch/aqua source. Until then this throws loudly
// rather than returning a fabricated number.
export function aquaVirtualBalance(/* chain, maker, app, strategyHash, token */) {
  throw new Error(
    "aquaVirtualBalance: read path UNKNOWN — awaiting verified getter/struct " +
    "from RECON-PROTOCOL.md (Agent A). Do not fabricate."
  );
}
