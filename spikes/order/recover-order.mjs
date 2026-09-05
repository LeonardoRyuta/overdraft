/**
 * Overdraft — Honesty Probe unblock: recover the full `Order` preimage of a REAL
 * live 1inch SwapVM/Aqua position from the on-chain `Shipped` event, VERIFY it
 * reproduces the on-chain `strategyHash`, decode its fields, and prove we can build
 * BOTH quote and swap calldata for it via @1inch/swap-vm-sdk.
 *
 * RUN (from spikes/order, which symlinks ../sdk/node_modules for dep resolution):
 *   npx tsx recover-order.mjs
 *
 * WHY tsx (not plain node): @1inch/swap-vm-sdk@0.4.1's ESM build imports an
 * extensionless path from @1inch/byte-utils that Node's native ESM loader can't
 * resolve. tsx/esbuild bundler-resolution fixes it. (aqua-sdk ESM is unaffected.)
 *
 * ZERO credentials: enumeration via Blockscout keyless decoded-logs API; hashing
 * fully local via viem + the SDK. Every value below is read from live mainnet state.
 *
 * Verified deps: @1inch/swap-vm-sdk@0.4.1  @1inch/aqua-sdk@0.3.1  viem@2.56.3
 */

import {
  Order,
  MakerTraits,
  TakerTraits,
  SwapVMContract,
  AquaProgramBuilder,
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  Address,
} from '@1inch/swap-vm-sdk';
import { NetworkEnum } from '@1inch/sdk-core';
import { keccak256 } from 'viem';

const AQUA = '0x1111113ccf1426a8e30e2bff5e005d929bf6a90a';               // Aqua contract (all chains)
const SWAPVM_ROUTER = '0x111111338c5091E8440b67B168bAe16a668AC0De';       // AquaSwapVMRouter = Aqua "app"
const BLOCKSCOUT = 'https://eth.blockscout.com';

const line = () => console.log('─'.repeat(72));

// --- Step 1: enumerate Shipped events, keep SwapVM positions (app == router) -----
async function fetchSwapVmShipped(maxPages = 6) {
  const found = [];
  const pushedByHash = new Map(); // strategyHash(lower) -> Set(token)
  let url = `${BLOCKSCOUT}/api/v2/addresses/${AQUA}/logs`;
  let params = null;
  for (let page = 0; page < maxPages && found.length < 4; page++) {
    const full = params ? `${url}?${new URLSearchParams(params)}` : url;
    const res = await fetch(full, { headers: { accept: 'application/json' } });
    if (!res.ok) { console.log(`  blockscout page ${page} http ${res.status}`); break; }
    const json = await res.json();
    for (const it of json.items || []) {
      const d = it.decoded;
      if (!d) continue;
      const m = String(d.method_call);
      const p = Object.fromEntries(d.parameters.map((x) => [x.name, x.value]));
      if (m.startsWith('Pushed')) {
        const k = String(p.strategyHash).toLowerCase();
        if (!pushedByHash.has(k)) pushedByHash.set(k, new Set());
        pushedByHash.get(k).add(String(p.token).toLowerCase());
      } else if (m.startsWith('Shipped')) {
        if (String(p.app).toLowerCase() === SWAPVM_ROUTER.toLowerCase()) {
          found.push({
            block: it.block_number,
            tx: it.transaction_hash,
            maker: p.maker,
            app: p.app,
            strategyHash: p.strategyHash,
            strategy: p.strategy,
          });
        }
      }
    }
    console.log(`  page ${page}: ${json.items?.length ?? 0} logs, cumulative SwapVM Shipped=${found.length}`);
    if (!json.next_page_params) break;
    params = json.next_page_params;
  }
  return { found, pushedByHash };
}

// --- Step 2: verify a candidate reproduces the on-chain strategyHash --------------
function verifyRecovery(shipped) {
  const { strategy, strategyHash } = shipped;
  const target = strategyHash.toLowerCase();

  // Candidate A: the Shipped `strategy` bytes ARE abi.encode(Order); hash = keccak256(strategy).
  const candA = keccak256(strategy).toLowerCase();

  // Candidate B: reconstruct via SDK, then Order.hash() (Aqua mode = keccak256(encode())).
  const ord = Order.decode(strategy);
  const candB = ord.hash().toString().toLowerCase();

  // Candidate C: SDK re-encode must be byte-identical to the on-chain strategy blob.
  // NB: ord.encode() returns a HexString class instance; viem's keccak256 needs a
  // plain 0x-string, so call .toString() before hashing.
  const reEnc = ord.encode().toString().toLowerCase();
  const reEncMatches = reEnc === strategy.toLowerCase();
  const candC = keccak256(ord.encode().toString()).toLowerCase();

  return {
    ord,
    A_keccakRaw: { hash: candA, match: candA === target },
    B_sdkHash: { hash: candB, match: candB === target },
    C_reEncode: { reEncodeIdentical: reEncMatches, hash: candC, match: candC === target },
  };
}

// --- Step 3: decode Order fields + program instructions ---------------------------
function decodeOrder(ord) {
  const built = ord.build();
  const traitsBig = built.traits;
  // MakerTraits.decode gives the semantic flags (bit 254 = useAquaInsteadOfSignature).
  const mt = MakerTraits.decode(traitsBig);
  const instructions = [];
  try {
    const b = AquaProgramBuilder.decode(ord.program);
    for (const ix of b.getInstructions()) {
      let args;
      try { args = ix.args?.toJSON ? ix.args.toJSON() : ix.args; } catch { args = '<unserializable>'; }
      instructions.push({ type: ix.constructor?.name, args });
    }
  } catch (e) {
    instructions.push({ error: String(e).slice(0, 160) });
  }
  return { maker: ord.maker.toString(), traits: '0x' + traitsBig.toString(16), makerTraits: mt, data: built.data.toString(), program: ord.program.toString(), instructions };
}

// --- Step 4: prove SDK usability — build quote AND swap calldata -------------------
function buildQuoteAndSwap(ord, tokenIn, tokenOut) {
  const router = AQUA_SWAP_VM_CONTRACT_ADDRESSES[NetworkEnum.ETHEREUM]; // 0x1111...c0de
  const args = {
    order: ord,
    tokenIn: new Address(tokenIn),
    tokenOut: new Address(tokenOut),
    amount: 10n ** 16n, // 0.01 tokenIn, arbitrary probe amount (calldata build only, no execution)
    takerTraits: TakerTraits.default(),
  };
  const quoteData = SwapVMContract.encodeQuoteCallData(args).toString();
  const swapData = SwapVMContract.encodeSwapCallData(args).toString();
  const hashData = SwapVMContract.encodeHashOrderCallData(ord).toString();
  const c = new SwapVMContract(router);
  const quoteTx = c.quote(args); // { to, data, value } — ready to eth_call
  const swapTx = c.swap(args);
  return {
    router: router.toString(),
    quoteSelector: quoteData.slice(0, 10),
    swapSelector: swapData.slice(0, 10),
    hashSelector: hashData.slice(0, 10),
    quoteBytes: (quoteData.length - 2) / 2,
    swapBytes: (swapData.length - 2) / 2,
    allDistinct: new Set([quoteData.slice(0, 10), swapData.slice(0, 10), hashData.slice(0, 10)]).size === 3,
    quoteTxTo: quoteTx.to,
    swapTxTo: swapTx.to,
  };
}

async function main() {
  console.log('Overdraft — recover + verify Order preimage from live Aqua Shipped events\n');
  console.log('Aqua contract :', AQUA);
  console.log('SwapVM router :', SWAPVM_ROUTER, '(the Aqua "app" for SwapVM positions)\n');

  line();
  console.log('STEP 1 — enumerate live SwapVM Shipped events (Blockscout, keyless)');
  const { found, pushedByHash } = await fetchSwapVmShipped();
  console.log(`  -> ${found.length} SwapVM Shipped event(s) captured\n`);
  if (found.length === 0) { console.log('No SwapVM Shipped events found on the scanned pages. Aborting.'); return; }

  let anyVerified = false;
  for (const shipped of found.slice(0, 2)) {
    line();
    console.log(`STEP 2 — VERIFY recovery for strategyHash ${shipped.strategyHash}`);
    console.log(`  maker=${shipped.maker}  block=${shipped.block}`);
    console.log(`  strategy(bytes)=${(shipped.strategy.length - 2) / 2} bytes`);
    const v = verifyRecovery(shipped);
    console.log(`  (A) keccak256(strategy raw)          = ${v.A_keccakRaw.hash}  ${v.A_keccakRaw.match ? '✅ MATCH' : '❌'}`);
    console.log(`  (B) Order.decode(strategy).hash()    = ${v.B_sdkHash.hash}  ${v.B_sdkHash.match ? '✅ MATCH' : '❌'}`);
    console.log(`  (C) SDK re-encode == strategy bytes  = ${v.C_reEncode.reEncodeIdentical ? '✅ identical' : '❌ differs'}`);
    console.log(`      keccak256(order.encode())        = ${v.C_reEncode.hash}  ${v.C_reEncode.match ? '✅ MATCH' : '❌'}`);
    const verified = v.A_keccakRaw.match && v.B_sdkHash.match && v.C_reEncode.match;
    console.log(`  RECOVERY VERIFIED: ${verified ? 'YES ✅' : 'NO ❌'}`);
    if (!verified) continue;
    anyVerified = true;

    line();
    console.log('STEP 3 — decode Order fields + program');
    const dec = decodeOrder(v.ord);
    console.log('  maker  =', dec.maker);
    console.log('  traits =', dec.traits);
    console.log('  useAquaInsteadOfSignature =', dec.makerTraits.useAquaInsteadOfSignature);
    console.log('  program instructions:');
    for (const ix of dec.instructions) console.log('    -', ix.type ?? '(err)', JSON.stringify(ix.args ?? ix.error));

    // Cross-check tokens: Pushed events establish the position's tokens.
    const pushTokens = [...(pushedByHash.get(shipped.strategyHash.toLowerCase()) || [])];
    console.log('  Pushed tokens (cross-check):', pushTokens.length ? pushTokens.join(', ') : '(none on scanned pages)');

    line();
    console.log('STEP 4 — build QUOTE + SWAP calldata from the recovered Order');
    // Use the position's own tokens if we have >=2 from Pushed; else fall back to WETH/USDC.
    const tIn = pushTokens[0] ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const tOut = pushTokens[1] ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const built = buildQuoteAndSwap(v.ord, tIn, tOut);
    console.log('  tokenIn / tokenOut =', tIn, '/', tOut);
    console.log('  quote selector =', built.quoteSelector, `(${built.quoteBytes} bytes calldata)`);
    console.log('  swap  selector =', built.swapSelector, `(${built.swapBytes} bytes calldata)`);
    console.log('  hash  selector =', built.hashSelector);
    console.log('  all three selectors distinct =', built.allDistinct);
    console.log('  quote tx -> to =', built.quoteTxTo);
    console.log('  swap  tx -> to =', built.swapTxTo);
    console.log('  => QUOTE and SWAP calldata both built from the SAME recovered Order ✅');
  }

  line();
  console.log(anyVerified
    ? '\nRESULT: reproduced a REAL on-chain strategyHash from the Shipped blob and built quote+swap calldata. ✅'
    : '\nRESULT: could NOT reproduce a strategyHash — see mismatches above. ❌');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
