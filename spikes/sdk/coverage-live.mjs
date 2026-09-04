// Overdraft live spike — find a REAL Aqua position from mainnet state and print
// its coverage ratio. No mocks, no fabricated numbers. Uses viem (installed here
// by Agent B). Run: node coverage-live.mjs   (from spikes/sdk)
//
// Path (per RECON-PROTOCOL.md, verified against 1inch/aqua source):
//  1. eth_getLogs Shipped/Pushed on the Aqua registry over recent bounded chunks
//  2. rawBalances(maker, app, strategyHash, token) -> (uint248 amount, uint8 tokensCount)
//     live iff tokensCount in [1, 0xfe]
//  3. backed = min(ERC20.balanceOf(maker), ERC20.allowance(maker, AQUA))
//  4. coverage = backed / committed(amount)

import { createPublicClient, http, fallback, parseEventLogs, formatUnits } from "viem";
import { mainnet } from "viem/chains";

const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";

const client = createPublicClient({
  chain: mainnet,
  transport: fallback([
    http("https://ethereum-rpc.publicnode.com"),
    http("https://eth.drpc.org"),
  ]),
});

const eventsAbi = [
  { type: "event", name: "Shipped", inputs: [
    { name: "maker", type: "address" }, { name: "app", type: "address" },
    { name: "strategyHash", type: "bytes32" }, { name: "strategy", type: "bytes" } ] },
  { type: "event", name: "Pushed", inputs: [
    { name: "maker", type: "address" }, { name: "app", type: "address" },
    { name: "strategyHash", type: "bytes32" }, { name: "token", type: "address" },
    { name: "amount", type: "uint256" } ] },
];

const aquaReadAbi = [
  { type: "function", name: "rawBalances", stateMutability: "view",
    inputs: [ { name: "maker", type: "address" }, { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" }, { name: "token", type: "address" } ],
    outputs: [ { name: "balance", type: "uint248" }, { name: "tokensCount", type: "uint8" } ] },
];

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

// getLogs with adaptive chunk shrinking on RPC range errors.
async function getLogsChunk(fromBlock, toBlock) {
  try {
    return await client.getLogs({ address: AQUA, fromBlock, toBlock });
  } catch (e) {
    if (toBlock - fromBlock <= 1n) throw e;
    const mid = (fromBlock + toBlock) / 2n;
    const a = await getLogsChunk(fromBlock, mid);
    const b = await getLogsChunk(mid + 1n, toBlock);
    return [...a, ...b];
  }
}

async function main() {
  const head = await client.getBlockNumber();
  console.log(`head block: ${head}`);

  const CHUNK = 45000n;         // walk backward in windows
  const MAX_LOOKBACK = 900000n; // ~worst case since launch (~5-6 weeks of ETH blocks)
  const shipped = new Map();    // strategyHash -> {maker, app, strategyHash, block}
  const pushedByHash = new Map(); // strategyHash -> [{token, amount}]

  let to = head;
  let scanned = 0n;
  while (scanned < MAX_LOOKBACK && shipped.size < 25) {
    const from = to > CHUNK ? to - CHUNK : 0n;
    process.stdout.write(`  scanning ${from}..${to} ... `);
    let raw;
    try { raw = await getLogsChunk(from, to); }
    catch (e) { console.log(`getLogs failed: ${String(e).slice(0, 120)}`); to = from - 1n; scanned += CHUNK; continue; }
    const decoded = parseEventLogs({ abi: eventsAbi, logs: raw });
    let nShip = 0, nPush = 0;
    for (const log of decoded) {
      if (log.eventName === "Shipped") {
        nShip++;
        const h = log.args.strategyHash;
        if (!shipped.has(h)) shipped.set(h, { ...log.args, block: log.blockNumber });
      } else if (log.eventName === "Pushed") {
        nPush++;
        const h = log.args.strategyHash;
        if (!pushedByHash.has(h)) pushedByHash.set(h, []);
        pushedByHash.get(h).push({ token: log.args.token, amount: log.args.amount });
      }
    }
    console.log(`${raw.length} logs (${nShip} Shipped, ${nPush} Pushed). total Shipped=${shipped.size}`);
    if (from === 0n) break;
    to = from - 1n;
    scanned += CHUNK;
  }

  console.log(`\nfound ${shipped.size} distinct shipped strategies in lookback window.`);
  if (shipped.size === 0) {
    console.log("NO Shipped events found in window. Either Aqua-native ships are rare (SwapVM orders don't emit Shipped) or lookback too short.");
    console.log("=> Day-2 gate note: enumeration via Shipped needs either an archive RPC with wide getLogs, or scanning Swapped on the router. Flagging.");
    return;
  }

  // Evaluate coverage for shipped strategies that have a known token (via Pushed).
  let evaluated = 0;
  for (const [h, s] of shipped) {
    const pushes = pushedByHash.get(h);
    if (!pushes || pushes.length === 0) continue; // no token info -> skip (would need strategy-blob decode)
    const tokens = [...new Set(pushes.map(p => p.token.toLowerCase()))];
    for (const token of tokens) {
      let raw;
      try {
        raw = await client.readContract({ address: AQUA, abi: aquaReadAbi, functionName: "rawBalances",
          args: [s.maker, s.app, h, token] });
      } catch (e) { continue; }
      const [committed, tokensCount] = raw;
      if (tokensCount === 0 || tokensCount === 0xff) continue; // empty or docked -> not live
      // live position: read backing
      let sym = "?", dec = 18, wallet = 0n, allow = 0n;
      try { sym = await client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }); } catch {}
      try { dec = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }); } catch {}
      try { wallet = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [s.maker] }); } catch {}
      try { allow = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [s.maker, AQUA] }); } catch {}
      const backed = wallet < allow ? wallet : allow;
      const ratio = committed === 0n ? null : Number(backed) / Number(committed);
      const fmt = (x) => formatUnits(x, dec);
      console.log("\n─────────────────────────────────────────────");
      console.log(`LIVE POSITION  strategyHash=${h}`);
      console.log(`  maker      : ${s.maker}`);
      console.log(`  app        : ${s.app}`);
      console.log(`  token      : ${token} (${sym}, ${dec}dp)  tokensCount=${tokensCount}`);
      console.log(`  committed  : ${fmt(committed)} ${sym}   (virtual balance, rawBalances.amount)`);
      console.log(`  wallet bal : ${fmt(wallet)} ${sym}`);
      console.log(`  allowance  : ${fmt(allow)} ${sym}  (maker -> Aqua)`);
      console.log(`  backed     : ${fmt(backed)} ${sym}   = min(wallet, allowance)  [binding: ${wallet < allow ? "wallet" : "allowance"}]`);
      console.log(`  COVERAGE   : ${ratio === null ? "n/a" : (ratio * 100).toFixed(2) + "%"}   ${ratio !== null && ratio < 1 ? "⚠ UNDER-BACKED" : ""}`);
      const phantom = committed > backed ? committed - backed : 0n;
      console.log(`  phantom    : ${fmt(phantom)} ${sym}   (committed - backed)`);
      evaluated++;
      if (evaluated >= 5) { console.log("\n(stopping after 5 live positions for the spike)"); return; }
    }
  }
  if (evaluated === 0) {
    console.log("\nShipped strategies found but none resolved to a LIVE (maker,app,hash,token) with token info.");
    console.log("Likely: these are SwapVM-app ships whose tokens need strategy-blob decode, or all docked. Flagging for follow-up.");
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
