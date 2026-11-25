// WebAssembly front end of src/lib.rs (wasm-bindgen), for the static site. AGPL-3.0-or-later (links postflop-solver).
// public/browser/postflop-worker.js loads it in a Web Worker and turns the calls into the same messages as the
// native process (src/main.rs) prints. Feature "wasm-threads": rayon threads on Web Workers (wasm-bindgen-rayon).

use crate::{build, path_of, Built, Solve};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[cfg(feature = "wasm-threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

fn now_ms() -> f64 {
    js_sys::Date::now()
}

// The WebAssembly memory only grows, so its size is the peak.
fn memory_bytes() -> u64 {
    core::arch::wasm32::memory_size(0) as u64 * 65536
}

#[wasm_bindgen]
pub fn memory_mb() -> f64 {
    memory_bytes() as f64 / (1024.0 * 1024.0)
}

#[wasm_bindgen]
pub fn threaded() -> bool {
    cfg!(feature = "wasm-threads")
}

#[wasm_bindgen]
pub struct Engine {
    solve: Option<Solve>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        // With panic=abort a panic ends in a trap with no text: hand the text to the worker first
        // (self.__postflopPanic), so it can tell a panic from an allocation failure (out of memory).
        std::panic::set_hook(Box::new(|info| {
            let f = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("__postflopPanic"));
            if let Ok(f) = f {
                if let Some(f) = f.dyn_ref::<js_sys::Function>() {
                    let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&info.to_string()));
                }
            }
        }));
        Engine { solve: None }
    }

    /// Builds the tree and solves. `on_message(json)` gets the "info" and "progress" messages. Returns the "done"
    /// message (or "estimate" in mode "estimate") as JSON. Throws the error text on a bad config or a tree that is
    /// too large. `threads`: the rayon pool size (init_thread_pool), shown in the stats.
    pub fn solve(&mut self, config: &str, threads: usize, on_message: &js_sys::Function) -> Result<String, JsError> {
        self.solve = None;
        let t_start = now_ms();
        let cfg: Value = serde_json::from_str(config).map_err(|e| JsError::new(&format!("bad config: {e}")))?;
        let send = |v: Value| {
            let _ = on_message.call1(&JsValue::NULL, &JsValue::from_str(&v.to_string()));
        };
        let mut solve = match build(&cfg, threads, t_start, &now_ms) {
            Ok(Built::Estimate(v)) => return Ok(v.to_string()),
            Ok(Built::Ready(s)) => s,
            Err(e) => return Err(JsError::new(&e)),
        };
        send(solve.info());
        let done = solve.run(&mut |v| send(v), &now_ms, &memory_bytes);
        if !solve.stats_only() {
            self.solve = Some(solve);
        }
        Ok(done.to_string())
    }

    /// Node data as JSON for a path from the root (array of indices). Throws on a bad path.
    pub fn node(&mut self, path: &str) -> Result<String, JsError> {
        let s = self.solve.as_mut().ok_or_else(|| JsError::new("no solve"))?;
        let p: Value = serde_json::from_str(path).map_err(|e| JsError::new(&format!("bad query: {e}")))?;
        s.node(&path_of(&p)).map(|n| n.to_string()).map_err(|e| JsError::new(&e))
    }

    /// Frees the tree (the worker also ends when the solve is disposed).
    pub fn free_tree(&mut self) {
        self.solve = None;
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
