# sixmax-preflop

6-max preflop solver (UTG, HJ, CO, BTN, SB, BB), ChipEV, 169 hand classes. Kind `sixmax-preflop`.

Files: `tree.js` (params + game tree), `core.js` (CFR+ walk, terminal values), `worker.js`
(threads), `index.js` (engine interface, cache, `getNode`), `test.js`.

## Tree

- Unopened: fold / open / allin. UTG-BTN open to `open` (auto 2.5, or 2.1 with ante), SB to
  `sbOpen` (auto 3, or 2.5 with ante). SB limp only with `sbLimp` (BB then checks / raises 3.5 / allin).
  Folded to the BB = walk.
- Facing an open: fold / call / 3-bet / allin. 3-bet = `threeBetIP` x open (auto 3, or 4 with ante)
  when the 3-bettor is in position postflop, else `threeBetOOP` (auto 4, or 5 with ante).
  Squeeze: + `squeezeAdd` x open per caller.
- Facing a 3-bet: fold / call / 4-bet (`fourBet` x 3-bet, auto 2.5) / allin. Cold 4-bets are in.
  Facing a 4-bet: fold / call / allin (5-bet = allin only).
- A sized raise is left out when it is 60% of the stack or more (allin only then).
- Player caps: at most `maxPlayers` (default 3) players in a single-raised pot or an all-in;
  3-bet and 4-bet pots are heads-up (once one player has called the 3-bet or 4-bet, the others can
  only fold or raise). A player who can only fold is skipped in the UI (the solver keeps the node).
- `coldCalls: false` removes every call of a raise by a player with no voluntary money in (BB
  defending a single raise is still allowed).
- Default tree: 18,061 nodes. The screenshot line (MTT 100bb, BB ante 1: HJ 2.1, CO 8.4, BB
  Raise 21 / Allin 99) is node `F-R2.1-R8.4-F-F`.

Node ids are the action path: `F` fold, `C` call, `X` check, `R<to>` raise, `A` allin, joined with
`-` (root = `root`).

## Terminal values

- Fold: the last player wins the pot.
- All-in called: showdown, heads-up with `E` (169x169 all-in equity).
- Flop seen: zero-sum realized share per CONTRACT, heads-up
  `share_ip = E*R_ip / (E*R_ip + (1-E)*R_oop)` of the pot (`rIp` 1.0, `rOop` 0.88).
- 3 players (flop or all-in): 3-way equity from pairwise products, with the hero's average
  equity a1, a2 vs each opponent range and the average equity e12 between the two opponent ranges:
  `q0 = a1*a2, q1 = (1-a1)*e12, q2 = (1-a2)*(1-e12)`, times R (last to act postflop = R_ip, others
  R_oop, all 1 at showdown), normalized to sum 1. This is an approximation.
- Card removal: exact between two hands (`W` combo counts). For folded players and for the second
  opponent in 3-way pots, each other player's hand is conditioned only on the hero's hand
  (independent of the other opponents). Folded players' ranges are included this way.

## Algorithm

Vector CFR+ (regret floor at 0, linear average strategy, simultaneous updates) over 169 classes
per node. One walk per iteration updates all six players. The tree is split into about 116
subtrees; the master thread walks the top of the tree and 4 threads (master + 3 helpers, all
`worker_threads`) walk the subtrees in parallel. Sync through `SharedArrayBuffer` + `Atomics`.
After the solve, one walk with the average strategy gives the EVs and reaches, and six
best-response walks give the exploitability (average best-response gain per player, as % of the
starting pot 1.5 + ante). The main thread only receives progress and the packed result.

Results are cached in `cache/sixmax-preflop-<hash>.json` (about 28 MB, loads in about 50 ms).

## Solve time (Mac, 4 threads)

| Spot | Iterations | Time | Exploitability |
|---|---|---|---|
| 100bb cash, defaults | 1000 | 27 s | 0.09% pot |
| 100bb cash, defaults | 300 | 10 s | 0.66% pot |
| 100bb MTT, BB ante 1 | 600 | 14 s | 0.29% pot |

RFI at 100bb cash, defaults (1000 iterations): UTG 16.8%, HJ 21.6%, CO 27.2%, BTN 36.7%, SB 50.1%.
With `rIp` 1.08: BTN about 44%.

## Known limits

- Fixed R per position: weak hands realize as well as strong ones, so the BB defends very wide
  (about 97% vs a BTN open when the SB folds) and BTN opens less than published solver charts (37% instead of 40-50%).
- R makes flops costly for the OOP player, so OOP players prefer allin over a 4-bet with very
  strong hands (no realization loss at showdown).
- No side pots: every all-in is `stack - ante` (the BB ante is dead money and is the only stack
  difference).
- Only one size per raise level; no limps except optional SB limp; no 4-way pots.
- Multiplayer CFR has no Nash guarantee; the exploitability numbers show it converges well here.
- `hands` lists only classes with reach weight >= 0.0005.
