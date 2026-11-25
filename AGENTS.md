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

There is no `package.json`: the project uses Node.js 26 built-ins only. Do not add npm packages.

## Layout

- `CONTRACT.md` — the node format, engine interface and HTTP API. Read it before you change an engine or the UI.
- `server.js` — loads every `engines/*/index.js`, runs solves, serves `public/`.
- `engines/` — one folder per solver; each has `index.js`, `test.js` and `README.md`.
- `lib/` — shared hand evaluator and equity table (`equity.js`, `equity.json`), flop subset, realization samples.
- `public/` — browser UI (plain HTML, CSS and JavaScript).
- `tools/` — batch calibration scripts.
- `cache/` — solve caches and calibration samples (ignored by git, created at run time).

## Conventions

- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
- Never commit secrets or credentials.
- Long solves run in worker threads or child processes; never block the server's event loop.
- Keep the AGPL-3.0 license notices; the Rust engine links postflop-solver (AGPL-3.0-or-later).
