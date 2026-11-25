# AGENTS.md

Guidance for coding agents (Claude Code and others) working in this repository.

## Commands

| Task | Command |
| ---- | ------- |
| Run in Docker | `just up` (stop: `just down`) |
| Test in Docker | `just test` |
| Run without Docker | `node server.js` (port 8787; `PORT=<n>` for another port) |
| Run without the Rust engine | `SKIP_ENGINES=postflop node server.js` |
| Build Rust engine | `cargo build --release --manifest-path engines/postflop/rs/Cargo.toml` |
| Test heads-up preflop | `node engines/hu-preflop/test.js` |
| Test 6-max preflop | `node engines/sixmax-preflop/test.js` |
| Test JS postflop | `node engines/postflop-js/test.js` |
| Test Rust postflop | `node engines/postflop/test.js` |
| Build the Rust engine as WebAssembly | `tools/build-wasm.sh` (pinned nightly for threads + stable for one thread; writes `engines/postflop/rs/target/web/`) |
| Build the static site (browser mode) | `node tools/build-web.js` (writes `dist/`; run `tools/build-wasm.sh` first for the Rust engine) |

There is no `package.json`: the project uses Node.js 26 built-ins only. Do not add npm packages.

## Layout

- `CONTRACT.md` — the node format, engine interface and HTTP API. Read it before you change an engine or the UI.
- `server.js` — loads every `engines/*/index.js`, runs solves, serves `public/`.
- `engines/` — one folder per solver; each has `index.js`, `test.js` and `README.md`.
- `lib/` — shared hand evaluator and equity table (`equity.js`, `equity.json`), flop subset, realization samples,
  solve jobs (`solves.js`). Node-only parts (files, SHA-1, equity table load) are in `platform.js` and `equity-data.js`.
- `public/` — browser UI (plain HTML, CSS and JavaScript). `public/browser/` holds the static site's in-page API and
  the browser versions of `platform.js`, `equity-data.js`, `path`, `worker_threads` and the postflop engine's
  `backend.js` (`postflop-backend.js`, with the WebAssembly worker `postflop-worker.js`).
- `tools/` — batch calibration scripts and the static site build (`build-web.js`, `build-wasm.sh`).
- `cache/` — solve caches and calibration samples (ignored by git, created at run time).

## Conventions

- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
- No AI co-author or "Generated with" lines in commit messages or PR bodies (no `Co-authored-by:` naming an agent).
  `.claude/settings.json` turns them off for Claude Code, squash merges use the PR title only, and the CI job
  "Commit messages" fails on them. A trailer that reaches main adds the agent to the GitHub contributors list.
- Never commit secrets or credentials.
- Long solves run in worker threads or child processes; never block the server's event loop.
- Shared modules (`lib/`, the JavaScript engines) must also run in the browser: use `lib/platform.js` for files and
  hashes, not `fs` or `crypto`. `node tools/build-web.js` stops on any other Node built-in.
- Keep the AGPL-3.0 license notices; the Rust engine links postflop-solver (AGPL-3.0-or-later).
- The Rust engine has one copy of its logic (`engines/postflop/rs/src/lib.rs`) and two front ends: the native process
  (`main.rs`) and WebAssembly (`wasm.rs`). Change the logic in `lib.rs`, and keep the messages of both the same.
