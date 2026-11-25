# Solver contract (shared by all engines and the UI)

## Overall goal

Build a local poker study tool in the style of commercial solver browsers, running on one Mac.
The user browses a solved hand from the first preflop action to the river, and at every node
sees what each hand does, how often, and with what EV.

The finished tool has:
- **Spot setup**: game (MTT/cash), players (HU, 6-max), stacks, antes, bet sizes, ChipEV.
- **Top action bar**: one column per decision (position, stack, actions, chosen action),
  board cards with colored suits, click any column to go back. Preflop flows into flop, turn, river.
- **Strategy + EV grid**: 13x13 cells split by action frequency, EV per hand.
- **Other views of the same node**: Ranges (both players' ranges), Breakdown (frequency by hand
  category: sets, two pair, draws), Equity chart, Table of all hands.
- **Right panel**: action summary (% and combos), pot and pot odds, per-combo Hands panel with EV
  per action, Summary, Filters, Blockers.
- **Reports**: aggregate flop reports (strategy over many flops).
- **Solve on demand**: any node that ends preflop can be solved postflop.

Current build (phase 1): the three engines below + the UI with action bar, grid, action summary,
Hands panel and solve-on-demand. Everything else in the list above is the backlog: do not build
it now, but do not design anything that blocks it (keep the node format and UI generic).

Three engines solve different games. One UI browses all of them through the same node format.

Runtime: Node 26, CommonJS, **no npm packages**. Run with `node server.js`, port 8787.

## Folder ownership (do not edit folders you do not own)

| Path | Owner |
|---|---|
| `lib/equity.js`, `lib/equity.json` | shared, read-only. Hand classes, combos, `eval7`, card helpers, 169x169 equity table `E` and combo weights `W`. |
| `server.js`, `CONTRACT.md` | integrator (main session). Read-only for engine agents. |
| `engines/hu-preflop/`, `public/` | agent A (heads-up preflop + the whole UI) |
| `engines/postflop/` | Rust-backed postflop engine (kind 'postflop'), wraps b-inary/postflop-solver (AGPL-3.0) |
| `engines/postflop-js/` | old JS postflop engine (kind 'postflop-js'), kept as fallback and reference |
| `lib/postflop.js` | resolver for tools: Rust engine if present, else JS |
| `engines/sixmax-preflop/` | agent C |
| `engines/pushfold/` | old push/fold solver, leave as is |
| `cache/` | any engine may write `cache/<kind>-<hash>.json` |

## Card and hand notation (from `lib/equity.js`)

- Card id `0..51` = `rank * 4 + suit`. rank 0 = `2` ... 12 = `A`. suits `c d h s`. Names like `Jd`.
- Hand class: 169 ids, `id = row * 13 + col`, row/col 0 = Ace. Names `AA`, `AKs`, `AKo`. `className(id)`, `classOf(a, b)`.
- Combo name: high card first, e.g. `KsKh`, `As2s` (`comboName(a, b)`).
- `loadEquity()` → `{ E, W }`: `E[i*169+j]` = all-in equity of class i vs class j (card removal included), `W[i*169+j]` = number of non-conflicting combo pairs.

## Engine module interface

Each engine folder has `index.js` that exports:

```js
module.exports = {
  kind: 'hu-preflop',                 // 'hu-preflop' | 'postflop' | 'sixmax-preflop'
  title: 'Heads-up preflop',
  params: [ { name: 'stack', type: 'number', default: 100, min: 5, max: 300, label: 'Stack (bb)' }, ... ],
  // Must not block the event loop for more than ~200 ms at a time: run long work in worker_threads.
  async solve(params, onProgress /* (fraction 0..1, message) */) {
    return {
      root: '<nodeId>',
      getNode(id) { return Node },     // fast; may return the Node or a Promise of it
      dispose() {},                    // optional: free memory/processes when the server drops this solve
      stats: { iterations, exploitabilityPctPot /* or null */, ms },
    };
  },
};
```

The engine fills in defaults for missing params and clamps values.
Param `type`: `number` | `text` | `boolean` | `select` (with `options: [...]`) | `json`.
Terminal nodes may also carry `ranges: { [pos]: { class: weight } }` (reach of each player still in).

## Node format (what `getNode` returns, what the UI renders)

```js
{
  id: 'string',                       // opaque, unique in this solve
  street: 'preflop' | 'flop' | 'turn' | 'river',
  board: ['Jd','8s','7c'],            // cards so far ([] preflop)
  pot: 6.0,                           // bb in the middle, incl. blinds/antes and bets this street
  players: [                          // one entry per seat, in seat order, for the top action bar
    { pos: 'SB', stack: 97.5, invested: 2.5, folded: false },   // stack = behind, invested = put in this hand
  ],
  history: [                          // actions that lead here, for the top action bar (one column per entry)
    { pos: 'SB', street: 'preflop', label: 'Raise 2.5', nodeId: '<id of node where this action was taken>' },
  ],
  toAct: 'BB' | null,                 // null for terminal and chance nodes
  toCall: 1.5,                        // bb that toAct must add to call (0 if check is possible)
  actions: [                          // empty at terminal nodes
    { label: 'Fold', type: 'fold', amount: 0, child: '<nodeId>' },
    { label: 'Call', type: 'call', amount: 1.5, child: '<nodeId>' },
    { label: 'Raise 8', type: 'raise', amount: 8, child: '<nodeId>' },   // amount = total bet size this street ("raise to")
    { label: 'Allin 100', type: 'allin', amount: 100, child: '<nodeId>' },
    // types: fold | check | call | bet | raise | allin | deal (chance: label = card, e.g. 'Kh')
  ],
  handKind: 'class' | 'combo',        // preflop engines: 'class' (169). postflop: 'combo' (1326 names)
  hands: {                            // only hands with reach weight > 0 for toAct
    'AKs': {
      weight: 0.85,                   // reach probability of this hand for toAct (0..1) at this node
      strategy: [0.0, 0.3, 0.7, 0.0], // one frequency per action, sums to 1
      ev: [0, 1.2, 1.9, -0.4],        // EV in bb per action, relative to folding now (fold = 0), null if unknown
    },
  },
  terminal: null | {
    type: 'fold' | 'showdown' | 'flop',   // 'flop' = preflop engine ends here, postflop can continue
    // For type 'flop' (two players left): everything a postflop solve needs.
    flop: { oop: 'BB', ip: 'SB', pot: 6, stack: 97.5,
            ranges: { BB: { 'AKs': 0.7, ... }, SB: { ... } } },   // class -> reach weight 0..1
  },
  note: 'optional text, e.g. what the engine simplified at this node',
}
```

- Chance nodes (next street card): `toAct: null`, `actions` of type `deal`, one per possible card. `hands` may be empty.
- `hands[...].ev` uses the player to act's view. Fold = 0, the usual convention in solver tools.
- The UI aggregates combos into the 13x13 grid itself (weighted by `weight`).

## HTTP API (server.js, already written)

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/api/engines` | | `[{ kind, title, params }]` |
| POST | `/api/solve` | `{ kind, params }` | `{ solveId }` (starts the solve in the background) |
| GET | `/api/solve/:solveId` | | `{ kind, params, status: 'running'|'done'|'error', progress, message, stats, root, error }` |
| GET | `/api/solve/:solveId/node?id=<nodeId>` | | Node |
| GET | `/api/pushfold?stack=&ante=&iterations=` | | old push/fold result (for `/pushfold.html`) |

Static files are served from `public/` (`/` → `public/index.html`).

## Postflop terminal in preflop trees (simplification)

Preflop engines do not solve postflop play. At a terminal where two or more players see a flop,
value each player's hand as `pot * equity * R`, where `R` = equity realization:
`R = 1.0` for the player in position, `R = 0.88` for the player out of position
(make R a param). Heads-up, normalize the two shares so they sum to the pot (zero-sum):
`share_ip = E*R_ip / (E*R_ip + (1-E)*R_oop)` of the pot. For multiway, normalize the same way over all players left. Document any further simplification in the node `note` and in the engine README.

## Each agent must deliver

1. `engines/<kind>/index.js` + its files, matching this contract.
2. `engines/<kind>/test.js`: runnable with `node engines/<kind>/test.js`, prints checks and exits non-zero on failure.
3. `engines/<kind>/README.md`: tree, algorithm, simplifications, solve time, known limits (short).

## Realization samples (hu-preflop and sixmax-preflop calibration)

- A `POST /api/solve` for a postflop engine may carry `params.source = { kind: 'hu-preflop', spotKey, terminalKey }`
  (from `node.terminal.spotKey` / `node.terminal.key` of a hu-preflop flop terminal). The server strips it before the
  engine sees the params. When the solve is done, the server saves a sample (flop boards only):
  `cache/realization-samples/<spotKey>/<sha1(terminalKey)[0..12]>/<board>.json` =
  `{ terminalKey, board, pot, rangesHash, ranges, createdAt, solver, ev: { SB: {combo: ev}, BB }, eq: { SB: {combo: eq}, BB } }`.
  `ev` = `stats.rootEv` (oop/ip mapped to positions), `eq` = `stats.rootEq` if the engine gives it, else Monte Carlo
  in a worker. A file is only replaced by a newer sample. `GET /api/solve/:id` adds `sample: { file, flops } | { error }`.
- Postflop engines used for calibration must give `stats.rootEv = { oop: {combo: ev}, ip: {...} }` (bb won from the
  flop root) and should give `stats.rootEq` (same shape, equity vs the opponent range), plus `solveStats(params)`.
- `lib/realization.js` builds the table; `tools/calibrate-hu.js` writes the same samples (batch fill).
- 6-max: `params.source = { kind: 'sixmax-preflop', spotKey, terminalKey, group }` (from `node.terminal.spotKey`,
  `.key`, `.group` of a heads-up sixmax-preflop flop terminal; `spotKey` = `6max-<hash>`, `key` = node id). The sample is
  the same file, plus `group`, `oop` and `ip` (positions, e.g. `ev: { BTN: {...}, BB: {...} }`). A group is
  `<pot type> <IP pos> vs <OOP pos>`, pot type `LIMP` | `SRP` | `3BP` | `4BP` (e.g. `SRP BTN vs BB`).
  `sample.flops` in the status answer counts the samples of the group, and the answer adds `sample.group`.
  `buildGroupTable()` pools all terminals of a group; `tools/calibrate-sixmax.js` is the batch fill.
  6-max flop terminals also carry `terminal.name`, `terminal.mass` (share of all deals that reach it) and
  `terminal.calibrated`. A `spotKey` must match `[\w-]{1,64}`, else no sample is saved.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/idle` | | `{ enabled, idleMs, idleForMs, running, last, hasSpot }` |
| POST | `/api/idle` | `{ enabled }` | same |

Idle filler (`idle.js`, off by default, setting kept in `cache/idle.json`): after `IDLE_MS` (default 5 min) without
API requests (other than `/api/idle`) and with no solve running, it solves one flop for the last used hu-preflop
spot (terminal with the best reach mass / (samples + 1), first `flopSubset(20)` board not sampled) in a child
process, with kind `postflop` if loaded, else `postflop-js`. Any other API request kills it.

## Flop reports

A flop report solves one heads-up flop spot on many flops and aggregates the root results (`lib/reports.js`, CLI
`tools/flop-report.js`). Local mode only: the static site answers 404 for these paths.

Input (`POST /api/report` body):

```js
{ kind: 'hu-preflop' | 'sixmax-preflop', params: { ...preflop params }, terminalKey: 'SB:Raise 2.5/BB:Call' }
// terminalKey = node.terminal.key, or the node id of a heads-up flop terminal
// or a postflop spot:
{ spot: { ranges: { BB: {...} | 'range text', SB: ... }, pot: 5, stack: 97.5, oop: 'BB', ip: 'SB' } }
// plus, for both:
  flops: 25 | 49 | 95,                         // lib/flops.js flopSubset(n); default 25
  tree: { flopBets, flopRaises, turnBets, turnRaises, riverBets, riverRaises, donkBets, raiseCap, allinSpr,
          iterations, targetExploitability /* default 1 */, maxSeconds /* default 300 */, threads /* default 4 */ }
```

- One postflop solve at a time (engine `postflop`, else `postflop-js`), 4 threads by default. Reports queue behind each other.
- A flop from a `hu-preflop` terminal also saves a realization sample (same files as "Solve flop").
- Storage: `cache/reports/<id>.json` (`REPORTS_DIR`), written after each flop. `id` = hash of the input without
  `threads`. The same input gives the same id: a stopped report continues, a finished one is returned as it is.
  The spot (ranges, pot, stack) is fixed when the report starts, so new calibration samples do not change it.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/api/report` | input above | `{ reportId, status: 'queued' \| 'running' \| 'done' }`, 400 `{ error }` on bad input |
| GET | `/api/report/:id` | | report (below), 404 if unknown |
| GET | `/api/reports` | | `[{ id, status, name, done, total, progress, createdAt, updatedAt, runMs, input }]`, newest first |

Report:

```js
{
  id, status: 'queued' | 'running' | 'done' | 'error' | 'stopped',  // stopped: not running, not done (POST again)
  message, error, progress /* 0..1 */, done, total, current /* board being solved */, etaMs,
  name /* 'Raised pot (SB 2.5 / BB call)' */, createdAt, updatedAt, runMs /* solve time of all runs */, engine,
  input, tree, flops: ['Kh7h2h', ...],
  spot: { oop, ip, pot, stack, ranges, source: { kind, spotKey, terminalKey, name, mass } | null },
  results: [{                                    // one per finished flop, in the order of flops
    board: 'Kh7h2h',
    texture: { suits: 'monotone' | 'two-tone' | 'rainbow', pairing: 'unpaired' | 'paired' | 'trips',
               high: 'K', highRank: 11, ranks: [11, 5, 0], group: 'mono-unpaired-KQ' },
    oop: { player: 'BB', actions: [{ label: 'Check', type: 'check', amount: 0, freq: 0.62 }, ...], bet: 0.38 },
    ip: { player: 'SB', actions: [...], bet } | null,   // IP at the node after OOP checks
    ev: { oop, ip },                                     // bb won from the flop root (shares of the pot)
    eq: { oop, ip },                                     // range equity
    exploitabilityPctPot, iterations, ms, sample: 'saved' | ... (hu-preflop source only),
  }],
  summary: [{                                    // mean over the flops of each group (each flop = equal share)
    key: 'all' | 'monotone' | 'two-tone' | 'rainbow' | 'unpaired' | 'paired' | 'trips' | 'high-A' ... 'high-9',
    label, by: null | 'suits' | 'pairing' | 'high', n,
    oop: { n, actions: [{ label, type, amount, freq }], bet }, ip: same | null,
    ev: { oop, ip }, eq: { oop, ip }, exploitabilityPctPot,
  }],
}
```
