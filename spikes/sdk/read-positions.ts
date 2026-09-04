/**
 * Overdraft SDK spike: read a maker's Aqua positions + virtual balances,
 * and prove that QUOTE / SWAP / HASH calldata are separately constructible.
 *
 * RUN WITH tsx (NOT plain `node`):
 *   npx tsx read-positions.ts [makerAddress]
 *
 * WHY tsx and not node:
 *   @1inch/swap-vm-sdk@0.4.1 ships a BROKEN ESM build: its dist/index.mjs does
 *   `import ... from '@1inch/byte-utils/dist/constants'` (no .js extension) and
 *   @1inch/byte-utils has no package "exports" map, so Node's native ESM loader
 *   throws ERR_MODULE_NOT_FOUND. Bundler-style resolvers (tsx/esbuild/vite/next)
 *   and CommonJS `require()` both resolve the extensionless path fine.
 *   (@1inch/aqua-sdk ESM is NOT affected.)
 *
 * Verified against installed versions:
 *   @1inch/aqua-sdk@0.3.1  @1inch/swap-vm-sdk@0.4.1  @1inch/sdk-core@0.1.3  viem@2.56.3
 */

import {
  AquaProtocolContract,
  AQUA_CONTRACT_ADDRESSES,
  ShippedEvent,
  ABI as AQUA_ABI_NS,
} from '@1inch/aqua-sdk';
import {
  SwapVMContract,
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  Order,
  MakerTraits,
  TakerTraits,
  AquaXYCAmmStrategy,
} from '@1inch/swap-vm-sdk';
import { Address, NetworkEnum } from '@1inch/sdk-core';
import { createPublicClient, http, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';

const RPC_URL = process.env.RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const CHAIN = NetworkEnum.ETHEREUM; // 1

// Aqua's ABI is re-exported as a namespace: aqua.ABI.AQUA_ABI
const AQUA_ABI = (AQUA_ABI_NS as unknown as { AQUA_ABI: readonly unknown[] }).AQUA_ABI;

// ---------------------------------------------------------------------------
// A real maker address is REQUIRED to read real positions. We don't have a
// confirmed one yet (public RPCs rate-limit eth_getLogs so on-the-fly discovery
// via Shipped events was not completed in this spike). Pass one as argv[2] or
// set MAKER env var. Placeholder below keeps the script structurally correct.
// ---------------------------------------------------------------------------
const MAKER_PLACEHOLDER = '0x0000000000000000000000000000000000000000';
const makerArg = process.argv[2] ?? process.env.MAKER ?? MAKER_PLACEHOLDER;

async function main() {
  const client: PublicClient = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  // 1) Resolve the on-chain Aqua contract address for this chain.
  const aquaAddr = AQUA_CONTRACT_ADDRESSES[CHAIN];             // 0x1111113ccf...a90a (all chains)
  const routerAddr = AQUA_SWAP_VM_CONTRACT_ADDRESSES[CHAIN];   // 0x111111338c...c0de (all chains)
  const aqua = new AquaProtocolContract(aquaAddr);
  console.log('chain            =', CHAIN, NetworkEnum[CHAIN]);
  console.log('Aqua contract    =', aquaAddr.toString());
  console.log('SwapVM router    =', routerAddr.toString());
  console.log('RPC              =', RPC_URL);

  const bytecode = await client.getBytecode({ address: aquaAddr.toString() as `0x${string}` });
  console.log('Aqua deployed    =', bytecode ? `yes (${(bytecode.length - 2) / 2} bytes)` : 'NO');

  // 2) Discover this maker's positions via Shipped events.
  //    A "position" = (maker, app, strategyHash). Virtual balances are then read
  //    per token via rawBalances(maker, app, strategyHash, token).
  //    NOTE: public RPCs cap eth_getLogs ranges; for production use an archive
  //    node or an indexer. Here we scan a small recent window best-effort.
  const maker = new Address(makerArg);
  if (maker.isZero()) {
    console.log('\n[!] No maker supplied (placeholder 0x0). Pass a real maker:');
    console.log('    npx tsx read-positions.ts 0x<maker>');
    console.log('    Script structure is correct; it just needs a real maker to return data.');
  }

  const positions = await discoverPositions(client, aquaAddr.toString() as `0x${string}`, maker);
  console.log(`\nFound ${positions.length} position(s) for maker ${maker.toString()}`);

  // 3) For each position, read virtual (raw) balances per token.
  for (const p of positions) {
    console.log('\n--- position ---');
    console.log('  app          =', p.app.toString());
    console.log('  strategyHash =', p.strategyHash.toString());
    for (const token of p.tokens) {
      const [balance, tokensCount] = (await client.readContract({
        address: aquaAddr.toString() as `0x${string}`,
        abi: AQUA_ABI as never,
        functionName: 'rawBalances',
        args: [
          maker.toString() as `0x${string}`,
          p.app.toString() as `0x${string}`,
          p.strategyHash.toString() as `0x${string}`,
          token.toString() as `0x${string}`,
        ],
      })) as unknown as [bigint, number];
      console.log(`  rawBalances[${token.toString()}] = ${balance}  (tokensCount=${tokensCount})`);
    }
    // sum(virtual_balances) is the coverage denominator; wallet_balance and
    // aqua_allowance (ERC20 allowance to the Aqua contract) form the numerator.
  }

  // 4) HONESTY PROBE proof: build QUOTE, SWAP and HASH calldata SEPARATELY from
  //    the SAME order. Distinct 4-byte selectors => independently constructible.
  console.log('\n=== Honesty Probe: separate quote / swap / hash calldata ===');
  const program = AquaXYCAmmStrategy.new().build();
  const order = Order.new({ maker, traits: MakerTraits.default(), program });
  const swapInfo = {
    order,
    tokenIn: new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), // WETH
    tokenOut: new Address('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), // USDC
    amount: 10n ** 18n,
    takerTraits: TakerTraits.default(),
  };
  const quoteData = SwapVMContract.encodeQuoteCallData(swapInfo).toString();
  const swapData = SwapVMContract.encodeSwapCallData(swapInfo).toString();
  const hashData = SwapVMContract.encodeHashOrderCallData(order).toString();
  console.log('  quote selector =', quoteData.slice(0, 10));
  console.log('  swap  selector =', swapData.slice(0, 10));
  console.log('  hash  selector =', hashData.slice(0, 10));
  console.log('  order.hash()   =', order.hash().toString());
  console.log('  all three distinct =',
    new Set([quoteData.slice(0, 10), swapData.slice(0, 10), hashData.slice(0, 10)]).size === 3);

  // These CallInfo objects are ready to eth_call for a live honesty probe:
  const c = new SwapVMContract(routerAddr);
  const quoteTx = c.quote(swapInfo); // { to, data, value }
  console.log('  quote tx to    =', quoteTx.to);
  void aqua; // AquaProtocolContract also builds ship/dock calldata (encodeShipCallData/encodeDockCallData)
}

type Position = { app: Address; strategyHash: Address | { toString(): string }; tokens: Address[] };

async function discoverPositions(
  client: PublicClient,
  aquaAddr: `0x${string}`,
  maker: Address,
): Promise<Array<{ app: Address; strategyHash: { toString(): string }; tokens: Address[] }>> {
  if (maker.isZero()) return [];
  const shippedTopic = ShippedEvent.TOPIC.toString() as `0x${string}`;
  const latest = await client.getBlockNumber();
  const span = 10_000n;
  const out: Array<{ app: Address; strategyHash: { toString(): string }; tokens: Address[] }> = [];
  // Best-effort scan of a few recent windows (public RPC range limits apply).
  for (let i = 0n; i < 5n; i++) {
    const toBlock = latest - i * span;
    const fromBlock = toBlock - span + 1n;
    try {
      const logs = await client.getLogs({ address: aquaAddr, fromBlock, toBlock, topics: [shippedTopic] });
      for (const log of logs) {
        // Shipped is fully non-indexed: all fields live in log.data.
        const ev = ShippedEvent.fromLog({ data: log.data, topics: log.topics as never });
        if (ev.maker.toString().toLowerCase() === maker.toString().toLowerCase()) {
          // Token list is not in the Shipped event; derive it from the ship() tx
          // calldata or track Pushed/Pulled events. Left as a follow-up.
          out.push({ app: ev.app, strategyHash: ev.strategyHash, tokens: [] });
        }
      }
    } catch {
      // provider range limit — ignore and continue
    }
  }
  return out;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
