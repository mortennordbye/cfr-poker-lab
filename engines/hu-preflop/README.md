# hu-preflop

Heads-up preflop solver, SB vs BB, ChipEV.

## Tree
- SB: Fold / Limp (if `limp`) / Raise to each size in `sbOpen` / Allin.
- BB vs limp: Check (ends preflop) / Raise to `isoSize` / Allin.
- Facing the 1st raise: Fold / Call / Raise to `threeBetX` x the raise / Allin.
- Facing the 2nd raise: Fold / Call / Raise to `fourBetX` x the raise / Allin.
- Facing the 3rd raise or more: Fold / Call / Allin.
- A raise size above 80% of the stack is dropped (the all-in covers it).
- `stack` includes the ante (same as the push/fold solver). Both players post `ante`.

Terminals: fold; showdown (all-in called, exact class-vs-class equity from `lib/equity.json`);
flop (call or check with stacks behind).

## Flop terminal value
Each side gets `pot * equity * R` (SB is IP with `rIp`, BB is OOP with `rOop`). The two shares
are normalized so they sum to the pot. Without that, `R_oop < 1` would remove chips from the game
and the game would not be zero-sum. Example: E(SB)=0.5, R=1.0/0.88 gives SB 53.2% of the pot.

## Calibrated realization (learn as you browse)
Param `realization`: `calibrated` (default) or `flat`. With `calibrated`, each flop terminal that has
samples gets its own R per hand class and position (`share = E*Rsb / (E*Rsb + (1-E)*Rbb)`).
- Samples: every postflop solve started from a flop terminal of this engine ("Solve flop" in the UI,
  the idle filler, `tools/calibrate-hu.js`) saves one file in
  `cache/realization-samples/<spotKey>/<hash of terminal key>/<board>.json` (see CONTRACT.md).
- Table: `lib/realization.js` `buildTable()`. R = sum(w*EV) / sum(w*pot*flopEquity) per class, where
  w = texture-group weight (each sampled group counts by its share of all 22,100 flops; groups are
  suit pattern x pairing x high card A / KQ / JT / 9-) x recency (half-life 7 days, relative to the
  newest sample; x0.5 when the sample's ranges hash differs from the newest sample's). Then
  `R = m*Rmeasured + (1-m)*Rflat`, `m = n/(n+5)`, n = flops sampled for that terminal. Classes without
  data get the measured position average. Clamped to [0.2, 3].
- No samples: the old batch table `cache/realization-hu-<spot>.json` if it exists, else flat R. With 0
  samples the result is exactly the flat result.
- Cache key includes a hash of the sample file list (names, mtimes, sizes), so a new sample gives a new solve.
- `stats.calibration = { mode, source, spotKey, terminals: [{ key, name, flops, full, mass, m }] }` feeds
  the Solve tab ("Raised pot (SB 2.25 / BB call): 7 flops").
- Flop terminal nodes carry `terminal.key`, `terminal.spotKey`, `terminal.name` and `terminal.mass`
  (share of all deals that reach it).

## Algorithm
CFR+ over 169 hand classes, alternating updates, linear averaging. Card removal is in the
`W` combo-pair weights. Terminal values are 169x169 matrix-vector products.
Exploitability = average of both players' best-response gains, in % of the starting pot.
The solve runs in a worker thread (`worker.js`), at most 4 at once. Results are cached in
`cache/hu-preflop-<hash>.json`.

## Node fields
- `hands[h].weight` = reach probability of the acting player's own strategy.
- `hands[h].ev[a]` = EV in bb of action `a`, relative to the stack behind now
  (= relative to folding now, fold = 0). The same definition is used where no fold is possible
  (BB vs limp), so a free check there has EV > 0.
- Terminal nodes add `ranges: { SB, BB }` (reach per class), and `terminal.flop` for flop terminals.

## Solve time
100bb defaults (46 nodes, 1500 iterations): about 2 s, exploitability about 0.015% pot.

## Known limits
- No postflop play: the flop is valued with the realization model above (flat or calibrated).
- Calibrated R depends on the postflop engine's tree; few samples give noisy R (the mix toward flat
  R limits this).
- One size per raise level (except the SB open list).
- With the normalized realization model BB defends wide vs a 2.5x open (folds about 12%).
  Lower `rOop` to make BB fold more.

## Test
`node engines/hu-preflop/test.js`
