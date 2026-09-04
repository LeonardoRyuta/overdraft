# Overdraft

> Measuring how much of 1inch Aqua's advertised liquidity actually exists — and shipping the SwapVM instruction that stops positions overcommitting.

**Status:** Day 1 (2026-09-04) — recon + spike in progress. ETHGlobal ETHOnline 2026, "Start Fresh" pool.

## Headline number

**TBD** — must be measured from live chain state, never invented. See ground rules in `ethonline-2026-plan.md`.

## What this is

Aqua stores *virtual balances*: one wallet balance can back several positions at once, so quoted depth is an upper bound, not a guarantee. Overdraft computes, per maker:

```
coverage = min(wallet_balance, aqua_allowance) / sum(virtual_balances_committed)
```

...across every live position on every supported chain, verifies it on a mainnet fork (the "Honesty Probe"), and ships `SolvencyGuard`, a custom SwapVM instruction that refuses to quote beyond real backing.

## Layout (Day 1 — provisional, will firm up after recon)

- `ethonline-2026-plan.md` — source-of-truth execution plan
- `RECON-*.md`, `PRIOR-ART.md` — Day 1 recon findings (with citations)
- `spikes/` — throwaway exploratory code, not production
- `docs/` — architecture, notes

## Anchors (verified 2026-09-04)

- Aqua core registry (deterministic, multi-chain): `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`
- Repos: `github.com/1inch/aqua`, `github.com/1inch/swap-vm`
