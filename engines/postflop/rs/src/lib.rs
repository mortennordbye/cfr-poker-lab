// Postflop engine around b-inary/postflop-solver (AGPL-3.0-or-later): the shared logic.
//
// One copy of the config parsing, tree build, solve loop, node data and stats. Two thin front ends use it:
//   src/main.rs  the native process (stdin/stdout JSON lines, used by Node and the container image)
//   src/wasm.rs  the WebAssembly module (wasm-bindgen, used by the static site in a Web Worker)
// Both send the same JSON messages: {"type":"info"}, {"type":"progress"}, {"type":"done","stats":{...}},
// {"type":"estimate"}, and node answers. See ../index.js for the config format.

use postflop_solver::*;
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub fn rnd(x: f64, d: i32) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    let m = 10f64.powi(d);
    json!((x * m).round() / m)
}

// Bet sizes from the config: "p0.33" (pot fraction), "x2.5" (times the previous bet), "a" (all-in).
fn parse_sizes(v: &Value, is_raise: bool) -> Result<Vec<BetSize>, String> {
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for s in arr {
            let s = s.as_str().ok_or("size must be a string")?;
            if s == "a" {
                out.push(BetSize::AllIn);
            } else if let Some(n) = s.strip_prefix('p') {
                let f: f64 = n.parse().map_err(|_| format!("bad size {s}"))?;
                out.push(BetSize::PotRelative(f));
            } else if let Some(n) = s.strip_prefix('x') {
                let f: f64 = n.parse().map_err(|_| format!("bad size {s}"))?;
                if !is_raise {
                    // a "x" size for a bet makes no sense: treat it as pot fraction
                    out.push(BetSize::PotRelative(f));
                } else {
                    out.push(BetSize::PrevBetRelative(f));
                }
            } else {
                return Err(format!("bad size {s}"));
            }
        }
    }
    out.sort_unstable_by(|l, r| l.partial_cmp(r).unwrap());
    Ok(out)
}

fn street_sizes(cfg: &Value, street: &str) -> Result<[BetSizeOptions; 2], String> {
    let s = &cfg["sizes"][street];
    let mk = |p: usize| -> Result<BetSizeOptions, String> {
        Ok(BetSizeOptions {
            bet: parse_sizes(&s[p]["bet"], false)?,
            raise: parse_sizes(&s[p]["raise"], true)?,
        })
    };
    Ok([mk(0)?, mk(1)?])
}

fn donk_sizes(cfg: &Value, street: &str) -> Result<Option<DonkSizeOptions>, String> {
    let v = &cfg["donk"][street];
    if v.is_null() {
        return Ok(None); // OOP uses the normal bet sizes
    }
    Ok(Some(DonkSizeOptions { donk: parse_sizes(v, false)? }))
}

// Removes raises above the cap (number of raises after the first bet on each street).
fn cap_raises(tree: &mut ActionTree, bets: i32, cap: i32, remove: &mut Vec<Vec<Action>>) {
    if tree.is_terminal_node() {
        return;
    }
    let bets = if tree.is_chance_node() { 0 } else { bets };
    let actions = tree.available_actions().to_vec();
    for a in actions {
        let aggressive = matches!(a, Action::Bet(_) | Action::Raise(_) | Action::AllIn(_));
        if aggressive && bets >= 1 && bets - 1 >= cap {
            let mut line = tree.history().to_vec();
            line.push(a);
            remove.push(line);
            continue;
        }
        tree.play(a).unwrap();
        cap_raises(tree, bets + aggressive as i32, cap, remove);
        tree.undo().unwrap();
    }
}

fn hand_name(h: (Card, Card)) -> String {
    let (a, b) = if h.0 > h.1 { (h.0, h.1) } else { (h.1, h.0) };
    format!("{}{}", card_to_string(a).unwrap(), card_to_string(b).unwrap())
}

fn possible_list(game: &PostFlopGame) -> Vec<u8> {
    let m = game.possible_cards();
    (0..52u8).filter(|c| m & (1u64 << c) != 0).collect()
}

fn action_json(a: Action, to_call: i32) -> Value {
    match a {
        Action::Fold => json!({ "type": "fold", "amount": 0 }),
        Action::Check => json!({ "type": "check", "amount": 0 }),
        Action::Call => json!({ "type": "call", "amount": to_call }),
        Action::Bet(x) => json!({ "type": "bet", "amount": x }),
        Action::Raise(x) => json!({ "type": "raise", "amount": x }),
        Action::AllIn(x) => json!({ "type": "allin", "amount": x }),
        _ => json!({ "type": "none", "amount": 0 }),
    }
}

// Node data for one path from the root. Deal steps are indices into the list of possible cards.
fn node_info(game: &mut PostFlopGame, path: &[usize], scale: f64, with_equity: bool) -> Result<Value, String> {
    game.back_to_root();
    let mut history = Vec::new();
    let mut last: Option<(usize, Action)> = None;
    for (k, &i) in path.iter().enumerate() {
        if game.is_terminal_node() {
            return Err("path goes past a terminal node".into());
        }
        let board_len = game.current_board().len();
        if game.is_chance_node() {
            let cards = possible_list(game);
            if i >= cards.len() {
                return Err("bad deal index".into());
            }
            history.push(json!({ "step": k, "deal": cards[i], "boardLen": board_len + 1 }));
            game.play(cards[i] as usize);
            last = None;
        } else {
            let acts = game.available_actions();
            if i >= acts.len() {
                return Err("bad action index".into());
            }
            let p = game.current_player();
            let tb = game.total_bet_amount();
            let to_call = (tb[p ^ 1] - tb[p]).max(0);
            history.push(json!({ "step": k, "player": p, "boardLen": board_len, "action": action_json(acts[i], to_call) }));
            last = Some((p, acts[i]));
            game.play(i);
        }
    }
    let board = game.current_board();
    let tb = game.total_bet_amount();
    let mut out = json!({ "board": board, "totalBet": tb, "history": history });
    if game.is_terminal_node() {
        match last {
            Some((p, Action::Fold)) => {
                out["kind"] = json!("fold");
                out["folder"] = json!(p);
            }
            _ => out["kind"] = json!("showdown"),
        }
        return Ok(out);
    }
    if game.is_chance_node() {
        out["kind"] = json!("chance");
        out["cards"] = json!(possible_list(game));
        return Ok(out);
    }
    let p = game.current_player();
    let to_call = (tb[p ^ 1] - tb[p]).max(0);
    let acts = game.available_actions();
    out["kind"] = json!("act");
    out["player"] = json!(p);
    out["toCall"] = json!(to_call);
    out["actions"] = Value::Array(acts.iter().map(|&a| action_json(a, to_call)).collect());
    game.cache_normalized_weights();
    let strategy = game.strategy();
    let evd = game.expected_values_detail(p);
    let eq = if with_equity { game.equity(p) } else { Vec::new() };
    let w = game.weights(p).to_vec();
    let nw = game.normalized_weights(p).to_vec();
    let cards = game.private_cards(p).to_vec();
    let n = cards.len();
    let na = acts.len();
    let mut hands = serde_json::Map::new();
    for h in 0..n {
        if !(w[h] > 1e-9) {
            continue;
        }
        let known = nw[h] > 0.0;
        let st: Vec<Value> = (0..na).map(|a| rnd(strategy[a * n + h] as f64, 4)).collect();
        let ev: Vec<Value> = (0..na)
            .map(|a| if known { rnd(evd[a * n + h] as f64 / scale, 3) } else { Value::Null })
            .collect();
        let mut o = json!({ "weight": rnd(w[h] as f64, 5), "strategy": st, "ev": ev });
        if with_equity && known {
            o["equity"] = rnd(eq[h] as f64, 4);
        }
        hands.insert(hand_name(cards[h]), o);
    }
    out["hands"] = Value::Object(hands);
    Ok(out)
}

fn mb(b: u64) -> f64 {
    b as f64 / (1024.0 * 1024.0)
}

/// What `build` returns: the memory estimate (mode "estimate"), or a game with its memory allocated.
pub enum Built {
    Estimate(Value),
    Ready(Solve),
}

/// One solve: the game tree and what the stats need. `now_ms` is a clock in milliseconds (the native and the
/// WebAssembly front ends use different clocks: std::time::Instant does not work in the browser).
pub struct Solve {
    game: PostFlopGame,
    cfg: Value,
    scale: f64,
    with_equity: bool,
    threads: usize,
    combos: [usize; 2],
    compress: bool,
    mem_use: u64,
    mem_raw: u64,
    t_start: f64,
    build_ms: f64,
}

/// Builds the tree from the config and allocates its memory. `t_start`: clock value when the config arrived.
/// `threads`: the size of the rayon pool (the front end builds the pool).
pub fn build(cfg: &Value, threads: usize, t_start: f64, now_ms: &dyn Fn() -> f64) -> Result<Built, String> {
    let scale = cfg["scale"].as_f64().unwrap_or(100.0);

    // cards and ranges
    let board: Vec<u8> = cfg["board"].as_array().ok_or("board missing")?
        .iter().map(|c| c.as_u64().unwrap() as u8).collect();
    if board.len() < 3 || board.len() > 5 {
        return Err("board must have 3, 4 or 5 cards".into());
    }
    let mut ranges = [Range::new(), Range::new()];
    for p in 0..2 {
        for e in cfg["ranges"][p].as_array().ok_or("ranges missing")? {
            let a = e[0].as_u64().unwrap() as u8;
            let b = e[1].as_u64().unwrap() as u8;
            let w = e[2].as_f64().unwrap() as f32;
            ranges[p].set_weight_by_cards(a.min(b), a.max(b), w.clamp(0.0, 1.0));
        }
    }
    let card_config = CardConfig {
        range: ranges,
        flop: [board[0], board[1], board[2]],
        turn: if board.len() > 3 { board[3] } else { NOT_DEALT },
        river: if board.len() > 4 { board[4] } else { NOT_DEALT },
    };
    let initial_state = match board.len() {
        3 => BoardState::Flop,
        4 => BoardState::Turn,
        _ => BoardState::River,
    };

    // tree
    let tree_config = TreeConfig {
        initial_state,
        starting_pot: cfg["pot"].as_i64().ok_or("pot missing")? as i32,
        effective_stack: cfg["stack"].as_i64().ok_or("stack missing")? as i32,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: street_sizes(cfg, "flop")?,
        turn_bet_sizes: street_sizes(cfg, "turn")?,
        river_bet_sizes: street_sizes(cfg, "river")?,
        turn_donk_sizes: donk_sizes(cfg, "turn")?,
        river_donk_sizes: donk_sizes(cfg, "river")?,
        add_allin_threshold: cfg["addAllin"].as_f64().unwrap_or(1.5),
        force_allin_threshold: cfg["forceAllin"].as_f64().unwrap_or(0.15),
        merging_threshold: cfg["merge"].as_f64().unwrap_or(0.1),
    };
    let mut tree = ActionTree::new(tree_config)?;
    if let Some(cap) = cfg["raiseCap"].as_i64() {
        let mut remove = Vec::new();
        cap_raises(&mut tree, 0, cap as i32, &mut remove);
        for line in remove {
            tree.remove_line(&line).map_err(|e| format!("raise cap: {e}"))?;
        }
        tree.back_to_root();
    }
    let mut game = PostFlopGame::with_config(card_config, tree)?;
    let combos = [game.private_cards(0).len(), game.private_cards(1).len()];
    if combos[0] == 0 || combos[1] == 0 {
        return Err("empty range after board card removal".into());
    }

    // memory
    let (mem_raw, mem_comp) = game.memory_usage();
    let compress = match &cfg["compress"] {
        Value::Bool(b) => *b,
        _ => mb(mem_raw) > cfg["compressAboveMB"].as_f64().unwrap_or(2000.0),
    };
    let mem_use = if compress { mem_comp } else { mem_raw };
    if cfg["mode"].as_str() == Some("estimate") {
        return Ok(Built::Estimate(json!({ "type": "estimate", "memoryMB": mb(mem_use).round(), "memoryRawMB": mb(mem_raw).round(),
            "memoryCompressedMB": mb(mem_comp).round(), "compressed": compress, "combos": combos })));
    }
    let max_mb = cfg["maxMemoryMB"].as_f64().unwrap_or(8000.0);
    if mb(mem_use) > max_mb {
        if cfg!(target_arch = "wasm32") {
            return Err(format!(
                "out of memory: try a smaller tree. It needs {:.0} MB ({:.0} MB without compression), the browser limit is {:.0} MB. Use fewer bet sizes or a lower raise cap.",
                mb(mem_use), mb(mem_raw), max_mb
            ));
        }
        return Err(format!(
            "tree too large: {:.0} MB needed ({:.0} MB without compression), limit {:.0} MB (maxMemoryMB). Use fewer bet sizes or a lower raise cap.",
            mb(mem_use), mb(mem_raw), max_mb
        ));
    }
    game.allocate_memory(compress);
    let with_equity = cfg["equity"].as_bool().unwrap_or(true);
    Ok(Built::Ready(Solve {
        game, cfg: cfg.clone(), scale, with_equity, threads, combos, compress, mem_use, mem_raw, t_start,
        build_ms: now_ms() - t_start,
    }))
}

impl Solve {
    /// The "info" message (after the memory is allocated, before the solve).
    pub fn info(&self) -> Value {
        json!({ "type": "info", "memoryMB": mb(self.mem_use).round(), "memoryRawMB": mb(self.mem_raw).round(),
            "compressed": self.compress, "threads": self.threads, "combos": self.combos, "buildMs": self.build_ms as u64 })
    }

    /// True when the config asks for stats only (no node queries after the solve).
    pub fn stats_only(&self) -> bool {
        self.cfg["mode"].as_str() == Some("stats")
    }

    /// Runs the solve. `emit` gets the "progress" messages. Returns the "done" message.
    /// `peak_mem` gives the peak memory in bytes (process RSS, or the WebAssembly memory size).
    pub fn run(&mut self, emit: &mut dyn FnMut(Value), now_ms: &dyn Fn() -> f64, peak_mem: &dyn Fn() -> u64) -> Value {
        let cfg = &self.cfg;
        let game = &mut self.game;
        let scale = self.scale;
        let pot = game.tree_config().starting_pot as f64;
        let max_iter = cfg["iterations"].as_u64().unwrap_or(1000) as u32;
        let target_pct = cfg["targetExploitability"].as_f64().unwrap_or(0.5);
        let max_sec = cfg["maxSeconds"].as_f64().unwrap_or(600.0);
        let t_solve = now_ms();
        let mut t: u32 = 0;
        let mut last_check: u32 = 0;
        let mut expl_pct: Option<f64> = None;
        let mut hist: Vec<Value> = Vec::new();
        while t < max_iter {
            let ti = now_ms();
            solve_step(game, t);
            t += 1;
            let iter_ms = now_ms() - ti;
            let elapsed = (now_ms() - t_solve) / 1000.0;
            let last = t == max_iter || elapsed >= max_sec;
            let every = if iter_ms > 400.0 { 5 } else { 10 };
            if t - last_check >= every || last {
                last_check = t;
                let e = compute_exploitability(game) as f64 / pot * 100.0;
                expl_pct = Some(e);
                hist.push(json!([t, rnd(e, 4)]));
                emit(json!({ "type": "progress", "iteration": t, "exploitability": rnd(e, 4), "elapsedMs": (elapsed * 1000.0) as u64 }));
                if e <= target_pct {
                    break;
                }
            } else if iter_ms > 150.0 {
                emit(json!({ "type": "progress", "iteration": t, "exploitability": expl_pct.map(|e| rnd(e, 4)), "elapsedMs": (elapsed * 1000.0) as u64 }));
            }
            if last {
                break;
            }
        }
        finalize(game);
        let solve_ms = (now_ms() - t_solve) as u64;

        // root values
        game.back_to_root();
        game.cache_normalized_weights();
        let mut root_ev = [serde_json::Map::new(), serde_json::Map::new()];
        let mut root_eq = [serde_json::Map::new(), serde_json::Map::new()];
        let mut ev_avg = [0.0f64; 2];
        let mut eq_avg = [0.0f64; 2];
        for p in 0..2 {
            let ev = game.expected_values(p);
            let eq = game.equity(p);
            let nw = game.normalized_weights(p);
            ev_avg[p] = compute_average(&ev, nw) as f64 / scale;
            eq_avg[p] = compute_average(&eq, nw) as f64;
            for (h, &c) in game.private_cards(p).iter().enumerate() {
                if nw[h] > 0.0 {
                    root_ev[p].insert(hand_name(c), rnd(ev[h] as f64 / scale, 4));
                    root_eq[p].insert(hand_name(c), rnd(eq[h] as f64, 4));
                }
            }
        }
        let [ev_oop, ev_ip] = root_ev;
        let [eq_oop, eq_ip] = root_eq;
        json!({ "type": "done", "stats": {
            "iterations": t,
            "exploitabilityPctPot": expl_pct.map(|e| rnd(e, 4)),
            "solveMs": solve_ms,
            "ms": (now_ms() - self.t_start) as u64,
            "memoryMB": mb(self.mem_use).round(),
            "memoryRawMB": mb(self.mem_raw).round(),
            "peakRssMB": mb(peak_mem()).round(),
            "compressed": self.compress,
            "threads": self.threads,
            "combos": self.combos,
            "evOop": rnd(ev_avg[0], 3),
            "evIp": rnd(ev_avg[1], 3),
            "eqOop": rnd(eq_avg[0], 4),
            "eqIp": rnd(eq_avg[1], 4),
            "history": hist,
            "rootEv": { "oop": ev_oop, "ip": ev_ip },
            "rootEq": { "oop": eq_oop, "ip": eq_ip },
        }})
    }

    /// Node data for a path from the root (after `run`).
    pub fn node(&mut self, path: &[usize]) -> Result<Value, String> {
        node_info(&mut self.game, path, self.scale, self.with_equity)
    }
}

/// Parses a node query line {"id":n,"path":[...]}: (id, path), or the error answer.
pub fn parse_query(line: &str) -> Result<(Value, Vec<usize>), Value> {
    let q: Value = serde_json::from_str(line).map_err(|e| json!({ "id": null, "error": format!("bad query: {e}") }))?;
    let path = path_of(&q["path"]);
    Ok((q["id"].clone(), path))
}

/// A JSON array of indices as a path (bad entries become an index that is out of range).
pub fn path_of(v: &Value) -> Vec<usize> {
    v.as_array().map(|a| a.iter().map(|x| x.as_u64().map(|n| n as usize).unwrap_or(usize::MAX)).collect()).unwrap_or_default()
}
