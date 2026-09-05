/**
 * STEP 1 — Successful quote on a LIVE mainnet eth_call, and identification of 0x89c62b64.
 *
 * Recovers a real Order from an on-chain Shipped event, builds quote calldata, and
 * eth_calls the SwapVM router on live mainnet. Demonstrates:
 *   (a) with NO `from` (tx.origin = address(0))  -> revert 0x89c62b64  (the blocker)
 *   (b) with a `from` that lacks the RES access token -> revert 0x39c4052c TxOriginTokenBalanceIsZero
 *   (c) with a `from` that HOLDS the RES access token   -> quote RETURNS (amountIn, amountOut)
 *
 * ROOT CAUSE of 0x89c62b64: the order's program begins with opcode 0x21
 * (OnlyTxOriginTokenBalanceNonZero) gating on the SwapVM "Access Token" ERC-721
 * (0x26FFc7D3…, symbol RES). balanceOf(address(0)) on that OZ ERC-721 reverts with
 * ERC721InvalidOwner(address) whose selector is 0x89c62b64. So 0x89c62b64 is NOT an
 * amount/deadline/rate guard — it is the access-gate tripping on a zero tx.origin.
 *
 * Run: npx tsx src/quote.ts
 */
import {
  fetchSwapVmPositions, recoverOrder, describeOrder, quoteCallData, decodeSwapVmReturn,
  decodeRevert, makeClient, ROUTER_ADDR, PUBLIC_RPC, TakerTraits,
  WSTETH, ONEINCH, findResHolder, ACCESS_TOKEN,
} from './lib.js';
import type { Hex } from 'viem';

const line = () => console.log('─'.repeat(76));

function revertData(e: any): Hex | undefined {
  let cur = e;
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex;
    if (cur.data?.data && typeof cur.data.data === 'string') return cur.data.data as Hex;
    cur = cur.cause;
  }
  const m = String(e?.message || e).match(/0x[0-9a-fA-F]{8,}/);
  return m ? (m[0] as Hex) : undefined;
}

async function quoteCall(client: any, order: any, blockNumber: bigint, cfg: {
  from?: string; tokenIn: string; tokenOut: string; amount: bigint; takerTraits: any;
}) {
  const data = quoteCallData({ order, tokenIn: cfg.tokenIn, tokenOut: cfg.tokenOut, amount: cfg.amount, takerTraits: cfg.takerTraits });
  try {
    const res = await client.call({
      ...(cfg.from ? { account: cfg.from as `0x${string}` } : {}),
      to: ROUTER_ADDR.toString() as `0x${string}`, data, blockNumber,
    });
    return { ok: true as const, ...decodeSwapVmReturn((res.data ?? '0x') as Hex) };
  } catch (e: any) {
    return { ok: false as const, decoded: decodeRevert(revertData(e)) };
  }
}

async function main() {
  console.log('Overdraft Honesty Probe — STEP 1: live quote + identify 0x89c62b64\n');
  const client = makeClient(PUBLIC_RPC);
  const blockNumber = await client.getBlockNumber();
  console.log('RPC   :', PUBLIC_RPC);
  console.log('block :', blockNumber.toString());
  console.log('router:', ROUTER_ADDR.toString());

  const positions = await fetchSwapVmPositions();
  const pick = positions.find(
    (p) => p.tokens.includes(WSTETH.toLowerCase()) && p.tokens.includes(ONEINCH.toLowerCase()),
  ) ?? positions[0];

  line();
  console.log('POSITION (real, live)');
  console.log('  maker        :', pick.maker);
  console.log('  strategyHash :', pick.strategyHash);
  console.log('  ship block   :', pick.block, ' tokens:', pick.tokens.join(', '));
  const rec = recoverOrder(pick);
  console.log('  recovery verified (keccak256(strategy)==strategyHash, 3 ways):', rec.verified);
  const order = rec.order;
  for (const ix of describeOrder(order).instructions) console.log('     -', ix.type ?? '(err)', JSON.stringify(ix.args ?? ix.error));

  const jitter = { tokenIn: WSTETH, tokenOut: ONEINCH, amount: 10n ** 16n, takerTraits: TakerTraits.default() };

  line();
  console.log('THE BLOCKER — 0x89c62b64, identified empirically\n');

  const noFrom = await quoteCall(client, order, blockNumber, jitter);
  console.log('  (a) no `from` (tx.origin=0):');
  console.log('      ->', noFrom.ok ? 'OK' : JSON.stringify(noFrom.decoded, bj));

  const noRes = await quoteCall(client, order, blockNumber, { ...jitter, from: '0x28C6c06298d514Db089934071355E5743bf21d60' });
  console.log('  (b) `from` = Binance hot wallet (no RES access token):');
  console.log('      ->', noRes.ok ? 'OK' : JSON.stringify(noRes.decoded, bj));

  console.log('\n  Access token (opcode 0x21 gate):', ACCESS_TOKEN, '(ERC-721 "Access Token for SwapVM v3.1.2", symbol RES)');
  console.log('  0x89c62b64 == ERC721InvalidOwner(address) — OZ ERC-721 balanceOf(address(0)) revert.');

  line();
  console.log('THE FIX — set tx.origin to a RES access-token holder, then quote succeeds\n');
  const resHolder = await findResHolder(client, blockNumber);
  console.log('  RES holder (tx.origin):', resHolder);

  const amounts = [
    { a: 10n ** 15n, s: '0.001 wstETH' },
    { a: 10n ** 16n, s: '0.01 wstETH' },
    { a: 10n ** 17n, s: '0.1 wstETH' },
  ];
  let best: any = null;
  for (const am of amounts) {
    const r = await quoteCall(client, order, blockNumber, { ...jitter, from: resHolder, amount: am.a });
    if (r.ok) {
      console.log(`  ✅ wstETH->1INCH  in=${am.s.padEnd(12)}  amountIn=${r.amountIn}  amountOut=${r.amountOut}`);
      if (!best) best = { ...r, amount: am.a };
    } else {
      console.log(`  ❌ ${am.s}  ${JSON.stringify(r.decoded, bj)}`);
    }
  }
  // reverse direction too
  const rev = await quoteCall(client, order, blockNumber, { from: resHolder, tokenIn: ONEINCH, tokenOut: WSTETH, amount: 100n * 10n ** 18n, takerTraits: TakerTraits.default() });
  if (rev.ok) console.log(`  ✅ 1INCH->wstETH  in=100 1INCH     amountIn=${rev.amountIn}  amountOut=${rev.amountOut}`);

  line();
  if (best) {
    console.log('TUNED QUOTE PARAMS THAT WORKED:');
    console.log('  from(tx.origin) :', resHolder, '(holds RES access token)');
    console.log('  tokenIn/tokenOut:', WSTETH, '/', ONEINCH);
    console.log('  amount          :', best.amount.toString(), '(exactIn, TakerTraits.default(), threshold=0)');
    console.log('  amountOut_quoted:', best.amountOut.toString());
    console.log('  orderHash       :', best.orderHash);
    console.log('  block           :', blockNumber.toString());
    console.log('\nQUOTE_RESULT_JSON=' + JSON.stringify({
      strategyHash: pick.strategyHash, maker: pick.maker, resHolder,
      tokenIn: WSTETH, tokenOut: ONEINCH,
      amountIn: best.amountIn.toString(), amountOut: best.amountOut.toString(),
      orderHash: best.orderHash, block: blockNumber.toString(),
    }));
  }
}

function bj(_k: string, v: any) { return typeof v === 'bigint' ? v.toString() : v; }
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
