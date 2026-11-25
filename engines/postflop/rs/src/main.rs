// Postflop engine process around b-inary/postflop-solver (AGPL-3.0-or-later). Native front end of src/lib.rs.
//
// Protocol (JSON lines):
//   stdin line 1: the solve config (built by ../index.js).
//   stdout: {"type":"info",...}, {"type":"progress",...}, then {"type":"done","stats":{...}}.
//   mode "stats": the process exits after "done".
//   mode "full": the process then reads queries {"id":n,"path":[...]} and answers
//   {"id":n,"node":{...}} or {"id":n,"error":"..."} until stdin closes.
//   Errors before "done": {"type":"error","error":"..."} and exit code 1.

use postflop_engine::{build, parse_query, Built};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::OnceLock;
use std::time::Instant;

fn emit(v: &Value) {
    let stdout = io::stdout();
    let mut s = stdout.lock();
    let _ = writeln!(s, "{}", v);
    let _ = s.flush();
}

fn fail(msg: &str) -> ! {
    emit(&json!({ "type": "error", "error": msg }));
    std::process::exit(1);
}

static T0: OnceLock<Instant> = OnceLock::new();
fn now_ms() -> f64 {
    T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn peak_rss_bytes() -> u64 {
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut ru) == 0 {
            let v = ru.ru_maxrss as u64;
            if cfg!(target_os = "macos") { v } else { v * 1024 }
        } else {
            0
        }
    }
}

fn main() {
    // Exit when the parent (Node) dies, even if it was killed with SIGKILL: no orphan solver processes.
    let parent = unsafe { libc::getppid() };
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if unsafe { libc::getppid() } != parent {
            std::process::exit(2);
        }
    });
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let first = match lines.next() {
        Some(Ok(l)) => l,
        _ => fail("no config on stdin"),
    };
    let cfg: Value = serde_json::from_str(&first).unwrap_or_else(|e| fail(&format!("bad config: {e}")));
    let t_start = now_ms();

    let threads = cfg["threads"].as_u64().unwrap_or(8).max(1) as usize;
    let _ = rayon::ThreadPoolBuilder::new().num_threads(threads).build_global();

    let mut solve = match build(&cfg, threads, t_start, &now_ms) {
        Ok(Built::Estimate(v)) => {
            emit(&v);
            return;
        }
        Ok(Built::Ready(s)) => s,
        Err(e) => fail(&e),
    };
    emit(&solve.info());
    let done = solve.run(&mut |v| emit(&v), &now_ms, &peak_rss_bytes);
    emit(&done);

    if solve.stats_only() {
        return;
    }
    for line in lines {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let (id, path) = match parse_query(&line) {
            Ok(q) => q,
            Err(answer) => {
                emit(&answer);
                continue;
            }
        };
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| solve.node(&path)));
        match res {
            Ok(Ok(node)) => emit(&json!({ "id": id, "node": node })),
            Ok(Err(e)) => emit(&json!({ "id": id, "error": e })),
            Err(_) => emit(&json!({ "id": id, "error": "solver panic on this node" })),
        }
    }
}
