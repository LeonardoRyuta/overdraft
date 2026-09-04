import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";
import { Shipped, Pushed, Pulled, Docked } from "../generated/Aqua/Aqua";
import { ERC20 } from "../generated/Aqua/ERC20";
import { Maker, Position, Commitment, Token } from "../generated/schema";

function positionId(maker: Address, app: Address, strategyHash: Bytes): Bytes {
  return maker.concat(app).concat(strategyHash);
}

function getOrCreateMaker(addr: Address, block: BigInt): Maker {
  let m = Maker.load(addr);
  if (m == null) {
    m = new Maker(addr);
    m.firstSeenBlock = block;
    m.save();
  }
  return m;
}

function getOrCreateToken(addr: Address): Token {
  let t = Token.load(addr);
  if (t == null) {
    t = new Token(addr);
    let c = ERC20.bind(addr);
    let d = c.try_decimals();
    t.decimals = d.reverted ? 18 : d.value;
    let s = c.try_symbol();
    t.symbol = s.reverted ? "?" : s.value;
    t.save();
  }
  return t;
}

export function handleShipped(event: Shipped): void {
  getOrCreateMaker(event.params.maker, event.block.number);
  let id = positionId(event.params.maker, event.params.app, event.params.strategyHash);
  let p = Position.load(id);
  if (p == null) {
    p = new Position(id);
    p.tokens = new Array<Bytes>();
  }
  p.maker = event.params.maker;
  p.app = event.params.app;
  p.strategyHash = event.params.strategyHash;
  p.active = true;
  p.shippedBlock = event.block.number;
  p.shippedTx = event.transaction.hash;
  p.save();
}

export function handlePushed(event: Pushed): void {
  getOrCreateMaker(event.params.maker, event.block.number);
  getOrCreateToken(event.params.token);
  let posId = positionId(event.params.maker, event.params.app, event.params.strategyHash);
  let p = Position.load(posId);
  if (p == null) {
    // Defensive: Pushed without a prior Shipped (shouldn't happen — Shipped has a
    // lower logIndex in ship() — but never trust that across all call paths).
    p = new Position(posId);
    p.maker = event.params.maker;
    p.app = event.params.app;
    p.strategyHash = event.params.strategyHash;
    p.active = true;
    p.tokens = new Array<Bytes>();
    p.shippedBlock = event.block.number;
    p.shippedTx = event.transaction.hash;
  }
  let cid = posId.concat(event.params.token);
  let c = Commitment.load(cid);
  if (c == null) {
    c = new Commitment(cid);
    c.position = posId;
    c.maker = event.params.maker;
    c.token = event.params.token;
    c.committed = BigInt.zero();
    let toks = p.tokens;
    toks.push(event.params.token);
    p.tokens = toks;
  }
  c.committed = c.committed.plus(event.params.amount);
  c.active = true;
  c.lastUpdatedBlock = event.block.number;
  c.save();
  p.save();
}

export function handlePulled(event: Pulled): void {
  let posId = positionId(event.params.maker, event.params.app, event.params.strategyHash);
  let cid = posId.concat(event.params.token);
  let c = Commitment.load(cid);
  if (c == null) return;
  if (c.committed.ge(event.params.amount)) {
    c.committed = c.committed.minus(event.params.amount);
  } else {
    c.committed = BigInt.zero();
  }
  c.lastUpdatedBlock = event.block.number;
  c.save();
}

export function handleDocked(event: Docked): void {
  let posId = positionId(event.params.maker, event.params.app, event.params.strategyHash);
  let p = Position.load(posId);
  if (p == null) return;
  p.active = false;
  p.dockedBlock = event.block.number;
  p.save();
  let toks = p.tokens;
  for (let i = 0; i < toks.length; i++) {
    let cid = posId.concat(toks[i]);
    let c = Commitment.load(cid);
    if (c != null) {
      c.active = false;
      c.save();
    }
  }
}
