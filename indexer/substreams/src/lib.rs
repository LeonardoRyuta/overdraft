//! Overdraft — Aqua position lifecycle, Substreams edition.
//!
//! Firehose-native twin of `indexer/subgraph/src/aqua.ts`. Same four events,
//! same IDs, same `committed = Σ Pushed − Σ Pulled` reconstruction — but emitted
//! as protobuf so it runs on Firehose-only chains that The Graph's hosted
//! subgraphs can't reach. One module, re-pointed per chain via substreams.yaml.
//!
//! Module graph:
//!   map_events            (block)                 -> pb::Events            [decode the 4 Aqua events]
//!   store_positions       (map_events)            -> Store<PositionState>  [lifecycle + token set]
//!   store_commitments     (map_events)            -> Store<i/bigint>       [running committed depth]
//!   map_entity_changes    (map_events + stores)   -> pb::EntityChanges     [subgraph-shaped upserts]
//!
//! The `committed` here is the QUOTED (event-reconstructed) side of Overdraft
//! coverage. The BACKED side (maker wallet balance ∩ allowance to Aqua) is live
//! ERC-20 state read at query time via eth_call and is intentionally NOT here —
//! see the design note atop schema.graphql.

mod abi;
mod pb;

use std::str::FromStr;

use pb::overdraft::aqua::v1 as pbx;
use substreams::errors::Error;
use substreams::scalar::BigInt;
use substreams::store::{StoreGet, StoreGetProto, StoreNew, StoreSet, StoreSetProto};
use substreams::store::{StoreAdd, StoreAddBigInt, StoreGetBigInt};
use substreams::Hex;
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

// The Aqua registry — same address as the subgraph's dataSource. For a
// different chain, change this and the network/startBlock in substreams.yaml.
const AQUA_CONTRACT: [u8; 20] = hex_literal::hex!("1111113ccf1426a8e30e2bff5e005d929bf6a90a");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// 0x-prefixed lowercase hex for an address/hash byte slice.
fn addr(bytes: &[u8]) -> String {
    format!("0x{}", Hex(bytes).to_string())
}

/// Position id = maker ++ app ++ strategyHash, as 0x-hex.
/// Byte-identical to the subgraph's `maker.concat(app).concat(strategyHash)`.
fn position_id(maker: &[u8], app: &[u8], strategy_hash: &[u8]) -> String {
    let mut v = Vec::with_capacity(maker.len() + app.len() + strategy_hash.len());
    v.extend_from_slice(maker);
    v.extend_from_slice(app);
    v.extend_from_slice(strategy_hash);
    format!("0x{}", Hex(&v).to_string())
}

/// Commitment id = position.id ++ token, as 0x-hex.
/// Mirrors the subgraph's `posId.concat(token)` — posId is raw bytes there, so
/// we concat the raw bytes (not the hex strings) to stay byte-identical.
fn commitment_id(maker: &[u8], app: &[u8], strategy_hash: &[u8], token: &[u8]) -> String {
    let mut v =
        Vec::with_capacity(maker.len() + app.len() + strategy_hash.len() + token.len());
    v.extend_from_slice(maker);
    v.extend_from_slice(app);
    v.extend_from_slice(strategy_hash);
    v.extend_from_slice(token);
    format!("0x{}", Hex(&v).to_string())
}

fn meta_from(block: &eth::Block, log_view: &eth::Log, tx_hash: &[u8]) -> pbx::EventMeta {
    pbx::EventMeta {
        block_number: block.number,
        block_hash: format!("0x{}", Hex(&block.hash).to_string()),
        block_timestamp: block
            .header
            .as_ref()
            .and_then(|h| h.timestamp.as_ref())
            .map(|t| t.seconds as u64)
            .unwrap_or_default(),
        tx_hash: format!("0x{}", Hex(tx_hash).to_string()),
        log_index: log_view.index,
        log_ordinal: log_view.ordinal as u32,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// map_events — decode the four Aqua events in this block, in log order.
// ─────────────────────────────────────────────────────────────────────────────
#[substreams::handlers::map]
fn map_events(block: eth::Block) -> Result<pbx::Events, Error> {
    use abi::aqua::events;

    let mut out = pbx::Events::default();

    // Walk every log emitted by the Aqua contract, preserving on-chain order.
    for tx in block.transaction_traces.iter() {
        for call in tx.calls.iter() {
            for log in call.logs.iter() {
                if log.address != AQUA_CONTRACT {
                    continue;
                }
                let meta = meta_from(&block, log, &tx.hash);

                if let Some(e) = events::Shipped::match_and_decode(log) {
                    out.shipped.push(pbx::ShippedEvent {
                        meta: Some(meta),
                        maker: addr(&e.maker),
                        app: addr(&e.app),
                        strategy_hash: addr(&e.strategy_hash),
                        strategy: format!("0x{}", Hex(&e.strategy).to_string()),
                    });
                } else if let Some(e) = events::Pushed::match_and_decode(log) {
                    out.pushed.push(pbx::PushedEvent {
                        meta: Some(meta),
                        maker: addr(&e.maker),
                        app: addr(&e.app),
                        strategy_hash: addr(&e.strategy_hash),
                        token: addr(&e.token),
                        amount: e.amount.to_string(),
                    });
                } else if let Some(e) = events::Pulled::match_and_decode(log) {
                    out.pulled.push(pbx::PulledEvent {
                        meta: Some(meta),
                        maker: addr(&e.maker),
                        app: addr(&e.app),
                        strategy_hash: addr(&e.strategy_hash),
                        token: addr(&e.token),
                        amount: e.amount.to_string(),
                    });
                } else if let Some(e) = events::Docked::match_and_decode(log) {
                    out.docked.push(pbx::DockedEvent {
                        meta: Some(meta),
                        maker: addr(&e.maker),
                        app: addr(&e.app),
                        strategy_hash: addr(&e.strategy_hash),
                    });
                }
            }
        }
    }

    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// store_commitments — running committed depth per commitment id.
//
// committed = Σ Pushed − Σ Pulled. We use an additive BigInt store: Pushed adds
// +amount, Pulled adds −amount. NOTE: the raw additive store is NOT clamped at
// zero (a store can't conditionally clamp mid-fold), so map_entity_changes
// applies the same clamp-at-zero the subgraph does when it emits `committed`.
// In practice Aqua's immutability + Pull ≤ committed keeps this ≥ 0 anyway;
// the clamp is defensive, matching aqua.ts handlePulled.
// ─────────────────────────────────────────────────────────────────────────────
#[substreams::handlers::store]
fn store_commitments(events: pbx::Events, store: StoreAddBigInt) {
    for e in events.pushed.iter() {
        let key = key_commitment_from_strings(&e.maker, &e.app, &e.strategy_hash, &e.token);
        let amount = BigInt::from_str(&e.amount).unwrap_or_else(|_| BigInt::zero());
        store.add(e.meta.as_ref().map(|m| m.log_ordinal as u64).unwrap_or(0), &key, &amount);
    }
    for e in events.pulled.iter() {
        let key = key_commitment_from_strings(&e.maker, &e.app, &e.strategy_hash, &e.token);
        let amount = BigInt::from_str(&e.amount).unwrap_or_else(|_| BigInt::zero());
        store.add(
            e.meta.as_ref().map(|m| m.log_ordinal as u64).unwrap_or(0),
            &key,
            &amount.neg(),
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// store_positions — position lifecycle + accumulated token set.
//
// Value stored per position id: pbx::Position (active flag, tokens[], ship/dock
// provenance). Mirrors aqua.ts handleShipped/handlePushed/handleDocked. Ordering
// within a block follows log_ordinal, so a Shipped→Pushed→Docked sequence in one
// block resolves the same way the subgraph resolves it by logIndex.
// ─────────────────────────────────────────────────────────────────────────────
#[substreams::handlers::store]
fn store_positions(events: pbx::Events, store: StoreSetProto<pbx::Position>) {
    // Fold all of this block's events in log order into an in-memory map, then
    // write once per touched position. We can't StoreGet our own writes mid-fold,
    // so a per-block working set is required for correctness within a block.
    use std::collections::BTreeMap;
    let mut working: BTreeMap<String, (pbx::Position, u64)> = BTreeMap::new();

    // Merge events into one ordered stream by log_ordinal.
    enum Ev<'a> {
        Ship(&'a pbx::ShippedEvent),
        Push(&'a pbx::PushedEvent),
        Dock(&'a pbx::DockedEvent),
    }
    let mut stream: Vec<(u64, Ev)> = Vec::new();
    for e in events.shipped.iter() {
        stream.push((ord(&e.meta), Ev::Ship(e)));
    }
    for e in events.pushed.iter() {
        stream.push((ord(&e.meta), Ev::Push(e)));
    }
    for e in events.docked.iter() {
        stream.push((ord(&e.meta), Ev::Dock(e)));
    }
    stream.sort_by_key(|(o, _)| *o);

    for (ordinal, ev) in stream.into_iter() {
        match ev {
            Ev::Ship(e) => {
                let id = position_id_s(&e.maker, &e.app, &e.strategy_hash);
                let entry = working.entry(id.clone()).or_insert_with(|| {
                    (new_position(&id, &e.maker, &e.app, &e.strategy_hash, e), ordinal)
                });
                let (p, _) = entry;
                // Re-ship of an existing id (subgraph allows re-activation).
                p.maker = e.maker.clone();
                p.app = e.app.clone();
                p.strategy_hash = e.strategy_hash.clone();
                p.active = true;
                if p.shipped_tx.is_empty() {
                    p.shipped_block = block_num(&e.meta);
                    p.shipped_tx = tx_of(&e.meta);
                }
                entry.1 = ordinal;
            }
            Ev::Push(e) => {
                let id = position_id_s(&e.maker, &e.app, &e.strategy_hash);
                let entry = working.entry(id.clone()).or_insert_with(|| {
                    // Defensive: Pushed with no prior Shipped (mirrors aqua.ts).
                    let mut p = pbx::Position::default();
                    p.id = id.clone();
                    p.maker = e.maker.clone();
                    p.app = e.app.clone();
                    p.strategy_hash = e.strategy_hash.clone();
                    p.active = true;
                    p.shipped_block = block_num(&e.meta);
                    p.shipped_tx = tx_of(&e.meta);
                    (p, ordinal)
                });
                let (p, _) = entry;
                if !p.tokens.iter().any(|t| t == &e.token) {
                    p.tokens.push(e.token.clone());
                }
                entry.1 = ordinal;
            }
            Ev::Dock(e) => {
                let id = position_id_s(&e.maker, &e.app, &e.strategy_hash);
                // Docked with no prior state in this block: load nothing extra —
                // we still record the dock so a previously-shipped position (in
                // an earlier block, already in the store) gets flipped. To flip
                // an already-stored position we must carry its tokens forward;
                // map_entity_changes reads the store to get the full token set,
                // so here we just ensure a working entry exists to be written.
                let entry = working.entry(id.clone()).or_insert_with(|| {
                    let mut p = pbx::Position::default();
                    p.id = id.clone();
                    p.maker = e.maker.clone();
                    p.app = e.app.clone();
                    p.strategy_hash = e.strategy_hash.clone();
                    (p, ordinal)
                });
                let (p, _) = entry;
                p.active = false;
                p.docked_block = block_num(&e.meta);
                p.docked_block_set = true;
                entry.1 = ordinal;
            }
        }
    }

    for (id, (p, ordinal)) in working.into_iter() {
        store.set(ordinal, &id, &p);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// map_entity_changes — subgraph-shaped upserts for entities touched this block.
//
// Reads the two stores (position state + committed deltas) to produce the same
// Maker/Token/Position/Commitment shapes as schema.graphql. A downstream sink
// (subgraph sink, SQL, or custom) upserts them.
// ─────────────────────────────────────────────────────────────────────────────
#[substreams::handlers::map]
fn map_entity_changes(
    events: pbx::Events,
    positions_store: StoreGetProto<pbx::Position>,
    commitments_store: StoreGetBigInt,
) -> Result<pbx::EntityChanges, Error> {
    use std::collections::{BTreeMap, BTreeSet};

    let mut out = pbx::EntityChanges::default();

    // ── Makers: first-seen tracking. A store would be more precise across
    // blocks; within-block we emit the maker on any event, and the sink's upsert
    // + immutable firstSeenBlock semantics keep the earliest. We stamp the
    // current block; the sink should keep MIN(firstSeenBlock).
    let mut makers: BTreeMap<String, u64> = BTreeMap::new();
    let mut tokens: BTreeSet<String> = BTreeSet::new();
    // (position id) touched this block -> needs re-emit
    let mut touched_positions: BTreeSet<String> = BTreeSet::new();
    // (commitment id) touched this block -> (maker, position id, token)
    let mut touched_commitments: BTreeMap<String, (String, String, String)> = BTreeMap::new();

    for e in events.shipped.iter() {
        makers.entry(e.maker.clone()).or_insert_with(|| block_num(&e.meta));
        touched_positions.insert(position_id_s(&e.maker, &e.app, &e.strategy_hash));
    }
    for e in events.pushed.iter() {
        makers.entry(e.maker.clone()).or_insert_with(|| block_num(&e.meta));
        tokens.insert(e.token.clone());
        let pid = position_id_s(&e.maker, &e.app, &e.strategy_hash);
        touched_positions.insert(pid.clone());
        let cid = commitment_id_s(&e.maker, &e.app, &e.strategy_hash, &e.token);
        touched_commitments.insert(cid, (e.maker.clone(), pid, e.token.clone()));
    }
    for e in events.pulled.iter() {
        let pid = position_id_s(&e.maker, &e.app, &e.strategy_hash);
        let cid = commitment_id_s(&e.maker, &e.app, &e.strategy_hash, &e.token);
        touched_commitments.insert(cid, (e.maker.clone(), pid, e.token.clone()));
    }
    for e in events.docked.iter() {
        touched_positions.insert(position_id_s(&e.maker, &e.app, &e.strategy_hash));
    }

    // Emit Makers.
    for (id, blk) in makers.into_iter() {
        out.makers.push(pbx::Maker { id, first_seen_block: blk });
    }

    // Emit Tokens (address-only; symbol/decimals enriched downstream — no eth_call
    // in this map module; default to "?"/18 to mirror the subgraph's fallbacks).
    for id in tokens.into_iter() {
        out.tokens.push(pbx::Token { id, symbol: "?".to_string(), decimals: 18 });
    }

    // Emit Positions from the store (authoritative, cross-block state).
    let cur_block = current_block(&events);
    for pid in touched_positions.into_iter() {
        if let Some(mut p) = positions_store.get_last(&pid) {
            // On a Docked event this block, fan out commitment deactivation over
            // the position's full token set (mirrors handleDocked).
            if !p.active {
                for tok in p.tokens.iter() {
                    let cid = concat_pid_token(&pid, tok);
                    touched_commitments
                        .entry(cid)
                        .or_insert_with(|| (p.maker.clone(), pid.clone(), tok.clone()));
                }
            }
            // keep the stored id
            p.id = pid.clone();
            out.positions.push(p);
        }
    }

    // Emit Commitments: committed read from the additive store, clamped at 0
    // (mirrors handlePulled's `if committed >= amount ... else 0`). active =
    // parent position active.
    for (cid, (maker, pid, token)) in touched_commitments.into_iter() {
        let raw = commitments_store.get_last(&cid).unwrap_or_else(BigInt::zero);
        let committed = clamp_zero(raw);
        let active = positions_store
            .get_last(&pid)
            .map(|p| p.active)
            .unwrap_or(true);
        out.commitments.push(pbx::Commitment {
            id: cid,
            position: pid,
            maker,
            token,
            committed: committed.to_string(),
            active,
            last_updated_block: cur_block,
        });
    }

    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────────────────────

fn ord(meta: &Option<pbx::EventMeta>) -> u64 {
    meta.as_ref().map(|m| m.log_ordinal as u64).unwrap_or(0)
}
fn block_num(meta: &Option<pbx::EventMeta>) -> u64 {
    meta.as_ref().map(|m| m.block_number).unwrap_or(0)
}
fn tx_of(meta: &Option<pbx::EventMeta>) -> String {
    meta.as_ref().map(|m| m.tx_hash.clone()).unwrap_or_default()
}
fn current_block(events: &pbx::Events) -> u64 {
    events
        .shipped
        .first()
        .and_then(|e| e.meta.as_ref())
        .map(|m| m.block_number)
        .or_else(|| events.pushed.first().and_then(|e| e.meta.as_ref()).map(|m| m.block_number))
        .or_else(|| events.pulled.first().and_then(|e| e.meta.as_ref()).map(|m| m.block_number))
        .or_else(|| events.docked.first().and_then(|e| e.meta.as_ref()).map(|m| m.block_number))
        .unwrap_or(0)
}

fn clamp_zero(v: BigInt) -> BigInt {
    if v.lt(&BigInt::zero()) {
        BigInt::zero()
    } else {
        v
    }
}

fn new_position(
    id: &str,
    maker: &str,
    app: &str,
    strategy_hash: &str,
    e: &pbx::ShippedEvent,
) -> pbx::Position {
    let mut p = pbx::Position::default();
    p.id = id.to_string();
    p.maker = maker.to_string();
    p.app = app.to_string();
    p.strategy_hash = strategy_hash.to_string();
    p.active = true;
    p.shipped_block = block_num(&e.meta);
    p.shipped_tx = tx_of(&e.meta);
    p
}

// String-keyed id builders (inputs are already 0x-hex). We re-derive the raw
// bytes so the concatenation is byte-identical to the subgraph's Bytes.concat.
fn position_id_s(maker: &str, app: &str, strategy_hash: &str) -> String {
    let m = decode_hex(maker);
    let a = decode_hex(app);
    let s = decode_hex(strategy_hash);
    position_id(&m, &a, &s)
}
fn commitment_id_s(maker: &str, app: &str, strategy_hash: &str, token: &str) -> String {
    let m = decode_hex(maker);
    let a = decode_hex(app);
    let s = decode_hex(strategy_hash);
    let t = decode_hex(token);
    commitment_id(&m, &a, &s, &t)
}
// commitment id from an already-built position id (0x-hex) + token (0x-hex),
// concatenating raw bytes — matches `posId.concat(token)` in aqua.ts.
fn concat_pid_token(pid: &str, token: &str) -> String {
    let mut v = decode_hex(pid);
    v.extend_from_slice(&decode_hex(token));
    format!("0x{}", Hex(&v).to_string())
}
// store keys (opaque; only need to be stable + unique per commitment tuple).
fn key_commitment_from_strings(maker: &str, app: &str, strategy_hash: &str, token: &str) -> String {
    commitment_id_s(maker, app, strategy_hash, token)
}

fn decode_hex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    Hex::decode(s).unwrap_or_default()
}
