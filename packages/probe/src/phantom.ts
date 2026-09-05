/**
 * STEP 4 — PHANTOM FILL (the money shot), on a REAL live position.
 *
 * The wstETH/1INCH position commits ~9.0e15 1INCH of VIRTUAL (quoted) depth, but the
 * maker's REAL 1INCH wallet balance is only ~178k. So the quote engine will happily
 * quote an amountOut far beyond what the maker can actually deliver.
 *
 * We demonstrate on an anvil fork:
 *   BACKED swap  (out < maker real balance) -> executes, amountOut delivered.
 *   PHANTOM swap (out > maker real balance, but well within the quoted virtual depth)
 *                 -> the quote still returns that big amountOut, but the SWAP REVERTS
 *                    because Aqua.pull's IERC20(1INCH).transferFrom(maker,...) exceeds
 *                    the maker's real balance ("ERC20: transfer amount exceeds balance").
 *
 * This is Overdraft's core thesis, shown on-chain: quoted depth >> backed depth.
 *
 * Prereq: anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
 * Run:    npx tsx src/phantom.ts
 */
import {
  quoteCallData, swapCallData, decodeSwapVmReturn, decodeRevert, findResHolder, balanceOf,
  pickActivePosition, ROUTER_ADDR, AQUA, WSTETH, ONEINCH, ACCESS_TOKEN, TakerTraits,
} from './lib.js';
import {
  createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, pad, toHex,
  parseAbiItem, type Hex,
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
const ERC20_APPROVE = parseAbiItem('function approve(address spender, uint256 amount) returns (bool)');

function revertData(e: any): Hex | undefined {
  let cur = e;
  for (let i = 0; i < 12 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex;
    if (cur.data?.data && typeof cur.data.data === 'string') return cur.data.data as Hex;
    cur = cur.cause;
  }
  const m = String(e?.message || e).match(/0x[0-9a-fA-F]{8,}/);
  return m ? (m[0] as Hex) : undefined;
}
/** Decode a standard Error(string) revert (0x08c379a0) if present. */
function decodeErrorString(data?: Hex): string | undefined {
  if (!data || !data.startsWith('0x08c379a0')) return undefined;
  try {
    const hex = data.slice(2 + 8 + 64 + 64);
    const len = parseInt(data.slice(2 + 8 + 64, 2 + 8 + 128), 16);
    return Buffer.from(hex.slice(0, len * 2), 'hex').toString('utf8');
  } catch { return undefined; }
}

async function fundErc20(token: string, holder: string, amount: bigint): Promise<void> {
  for (let slot = 0; slot < 200; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder as `0x${string}`, BigInt(slot)])) as Hex;
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })]);
    if ((await balanceOf(pub, token, holder)) === amount) return;
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(0n), { size: 32 })]);
  }
  throw new Error(`no balanceOf slot for ${token}`);
}

async function quoteOut(order: any, taker: string, amountIn: bigint, block: bigint): Promise<bigint> {
  const data = quoteCallData({ order, tokenIn: WSTETH, tokenOut: ONEINCH, amount: amountIn, takerTraits: TakerTraits.default() });
  const r = await pub.call({ account: taker as `0x${string}`, to: ROUTER_ADDR.toString() as `0x${string}`, data, blockNumber: block });
  return decodeSwapVmReturn((r.data ?? '0x') as Hex).amountOut;
}

async function trySwap(order: any, taker: string, amountIn: bigint): Promise<{ ok: boolean; note: string }> {
  const sData = swapCallData({ order, tokenIn: WSTETH, tokenOut: ONEINCH, amount: amountIn, takerTraits: TakerTraits.default() });
  try {
    await pub.call({ account: taker as `0x${string}`, to: ROUTER_ADDR.toString() as `0x${string}`, data: sData });
  } catch (e: any) {
    const rd = revertData(e);
    const str = decodeErrorString(rd);
    const dec = decodeRevert(rd);
    return { ok: false, note: str ? `Error("${str}")` : `${dec.selector} ${dec.signature ?? ''}`.trim() };
  }
  const before = await balanceOf(pub, ONEINCH, taker);
  const h = await wallet.sendTransaction({ account: taker as `0x${string}`, to: ROUTER_ADDR.toString() as `0x${string}`, data: sData });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  const delta = (await balanceOf(pub, ONEINCH, taker)) - before;
  return { ok: rc.status === 'success', note: `delivered ${delta} 1INCH` };
}

async function main() {
  console.log('Overdraft Honesty Probe — STEP 4: PHANTOM FILL on a REAL position\n');
  const block = await pub.getBlockNumber();
  console.log('anvil fork block:', block.toString());

  const pos = await pickActivePosition(pub, WSTETH, ONEINCH, block);
  if (!pos) { console.log('No ACTIVE wstETH/1INCH position; re-run.'); return; }
  const order = pos.order;
  const taker = await findResHolder(pub, block);
  const maker = pos.maker;

  const makerReal = await balanceOf(pub, ONEINCH, maker, block);
  console.log('REAL position:', pos.strategyHash);
  console.log('  maker             :', maker);
  console.log('  maker REAL 1INCH  :', makerReal.toString(), `(${(Number(makerReal) / 1e18).toFixed(0)} 1INCH)`);
  console.log('  virtual committed :', pos.committedB.toString(), `(${(Number(pos.committedB) / 1e18).toExponential(3)} 1INCH quoted depth)`);
  console.log('  over-commit factor:', (Number(pos.committedB) / Number(makerReal)).toExponential(2), '× the maker\'s real balance');
  console.log('  taker(RES holder) :', taker, ' RES:', (await balanceOf(pub, ACCESS_TOKEN, taker, block)).toString());

  // Setup taker with plenty of wstETH + router approval.
  await rpc('anvil_impersonateAccount', [taker]);
  await rpc('anvil_setBalance', [taker, toHex(10n ** 18n)]);
  await fundErc20(WSTETH, taker, 1000n * 10n ** 18n); // 1000 wstETH
  const ah = await wallet.writeContract({ account: taker as `0x${string}`, address: WSTETH as `0x${string}`, abi: [ERC20_APPROVE], functionName: 'approve', args: [ROUTER_ADDR.toString() as `0x${string}`, 1000n * 10n ** 18n] });
  await pub.waitForTransactionReceipt({ hash: ah });
  console.log('  taker funded 1000 wstETH + approved router\n');

  // The maker's real balance drifts as it trades live, so size the two swaps RELATIVE
  // to its CURRENT real 1INCH balance: BACKED targets ~40% of it, PHANTOM targets ~140%.
  // Binary-search the wstETH input whose quoted 1INCH out ≈ a target.
  const findInFor = async (targetOut: bigint): Promise<{ amountIn: bigint; out: bigint }> => {
    let lo = 10n ** 12n, hi = 1000n * 10n ** 18n; // 1e-6 .. 1000 wstETH
    let best = { amountIn: lo, out: await quoteOut(order, taker, lo, block) };
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2n;
      let out: bigint;
      try { out = await quoteOut(order, taker, mid, block); } catch { hi = mid; continue; }
      best = { amountIn: mid, out };
      if (out < targetOut) lo = mid; else hi = mid;
      if (hi - lo < 10n ** 9n) break;
    }
    return best;
  };
  const backedTarget = makerReal * 40n / 100n;
  const phantomTarget = makerReal * 140n / 100n;
  const backed = await findInFor(backedTarget);
  const phantom = await findInFor(phantomTarget);
  const backedIn = backed.amountIn;
  const phantomIn = phantom.amountIn;

  line();
  console.log('BACKED swap — quoted out WITHIN the maker\'s real balance:');
  const qB = backed.out;
  console.log(`  in=${(Number(backedIn) / 1e18).toFixed(4)} wstETH  amountOut_quoted=${qB} (${(Number(qB) / 1e18).toFixed(0)} 1INCH)  <= real ${(Number(makerReal) / 1e18).toFixed(0)}`);
  const rB = await trySwap(order, taker, backedIn);
  console.log(`  execute -> ${rB.ok ? '✅ SUCCESS' : '❌ REVERT'}: ${rB.note}`);

  line();
  console.log('PHANTOM swap — quoted out EXCEEDS the maker\'s real balance (but within virtual depth):');
  const qP = phantom.out;
  console.log(`  in=${(Number(phantomIn) / 1e18).toFixed(4)} wstETH  amountOut_quoted=${qP} (${(Number(qP) / 1e18).toFixed(0)} 1INCH)  >  real ${(Number(makerReal) / 1e18).toFixed(0)}`);
  console.log('  the quote HAPPILY returns this — it is a phantom (virtual) fill.');
  const rP = await trySwap(order, taker, phantomIn);
  console.log(`  execute -> ${rP.ok ? '✅ SUCCESS (unexpected)' : '❌ REVERT (as predicted)'}: ${rP.note}`);

  line();
  console.log('VERDICT:');
  console.log(`  Quote quotes ${(Number(qP) / 1e18).toFixed(0)} 1INCH of depth the maker cannot deliver`);
  console.log(`  (real balance ${(Number(makerReal) / 1e18).toFixed(0)} 1INCH). The on-chain swap ${rP.ok ? 'DID NOT revert' : 'REVERTS'} —`);
  console.log(`  the phantom depth is unfillable: ${rP.note}`);
  console.log('\nPHANTOM_RESULT_JSON=' + JSON.stringify({
    strategyHash: pos.strategyHash, maker, forkBlock: block.toString(),
    makerReal1INCH: makerReal.toString(), virtualCommitted1INCH: pos.committedB.toString(),
    backed: { amountIn: backedIn.toString(), quoted: qB.toString(), executed: rB.ok, note: rB.note },
    phantom: { amountIn: phantomIn.toString(), quoted: qP.toString(), executed: rP.ok, revertNote: rP.note },
  }));
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
