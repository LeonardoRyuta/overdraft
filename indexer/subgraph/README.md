# Overdraft subgraph — Aqua quoted-depth index

Indexes the Aqua registry (`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`) events
`Shipped` / `Pushed` / `Pulled` / `Docked` (all non-indexed) to enumerate every
position and reconstruct each commitment's **committed (virtual) balance**. This
is the *quoted* side of coverage; the *backed* side (wallet ∩ allowance) is live
ERC-20 state the coverage engine overlays via `eth_call`.

**Status (Day 1):** builds clean (`graph codegen && graph build`). Not yet
deployed — needs a Subgraph Studio deploy key.

## Deploy (Subgraph Studio — live data, satisfies The Graph requirement)

```bash
cd indexer/subgraph
npm install
npm run codegen && npm run build
# one-time: paste your Subgraph Studio deploy key
npx graph auth <STUDIO_DEPLOY_KEY>
# create the subgraph "overdraft-aqua" in Studio UI first, then:
npx graph deploy overdraft-aqua
```

Then query it live (never from a local node — local/mocked data is a disqualifier):
```graphql
{ commitments(where: { active: true }, orderBy: committed, orderDirection: desc, first: 10) {
    committed maker { id } token { symbol decimals } position { app strategyHash active } } }
```

## Multi-chain

One schema, one mapping, re-pointed per network via `networks.json`. Ethereum is
wired now (startBlock 25567141). Base/Arbitrum/etc. add an entry + `graph deploy`
per network. Firehose-only chains (Robinhood/Monad/HyperEVM — no subgraph support)
are covered by the Substreams module instead (`../substreams`), which is the
"reach the chains subgraphs can't" half of the Composable-track story.

## Design notes / correctness
- `committed` is event-reconstructed (Σ Pushed − Σ Pulled). The coverage engine
  treats live `rawBalances(...)` as source-of-truth and uses this as a cross-check.
- All Aqua events are non-indexed, so the subgraph decodes every log from the
  address — exactly the `eth_getLogs` work public RPCs refuse to do for us.
- `Position.id = maker ++ app ++ strategyHash`; `Commitment.id = Position.id ++ token`.
  For SwapVM positions `app` = the SwapVM router and `strategyHash = keccak256(abi.encode(Order))`.
