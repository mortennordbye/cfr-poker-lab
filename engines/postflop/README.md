# Postflop engine (kind `postflop`)

Heads-up postflop solver backed by the Rust library
[b-inary/postflop-solver](https://github.com/b-inary/postflop-solver) (commit `9d1509fe`).
It has the same params and node format as the old JS engine (`engines/postflop-js`), and it is
about 10-15 times faster on the same tree.

## License

postflop-solver is licensed under **AGPL-3.0-or-later**. The Rust program in `rs/` links it, so
`rs/` is also AGPL-3.0-or-later. This is fine for local personal use. If you give the program to
other people or run it as a network service for them, the AGPL requires that you also give them
the source.

## Files

- `index.js`: the engine interface, params, the solver process, node formatting.
- `rs/`: the Rust program (`cargo` project). `rs/src/main.rs` builds the tree, solves, and answers node queries.
- `test.js`: the checks. Run `node engines/postflop/test.js` (`QUICK=1` skips the flop solve, about 35 s).

The engine uses range, board and size parsing from `../postflop-js/game.js`, so the formats are the same.

## How it works

1. On first use, `index.js` runs `cargo build --release` in `rs/` (about 10 s plus the
   dependency download). It builds again when a file in `rs/src` or `rs/Cargo.toml` is newer than the binary.
   If `cargo` is missing, the solve fails with a clear error (the PATH also includes
   `/opt/homebrew/opt/rustup/bin` and `~/.cargo/bin`).
2. `solve()` starts one process per solve and sends the config as one JSON line (chips = bb × 100).
   The process prints progress lines (iteration, exploitability), then `done` with the stats.
3. The process stays alive. `getNode(id)` sends `{id, path}` and returns a Promise of the node.
   The last 500 nodes are cached in Node. `dispose()` kills the process.
4. `solveStats()` solves, returns the stats and the process exits (no node tree).
5. No orphan processes: the Rust process exits within 0.5 s when its parent process dies (also after SIGKILL).

Solver: Discounted CFR (postflop-solver), suit isomorphism for turn and river deals, rayon threads,
16-bit compression when the tree is larger than `compressAboveMB` (1000 MB). Compression halves
the memory, and on this Mac it was also faster (70 s against 92 s on a 4.7 GB tree), because the
solve is limited by memory bandwidth.

## Params

| Param | Default | Notes |
|---|---|---|
| `board` | `Jd8s7c` | 3, 4 or 5 cards |
| `pot`, `stack` | 6, 97 | pot at the solve root, effective stack behind (bb) |
| `oop`, `ip` | `BB`, `SB` | position names |
| `ranges` | – | `{ [pos]: { 'AKs': 0.7, 'AsKs': 1, 'TT+': 1 } }` or `{ [pos]: 'AA,AKs:0.5,22+' }` |
| `oopRange`, `ipRange` | HU SRP ranges (558 vs 598 combos on Jd8s7c) | used when `ranges` has no entry for the position |
| `flopBets` … `riverRaises` | auto, see below | bets in % pot, raises as `2.5x` (raise to 2.5 × the bet), `allin`, `none` |
| `oopFlopBets`, `ipRiverRaises`, … | – | sizes for one player only |
| `donkBets` | `none` | OOP lead on the turn or river after OOP called on the street before: `none`, `same` (normal bet sizes), or sizes like `33,75` |
| `raiseCap` | auto | raises after the first bet on each street |
| `allinSpr` | 1.5 | adds all-in when the stack behind is at most this × the pot |
| `forceAllinSpr` | 0.15 | a bet becomes all-in when the SPR after a call is at most this |
| `mergeThreshold` | 0.1 | merges close bet sizes (PioSOLVER rule) |
| `iterations`, `targetExploitability`, `maxSeconds` | 1000, 0.5, 600 | the solve stops at the first limit |
| `threads` | 8 (capped at the CPU count) | |
| `maxMemoryMB`, `compressAboveMB`, `compress` | 8000, 1000, `auto` | the solve stops with an error above `maxMemoryMB` |
| `equity` | true | per-hand `equity` in each node |

Auto sizes (by the street where the solve starts):

| Start | Flop | Turn | River | Raise cap |
|---|---|---|---|---|
| flop | bet 33, 75; raise 2.5x | bet 66; raise allin | bet 75; raise 2.5x | 1 |
| turn | – | bet 50, 100; raise 2.5x, allin | bet 33, 75, 125; raise 2.5x, allin | 2 |
| river | – | – | bet 33, 75, 125; raise 2.5x, allin | 3 |

The flop tree is smaller than a typical commercial solver tree. Measured memory (raw / compressed) for Jd8s7c with the default ranges:

| Flop tree | Memory |
|---|---|
| default above | 3.2 GB / 1.6 GB |
| turn 50,100 + 2.5x, allin; river 33,75,125 + 2.5x, allin (the full wish list) | 21.6 GB / 11.0 GB |
| same, no raises at all | 3.6 GB / 1.8 GB |
| flop 33,75 + 2.5x; turn 66 + 2.5x; river 75 + 2.5x | 4.7 GB / 2.4 GB (70 s) |
| old JS auto tree (33 / 66 + allin / 75) | 0.8 GB raw (6.8 s) |

## Node format

As in CONTRACT.md and postflop-js: ids are paths (`r`, `r.0`, `r.0.1.12`); a deal step is the
index in the deal action list (the cards the solver can deal, ascending card id, normally all cards
not on the board). Every legal card is clickable: postflop-solver maps isomorphic cards internally,
and the node shows the real card and the real combo names.

- `hands[combo]`: `weight` (initial weight × own reach), `strategy`, `ev` per action (bb, fold = 0:
  chips back from now on minus chips still to put in; `null` if no opponent combo is possible), `equity`
  (vs the opponent's range at this node).
- `stats`: `iterations`, `exploitabilityPctPot`, `ms` (total), `solveMs`, `memoryMB` (used), `memoryRawMB`,
  `peakRssMB`, `compressed`, `threads`, `combos`, `evOop`, `evIp`, `eqOop`, `eqIp`, `history`
  ([iteration, exploitability]), `rootEv {oop:{combo:ev}, ip:{...}}` (bb, the combo's share of the pot),
  `rootEq {oop:{combo:eq}, ip:{...}}`. `solve()` and `solveStats()` return the same stats.
- `estimate(params)` (extra): memory of the tree without a solve.

## Speed (M4 Pro, 8 threads, default ranges, target 0.5% pot; machine also busy with other work)

| Solve | Time | Iterations | Exploitability | Memory |
|---|---|---|---|---|
| Toy river | 0.01 s | 3000 | 0.017% | < 1 MB |
| River `Jd8s7c2h3d`, bet 75 | 0.01 s (JS 0.02 s) | 40 | 0.08% (target 0.2) | < 1 MB |
| Turn `Jd8s7c2h`, JS tree | 0.07 s (JS 0.8 s) | 80 | 0.16% (target 0.2) | 4 MB |
| Turn `Jd8s7c2h`, default tree | 3.1 s | 220 | 0.48% | 140 MB |
| Flop `Jd8s7c`, old JS tree | 6.8 s (JS 93 s) | 90 | 0.30% | 766 MB |
| Flop `Jd8s7c`, default tree | 34-36 s | 100 | 0.47% | 1.6 GB (peak RSS 1.6 GB) |

## Differences from postflop-js and limits

- `2.5x` re-raises: postflop-solver raises to 2.5 × the previous bet; postflop-js uses
  bet + (x − 1) × the raise step. First raises are the same.
- Forced all-in: postflop-solver uses the SPR after a call (`forceAllinSpr`); postflop-js turns
  bets of 80% of the stack or more into all-in. Close sizes are merged (`mergeThreshold`).
  To get the same tree as postflop-js, set `allinSpr: 0, forceAllinSpr: 0, mergeThreshold: 0, donkBets: 'same'`
  and sizes that do not come near the stack (the test does this).
- Donk bets are off by default (postflop-js has no donk rule: OOP always uses its bet sizes).
- `players[].invested` supposes that both players put the same amount in preflop.
- Each finished solve keeps a process with its tree in memory (1.6 GB for a default flop) until the
  server disposes it. The server keeps up to 4 solves, so up to ~6.5 GB for 4 flop solves.
- No disk cache. No rake, no bunching, no node locking (postflop-solver can do these).
- The first solve needs network access once (cargo fetches postflop-solver from GitHub and crates.io).
