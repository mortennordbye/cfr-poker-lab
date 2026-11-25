# Postflop engine (kind `postflop`)

Heads-up postflop solver. It works like PioSolver or GTO+, but the trees are smaller.
It solves over individual combos (1326 minus the combos that the board blocks).

## Files

- `index.js`: the engine interface, params, the in-memory cache, and `getNode`.
- `game.js`: ranges, hand lists, the betting tree, showdown data, and the vector CFR walk. All threads use it.
- `worker.js`: the solve threads (one coordinator and up to 3 helpers).
- `test.js`: the checks. Run `node engines/postflop/test.js`.

## Params

| Param | Default | Notes |
|---|---|---|
| `board` | `Jd8s7c` | 3, 4 or 5 cards |
| `pot`, `stack` | 6, 97 | pot at the solve root, effective stack behind (bb) |
| `oop`, `ip` | `BB`, `SB` | position names. In heads-up the SB is the button, so it is IP. |
| `ranges` | – | `{ [pos]: { 'AKs': 0.7, 'AsKs': 1, 'TT+': 1 } }` or `{ [pos]: 'AA,AKs:0.5,22+' }` |
| `oopRange`, `ipRange` | HU SRP ranges | range text. The engine uses it when `ranges` has no entry for that position. |
| `flopBets` … `riverRaises` | auto, see below | bets in % of the pot, raises as `3x` (raise to 3 times the bet), `allin`, `none` |
| `oopFlopBets`, `ipRiverRaises`, … | – | optional sizes for one player only (not in the UI list) |
| `raiseCap` | auto | the maximum number of raises after the first bet on each street |
| `allinSpr` | 1.5 | adds all-in when the stack behind is at most this times the pot |
| `iterations`, `targetExploitability`, `maxSeconds` | 1000, 0.5, 600 | the solve stops when it reaches the first of these limits |
| `threads`, `maxMemoryMB` | 4, 3000 | not in the UI list |

The auto sizes depend on the street where the solve starts:

| Start street | Flop | Turn | River | Raise cap |
|---|---|---|---|---|
| flop | bet 33, no raise | bet 66, raise allin | bet 75, no raise | 1 |
| turn | – | bet 66 / allin, raise allin | bet 75 / allin, raise allin | 1 |
| river | – | – | bet 75 / allin, raise 3x / allin | 2 |

If a bet is 80% of the stack behind or more, the engine changes it to all-in.

## Tree

The actions are check, bet, raise, call and fold. OOP acts first on each street.
A street ends after check-check or a call. Then a chance node deals the next card
(an action of type `deal` for each card that the board does not hold). An all-in call before the river
is a terminal `showdown`. Its value is the exact equity over all runouts.

## Algorithm

- Vector CFR with alternating updates: one pass per player, and each pass handles all hands at the same time.
- Discounting: positive regrets × t^1.5/(t^1.5+1), negative regrets set to 0 (as in CFR+),
  strategy sum × ((t-1)/t)^3. The DCFR setting from the paper (β = 0, negatives × 0.5) stalled
  near 0.8% pot on trees with large all-in overbets, so the engine does not use it.
- Showdown in O(n): for each 5-card board, the engine sorts each player's hands by strength once,
  using `eval7`. A two-pointer merge with per-card sums of the opponent's reach handles card removal.
  The engine computes fold values with the same per-card sums.
- Threads: the coordinator thread holds the tree of the start street. Each subtree below the first chance node
  (one per line and dealt card) belongs to one of up to 4 threads. In each pass, the coordinator walks its
  street forward to get the reach at each chance node. All threads then walk their subtrees. Then the coordinator
  walks back with the returned values. The main thread does no solve work.
- Exploitability: a best-response pass for each player against the average strategy, every 5 or 10 iterations.
  The value is `(BR_oop + BR_ip - pot) / 2` as % of the pot at the solve root. Progress reports it.
- Memory: two Float32 arrays (regret and strategy sum) of size actions × combos for each decision node.
  Before the build, the engine estimates the size and stops with a clear error above `maxMemoryMB`.

## Node values (`getNode`)

- Node ids are paths: `r`, `r.0`, `r.0.1.12`, … Each number is an action index. A deal is the index in
  the deal action list. `getNode` builds nodes below the first chance node lazily, only when they are needed.
- `hands[combo].weight` = the initial range weight × the reach of the player's own average strategy
  on the path. The weight is 0 when the combo holds a dealt card.
- `hands[combo].strategy` = the average strategy, which sums to 1.
- `hands[combo].ev[a]` = the expected chips (bb) that the player gets back from now on after action `a`,
  minus the chips that the player still puts in. This is the same number as "EV relative to folding now":
  fold = 0. A check-down with 50% equity on the river shows `pot × 0.5`. The value is exact against the
  opponent's range at this node (card removal included), with both players on the average strategy.
  `null` if no opponent combo can reach the node with this hand.
- `players[].invested` = pot/2 + the chips put in since the solve root (this supposes equal preflop money).
  `stack` = the stack behind.
- `history` has the deal entries `{ pos: null, type: 'deal', label: '3c', street: 'river', nodeId }`.
- Terminal: `{ type: 'fold', winner }` or `{ type: 'showdown' }`. An all-in before the river has a `note`.
- `stats` has `iterations`, `exploitabilityPctPot`, `ms`, `decisionNodes`, `memoryMB`, `combos`,
  `evOop` / `evIp` (the EV at the root, in bb) and `history` ([iteration, exploitability] points).

## Speed (Mac, 4 threads, default ranges 558 vs 598 combos, target 0.5% pot)

| Solve | Time | Iterations | Exploitability | Memory |
|---|---|---|---|---|
| River `Jd8s7c2h3d` | 0.08 s | 121 | 0.47% | < 1 MB |
| Turn `Jd8s7c2h` (auto sizes) | 2.8 s | 211 | 0.47% | 13 MB |
| Flop `Jd8s7c` (auto sizes) | 93 s | 111 | 0.47% | 756 MB |
| Flop with a 3x flop raise and an all-in river raise | about 1.6 s per iteration (≈ 3 min) | – | – | 2.2 GB |
| Small flop (157 vs 198 combos) | 12 s | 51 | 0.94% (target 1) | 232 MB |

## Cache

Memory only. Up to 4 results are kept, keyed by the hash of the normalized params. Disk is not used,
because a flop result holds hundreds of MB of typed arrays.

## Limits

- The flop trees are small: one bet size per street, no raise on the flop or the river.
  You can add more sizes, but memory and time grow fast (each line that reaches the turn
  adds 49 × the turn lines × 48 river subtrees).
- There is no suit isomorphism and no pruning of the deal nodes.
- `players[].invested` supposes that both players put the same amount in preflop.
- The server keeps every solve in memory, so many flop solves will use a lot of RAM.
- Possible later additions: per-combo equity and the hand category at a node. The showdown data
  (strength-sorted hands per board) and the reach at each node are already there.
