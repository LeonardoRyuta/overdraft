// Live on-chain reads via viem (eth_call works on public RPCs; only getLogs is gated).
import { createPublicClient, http, fallback } from "viem";
import { CHAINS, AQUA, SWAPVM_ROUTER, AQUA_READ_ABI, ERC20_ABI } from "./chains.js";

const clients = {};
export function client(chain) {
  if (!clients[chain]) {
    const cfg = CHAINS[chain];
    if (!cfg) throw new Error(`unknown chain ${chain}`);
    clients[chain] = createPublicClient({ chain: cfg.viemChain, transport: fallback(cfg.rpcs.map((u) => http(u))) });
  }
  return clients[chain];
}

/** rawBalances(maker, app, strategyHash, token) -> {committed, tokensCount}. tokensCount 0=empty, 0xff=docked. */
export async function rawBalance(chain, maker, app, strategyHash, token) {
  const [committed, tokensCount] = await client(chain).readContract({
    address: AQUA, abi: AQUA_READ_ABI, functionName: "rawBalances", args: [maker, app, strategyHash, token],
  });
  return { committed, tokensCount };
}

const metaCache = new Map();
export async function tokenMeta(chain, token) {
  const key = `${chain}:${token.toLowerCase()}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const c = client(chain);
  let symbol = "?", decimals = 18, totalSupply = 0n;
  try { symbol = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }); } catch {}
  try { decimals = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }); } catch {}
  try { totalSupply = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }); } catch {}
  const m = { symbol, decimals, totalSupply };
  metaCache.set(key, m);
  return m;
}

/** backed = min(wallet, allowance). Aqua pulls in two modes: Aqua-does-transferFrom (approve Aqua)
 *  or router-does-transferFrom (approve the SwapVM router). Use the larger of the two allowances so
 *  we never understate backing (which would overstate phantom depth). */
export async function readBacking(chain, maker, token) {
  const c = client(chain);
  let wallet = 0n, allowAqua = 0n, allowRouter = 0n;
  try { wallet = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [maker] }); } catch {}
  try { allowAqua = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [maker, AQUA] }); } catch {}
  try { allowRouter = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [maker, SWAPVM_ROUTER] }); } catch {}
  const allowance = allowAqua > allowRouter ? allowAqua : allowRouter;
  return { wallet, allowance };
}
