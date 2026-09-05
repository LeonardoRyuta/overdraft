// Chain config: viem chain, RPC fallbacks (verified reachable 2026-09-04), and the
// keyless Blockscout base used for log enumeration where public RPCs gate eth_getLogs.
import { mainnet, base, arbitrum } from "viem/chains";

// Aqua core registry — deterministic same address across all 16 chains (verified).
export const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
// SwapVM router (the Aqua "app" for SwapVM positions) — confirmed on-chain.
export const SWAPVM_ROUTER = "0x111111338c5091E8440b67B168bAe16a668AC0De";

export const CHAINS = {
  ethereum: {
    viemChain: mainnet,
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    blockscout: "https://eth.blockscout.com",
    aquaStartBlock: 25567141,
  },
  base: {
    viemChain: base,
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    blockscout: "https://base.blockscout.com",
  },
  arbitrum: {
    viemChain: arbitrum,
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    blockscout: "https://arbitrum.blockscout.com",
  },
};

export const AQUA_READ_ABI = [{
  type: "function", name: "rawBalances", stateMutability: "view",
  inputs: [{ name: "maker", type: "address" }, { name: "app", type: "address" },
    { name: "strategyHash", type: "bytes32" }, { name: "token", type: "address" }],
  outputs: [{ name: "balance", type: "uint248" }, { name: "tokensCount", type: "uint8" }],
}];

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
