/**
 * STEP 2 + 3 — Execute a REAL live position's swap on an anvil mainnet fork, then diff
 * amountOut_quoted (eth_call) vs amountOut_executed (real state-changing swap).
 * Proves Quote/Swap Consistency (SwapVM invariant #3) on-chain.
 *
 * The maker re-ships a fresh strategyHash every block and DOCKS the old ones, so we must
 * pick a position whose Aqua strategy is still ACTIVE (rawBalances tokensCount in [1,254],
 * committed>0) — else the swap reverts SafeBalancesForTokenNotInActiveStrategy (0xb63386a6).
 *
 * Fork cheats: impersonate a RES access-token holder as taker (passes the 0x21 tx.origin
 * gate), fund gas + tokenIn (anvil_setBalance / anvil_setStorageAt on balanceOf slot),
 * approve Aqua, send encodeSwapCallData, read the Swapped event.
 *
 * Prereq: anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
 * Run:    npx tsx src/swap.ts
 */
import {
  quoteCallData, swapCallData, decodeSwapVmReturn, decodeRevert, findResHolder, balanceOf,
  pickActivePosition, ROUTER_ADDR, WSTETH, ONEINCH, ACCESS_TOKEN, TakerTraits,
} from './lib.js';
import {
  createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, pad, toHex,
  decodeEventLog, parseAbiItem, type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';

const ANVIL = 'http://127.0.0.1:8545';
const line = () => console.log('─'.repeat(76));
const pub = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const wallet = createWalletClient({ chain: mainnet, transport: http(ANVIL) });

async function rpc(method: string, params: any[]) {
  const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const SWAPPED = parseAbiItem('event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)');
const ERC20_APPROVE = parseAbiItem('function approve(address spender, uint256 amount) returns (bool)');

function revertData(e: any): Hex | undefined {
  let cur = e;
  for (let i = 0; i < 10 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex;
    if (cur.data?.data && typeof cur.data.data === 'string') return cur.data.data as Hex;
    cur = cur.cause;
  }
  const m = String(e?.message || e).match(/0x[0-9a-fA-F]{8,}/);
  return m ? (m[0] as Hex) : undefined;
}

async function fundErc20(token: string, holder: string, amount: bigint): Promise<number> {
  for (let slot = 0; slot < 200; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder as `0x${string}`, BigInt(slot)])) as Hex;
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })]);
    if ((await balanceOf(pub, token, holder)) === amount) return slot;
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(0n), { size: 32 })]);
  }
  throw new Error(`could not find balanceOf slot for ${token}`);
}

async function main() {
  console.log('Overdraft Honesty Probe — STEP 2/3: real swap on fork + quote/swap diff\n');
  const forkBlock = await pub.getBlockNumber();
  console.log('anvil fork block:', forkBlock.toString());

  const pos = await pickActivePosition(pub, WSTETH, ONEINCH, forkBlock);
  if (!pos) { console.log('No ACTIVE wstETH/1INCH position at this block; re-run (maker re-ships each block).'); return; }
  const order = pos.order;
  console.log('ACTIVE position:');
  console.log('  strategyHash :', pos.strategyHash);
  console.log('  maker        :', pos.maker, ' ship block:', pos.block);
  console.log('  virtual committed  1INCH:', pos.committedB.toString());
  console.log('  virtual committed wstETH:', pos.committedA.toString());

  const taker = await findResHolder(pub, forkBlock);
  console.log('  taker(RES)   :', taker, ' RES balance:', (await balanceOf(pub, ACCESS_TOKEN, taker, forkBlock)).toString());

  const tokenIn = WSTETH, tokenOut = ONEINCH;
  const amountIn = 10n ** 16n; // 0.01 wstETH
  const tt = TakerTraits.default();

  line();
  console.log('QUOTE on the fork (eth_call, from = taker):');
  const qData = quoteCallData({ order, tokenIn, tokenOut, amount: amountIn, takerTraits: tt });
  const q = await pub.call({ account: taker as `0x${string}`, to: ROUTER_ADDR.toString() as `0x${string}`, data: qData, blockNumber: forkBlock });
  const amountOutQuoted = decodeSwapVmReturn((q.data ?? '0x') as Hex).amountOut;
  console.log('  amountIn =', amountIn.toString(), ' amountOut_quoted =', amountOutQuoted.toString());

  line();
  console.log('FORK SETUP:');
  await rpc('anvil_impersonateAccount', [taker]);
  await rpc('anvil_setBalance', [taker, toHex(10n ** 18n)]);
  const inSlot = await fundErc20(tokenIn, taker, amountIn * 10n);
  console.log(`  impersonated taker, 1 ETH gas, funded ${amountIn * 10n} wstETH (slot ${inSlot})`);
  // The taker's tokenIn is pulled by the SwapVM ROUTER (spender), not Aqua — approve the router.
  const approveHash = await wallet.writeContract({ account: taker as `0x${string}`, address: tokenIn as `0x${string}`, abi: [ERC20_APPROVE], functionName: 'approve', args: [ROUTER_ADDR.toString() as `0x${string}`, amountIn * 10n] });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  console.log('  approved SwapVM router for wstETH (taker side)');

  line();
  console.log('SWAP (state-changing) on the fork:');
  const sData = swapCallData({ order, tokenIn, tokenOut, amount: amountIn, takerTraits: tt });
  // Pre-simulate to capture any revert reason cleanly.
  try {
    await pub.call({ account: taker as `0x${string}`, to: ROUTER_ADDR.toString() as `0x${string}`, data: sData });
  } catch (e: any) {
    console.log('  swap would revert:', JSON.stringify(decodeRevert(revertData(e)), bj));
    return;
  }
  const before = await balanceOf(pub, tokenOut, taker);
  const swapHash = await wallet.sendTransaction({ account: taker as `0x${string}`, to: ROUTER_ADDR.toString() as `0x${string}`, data: sData });
  const receipt = await pub.waitForTransactionReceipt({ hash: swapHash });
  console.log('  swap tx status:', receipt.status, ' gasUsed:', receipt.gasUsed.toString());

  let amountOutExecuted: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ROUTER_ADDR.toString().toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [SWAPPED], data: log.data, topics: log.topics });
      if (ev.eventName === 'Swapped') amountOutExecuted = (ev.args as any).amountOut as bigint;
    } catch {}
  }
  const after = await balanceOf(pub, tokenOut, taker);
  const delta = after - before;
  const exec = amountOutExecuted ?? delta;
  console.log('  Swapped.amountOut_executed:', (amountOutExecuted ?? 0n).toString(), ' | taker 1INCH balance delta:', delta.toString());

  line();
  console.log('DIFF — Quote/Swap Consistency (invariant #3):');
  console.log('  amountOut_quoted   :', amountOutQuoted.toString());
  console.log('  amountOut_executed :', exec.toString());
  const d = exec > amountOutQuoted ? exec - amountOutQuoted : amountOutQuoted - exec;
  console.log('  abs diff           :', d.toString(), d === 0n ? '(EXACT MATCH ✅)' : `(rel ${(Number(d) / Number(amountOutQuoted) * 100).toFixed(10)}%)`);
  console.log('  fork block         :', forkBlock.toString());
  console.log('\nSWAP_RESULT_JSON=' + JSON.stringify({
    strategyHash: pos.strategyHash, taker, tokenIn, tokenOut, amountIn: amountIn.toString(),
    amountOut_quoted: amountOutQuoted.toString(), amountOut_executed: exec.toString(),
    exactMatch: d === 0n, forkBlock: forkBlock.toString(),
  }));
}

function bj(_k: string, v: any) { return typeof v === 'bigint' ? v.toString() : v; }
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
