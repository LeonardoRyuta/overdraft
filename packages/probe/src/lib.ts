/**
 * Overdraft Honesty Probe — shared library.
 *
 * Recovers a REAL live 1inch Aqua/SwapVM position's full `Order` preimage from the
 * on-chain `Shipped` event (Agent E's proven approach), and exposes helpers to build
 * quote / swap calldata and decode SwapVM results & custom-error reverts.
 *
 * ZERO credentials: enumeration via keyless Blockscout decoded-logs; hashing local.
 * Run under tsx (swap-vm-sdk ESM has an extensionless import native Node can't resolve).
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
import {
  keccak256,
  toBytes,
  createPublicClient,
  http,
  decodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';

export const AQUA = '0x1111113ccf1426a8e30e2bff5e005d929bf6a90a' as const;
export const SWAPVM_ROUTER = '0x111111338c5091E8440b67B168bAe16a668AC0De' as const;
export const ROUTER_ADDR = AQUA_SWAP_VM_CONTRACT_ADDRESSES[NetworkEnum.ETHEREUM];
export const BLOCKSCOUT = 'https://eth.blockscout.com';
export const PUBLIC_RPC = 'https://ethereum-rpc.publicnode.com';

export const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
export const ONEINCH = '0x111111111117dC0aa78b770fA6A738034120C302';
export const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
/** SwapVM "Access Token" ERC-721 (symbol RES) gated by opcode 0x21 OnlyTxOriginTokenBalanceNonZero. */
export const ACCESS_TOKEN = '0x26FFc7D378E8e49Be2c483295A3e3E511F96a468';

export type Shipped = {
  block: number;
  tx: string;
  maker: string;
  strategyHash: string;
  strategy: Hex;
  tokens: string[];
};

/** Enumerate live SwapVM Shipped positions (app == router) via keyless Blockscout. */
export async function fetchSwapVmPositions(maxPages = 8): Promise<Shipped[]> {
  const out: Shipped[] = [];
  const pushed = new Map<string, string[]>();
  let params: Record<string, string> | null = null;
  const base = `${BLOCKSCOUT}/api/v2/addresses/${AQUA}/logs`;
  for (let p = 0; p < maxPages; p++) {
    const url = params ? `${base}?${new URLSearchParams(params)}` : base;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) break;
    const json: any = await res.json();
    for (const it of json.items || []) {
      const d = it.decoded;
      if (!d) continue;
      const m = String(d.method_call);
      const pr: any = Object.fromEntries(d.parameters.map((x: any) => [x.name, x.value]));
      if (m.startsWith('Pushed')) {
        const k = String(pr.strategyHash).toLowerCase();
        if (!pushed.has(k)) pushed.set(k, []);
        pushed.get(k)!.push(String(pr.token).toLowerCase());
      } else if (m.startsWith('Shipped') && String(pr.app).toLowerCase() === SWAPVM_ROUTER.toLowerCase()) {
        out.push({
          block: it.block_number,
          tx: it.transaction_hash,
          maker: pr.maker,
          strategyHash: pr.strategyHash,
          strategy: pr.strategy as Hex,
          tokens: [],
        });
      }
    }
    if (!json.next_page_params) break;
    params = json.next_page_params;
  }
  // attach unique token set per position
  for (const s of out) {
    const toks = pushed.get(s.strategyHash.toLowerCase()) || [];
    s.tokens = [...new Set(toks)];
  }
  return out;
}

/** Verify a Shipped blob reproduces its on-chain strategyHash 3 ways, and return the Order. */
export function recoverOrder(shipped: Shipped) {
  const target = shipped.strategyHash.toLowerCase();
  const candA = keccak256(shipped.strategy).toLowerCase();
  const ord = Order.decode(shipped.strategy);
  const candB = ord.hash().toString().toLowerCase();
  const reEnc = ord.encode().toString().toLowerCase();
  const reEncIdentical = reEnc === shipped.strategy.toLowerCase();
  return {
    order: ord,
    verified: candA === target && candB === target && reEncIdentical,
    candA,
    candB,
    reEncIdentical,
  };
}

/** Decode Order fields + program instructions for reporting. */
export function describeOrder(ord: any) {
  const built = ord.build();
  const traits = built.traits as bigint;
  const mt = MakerTraits.decode(traits);
  const instructions: any[] = [];
  try {
    const b = AquaProgramBuilder.decode(ord.program);
    for (const ix of b.getInstructions()) {
      let args: any;
      try { args = ix.args?.toJSON ? ix.args.toJSON() : ix.args; } catch { args = '<unserializable>'; }
      instructions.push({ type: ix.constructor?.name, args });
    }
  } catch (e) {
    instructions.push({ error: String(e).slice(0, 200) });
  }
  return {
    maker: ord.maker.toString(),
    traits: '0x' + traits.toString(16),
    useAquaInsteadOfSignature: mt.useAquaInsteadOfSignature,
    instructions,
  };
}

export type QuoteArgsIn = {
  order: any;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  takerTraits: any;
};

export function quoteCallData(a: QuoteArgsIn): Hex {
  return SwapVMContract.encodeQuoteCallData({
    order: a.order,
    tokenIn: new Address(a.tokenIn),
    tokenOut: new Address(a.tokenOut),
    amount: a.amount,
    takerTraits: a.takerTraits,
  }).toString() as Hex;
}

export function swapCallData(a: QuoteArgsIn): Hex {
  return SwapVMContract.encodeSwapCallData({
    order: a.order,
    tokenIn: new Address(a.tokenIn),
    tokenOut: new Address(a.tokenOut),
    amount: a.amount,
    takerTraits: a.takerTraits,
  }).toString() as Hex;
}

/** quote/swap both return (uint256 amountIn, uint256 amountOut, bytes32 orderHash). */
export function decodeSwapVmReturn(ret: Hex): { amountIn: bigint; amountOut: bigint; orderHash: Hex } {
  const [amountIn, amountOut, orderHash] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    ret,
  ) as [bigint, bigint, Hex];
  return { amountIn, amountOut, orderHash };
}

/** Known SwapVM custom-error dictionary → {selector: signature}, computed from source. */
export const ERROR_SIGS: string[] = [
  'BadSignature(address,bytes32,bytes)',
  'AquaBalanceInsufficientAfterTakerPush(uint256,uint256,uint256)',
  'MakerTraitsUnwrapIsIncompatibleWithAqua()',
  'MakerTraitsCustomReceiverIsIncompatibleWithAqua()',
  'MsgValueInvalidToken()', 'NotEnoughMsgValueAttached()', 'UnexpectedMsgValue()', 'EthTransferFailed()',
  'InstructionRevert(bytes)', 'DeadlineReached(uint256)', 'RunLoopExceedProgramLength(uint256,uint256)',
  'TakerTokenBalanceIsZero(address,address)', 'TxOriginTokenBalanceIsZero(address,address)',
  'TakerTokenBalanceIsLessThanRequired(address,address,uint256,uint256)',
  'TakerTokenBalanceSupplyShareWrongShare(uint64)',
  'TakerTokenBalanceSupplyShareIsLessThanRequired(address,address,uint256,uint256,uint64)',
  'RequireMinRateFailed(uint256,uint256,uint256,uint256)',
  'ConcentrateInvalidPriceBounds(uint256,uint256)', 'ConcentrateSpotOutOfRange(uint256,uint256,uint256)',
  'DynamicBalancesReachZero()',
  'TakerTraitsMissingTraits()', 'TakerTraitsMissingHookData()',
  'TakerTraitsMissingHasPreTransferInFlag()', 'TakerTraitsMissingHasPreTransferOutFlag()',
  'TakerTraitsThresholdLengthInvalid(bytes)',
  'TakerTraitsNonExactThresholdAmountIn(uint256,uint256)', 'TakerTraitsNonExactThresholdAmountOut(uint256,uint256)',
  'TakerTraitsInsufficientMinOutputAmount(uint256,uint256)', 'TakerTraitsAmountOutMustBeGreaterThanZero(uint256)',
  'TakerTraitsExceedingMaxInputAmount(uint256,uint256)',
  'TakerTraitsTakerAmountInMismatch(uint256,uint256)', 'TakerTraitsTakerAmountOutMismatch(uint256,uint256)',
  'TakerTraitsTakerAmountInExceed(uint256,uint256)', 'TakerTraitsTakerAmountOutExceed(uint256,uint256)',
  'TakerTraitsDeadlineExpired()',
  'UnknownOpcode(uint256)',
  'InvalidateBitAlreadySet(address,uint256,uint256)',
  'InvalidateTokenInExceeded(uint256,uint256,uint256)', 'InvalidateTokenOutExceeded(uint256,uint256,uint256)',
  'LimitSwapDirectionMismatch()', 'LimitSwapAmountShouldCoverBalance(uint256,uint256)',
  'FeeProtocolNoFeeFlagsSet()', 'FeeProtocolBadTarget()', 'FeeProtocolExceedMaxCount()',
  'FeeBpsOutOfRange(uint256,uint256)', 'FeeBpsOutOfRange(uint24)', 'FeeMetaSurplusScaleUp()',
  'MakerTraitsMissingHookData()', 'MakerTraitsMissingHookTarget()', 'MakerTraitsTokensNotSorted()',
  'MakerTraitsZeroAmountInNotAllowed()',
  'PeggedSwapMathNoSolution()', 'PeggedSwapMathInvalidInput()',
  'ExtructionChoppedExceedsLength(bytes,uint256)',
  // Aqua-level (0x1111113ccf…) errors
  'SafeBalancesForTokenNotInActiveStrategy(address,address,bytes32,address)',
  'PushToNonActiveStrategyPrevented(address,address,bytes32,address)',
  'MaxNumberOfTokensExceeded(uint8,uint8)',
  // solidity-utils SafeERC20 wrappers (thrown when maker/taker transferFrom fails on backing)
  'SafeTransferFromFailed()', 'SafeTransferFailed()',
  // solidity Error(string) is 0x08c379a0 (decoded separately by callers)
  // 4byte collision on the access-gate path (this IS what OZ ERC-721 balanceOf(0) reverts):
  'ERC721InvalidOwner(address)',
];

export function errorTable(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of ERROR_SIGS) {
    const sel = keccak256(toBytes(s)).slice(0, 10);
    if (!m.has(sel)) m.set(sel, s);
  }
  return m;
}

/** Decode a revert payload → {selector, signature?, args?}. */
export function decodeRevert(data: Hex | undefined) {
  if (!data || data.length < 10) return { selector: data ?? '0x', signature: undefined, args: undefined };
  const selector = data.slice(0, 10);
  const sig = errorTable().get(selector);
  let args: any = undefined;
  if (sig) {
    const inside = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const types = inside ? inside.split(',').map((t) => ({ type: t.trim() })) : [];
    if (types.length) {
      try { args = decodeAbiParameters(types as any, ('0x' + data.slice(10)) as Hex); } catch { args = '<undecodable>'; }
    }
  }
  return { selector, signature: sig, args };
}

export function makeClient(rpc: string = PUBLIC_RPC) {
  return createPublicClient({ chain: mainnet, transport: http(rpc) });
}

const RAWBAL_SEL = keccak256(toBytes('rawBalances(address,address,bytes32,address)')).slice(2, 10);

/** rawBalances(maker, router, strategyHash, token) -> {committed, tokensCount}. Never reverts. */
export async function rawBalances(client: any, maker: string, strategyHash: string, token: string, blockNumber?: bigint) {
  const data = ('0x' + RAWBAL_SEL
    + '000000000000000000000000' + maker.slice(2)
    + '000000000000000000000000' + SWAPVM_ROUTER.slice(2).toLowerCase()
    + strategyHash.slice(2)
    + '000000000000000000000000' + token.slice(2)) as Hex;
  const r = await client.call({ to: AQUA as `0x${string}`, data, ...(blockNumber ? { blockNumber } : {}) });
  const d = (r.data ?? '0x') as Hex;
  const committed = BigInt('0x' + d.slice(2, 66)) & ((1n << 248n) - 1n);
  const tokensCount = Number(BigInt('0x' + d.slice(66, 130)));
  return { committed, tokensCount };
}

/**
 * From all discovered wstETH/1INCH positions, pick one whose Aqua strategy is ACTIVE
 * (tokensCount in [1,254], committed>0 for both tokens) — required for the swap to run.
 * The maker re-ships every block and docks old ones, so most strategyHashes are dead.
 */
export async function pickActivePosition(client: any, tokenA: string, tokenB: string, blockNumber?: bigint) {
  const positions = await fetchSwapVmPositions(12);
  const two = positions.filter((p) => p.tokens.includes(tokenA.toLowerCase()) && p.tokens.includes(tokenB.toLowerCase()));
  for (const p of two) {
    const rec = recoverOrder(p);
    if (!rec.verified) continue;
    const a = await rawBalances(client, p.maker, p.strategyHash, tokenA, blockNumber);
    const b = await rawBalances(client, p.maker, p.strategyHash, tokenB, blockNumber);
    const active = (n: number) => n >= 1 && n <= 0xfe;
    if (active(a.tokensCount) && active(b.tokensCount) && a.committed > 0n && b.committed > 0n) {
      return { ...p, order: rec.order, committedA: a.committed, committedB: b.committed };
    }
  }
  return null;
}

/** balanceOf(owner) for an ERC-721/20, via raw eth_call (never throws → returns 0n on revert). */
export async function balanceOf(client: any, token: string, owner: string, blockNumber?: bigint): Promise<bigint> {
  const data = ('0x70a08231' + '000000000000000000000000' + owner.slice(2).toLowerCase()) as Hex;
  try {
    const r = await client.call({ to: token as `0x${string}`, data, ...(blockNumber ? { blockNumber } : {}) });
    return BigInt((r.data ?? '0x0') as Hex);
  } catch { return 0n; }
}

/** Find a current holder of the RES access token by scanning its Transfer(mint) logs. */
export async function findResHolder(client: any, blockNumber?: bigint): Promise<string> {
  const res = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${ACCESS_TOKEN}/logs`, { headers: { accept: 'application/json' } });
  const json: any = res.ok ? await res.json() : { items: [] };
  const candidates: string[] = [];
  for (const it of json.items || []) {
    const d = it.decoded;
    if (!d || !String(d.method_call).startsWith('Transfer')) continue;
    const p: any = Object.fromEntries(d.parameters.map((x: any) => [x.name, x.value]));
    const to = p.to || p.To || p._to;
    if (to && to !== '0x0000000000000000000000000000000000000000') candidates.push(to);
  }
  for (const c of candidates) {
    if ((await balanceOf(client, ACCESS_TOKEN, c, blockNumber)) > 0n) return c;
  }
  // fallback: a known holder observed at recon time
  return '0x26A31136e52D3d89B29901e3c4D94594CFc29C85';
}

export { TakerTraits, MakerTraits, Order, Address, encodeFunctionData };
