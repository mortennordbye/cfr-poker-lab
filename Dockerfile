# syntax=docker/dockerfile:1

# ---- Stage 1: build the Rust postflop engine ----
# Same Debian release (trixie) as the runtime stage, so the binary's glibc matches.
FROM rust:1-slim-trixie AS rust-build
WORKDIR /build
COPY engines/postflop/rs/Cargo.toml engines/postflop/rs/Cargo.lock ./
COPY engines/postflop/rs/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
 && cp target/release/postflop-engine /postflop-engine

# ---- Stage 2: runtime (Node only, no Rust toolchain) ----
FROM node:26-trixie-slim
LABEL org.opencontainers.image.title="cfr-poker-lab" \
      org.opencontainers.image.description="Local poker study tool: CFR solvers and a strategy browser" \
      org.opencontainers.image.source="https://github.com/mortennordbye/cfr-poker-lab" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /app
COPY server.js idle.js CONTRACT.md ./
COPY lib ./lib
COPY engines ./engines
COPY public ./public
COPY tools ./tools
COPY --from=rust-build /postflop-engine /usr/local/bin/postflop-engine

# cache/ holds solves and calibration samples; a named volume is mounted here.
RUN mkdir -p /app/cache && chown -R node:node /app/cache
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    POSTFLOP_BIN=/usr/local/bin/postflop-engine
EXPOSE 8787

# Node's own fetch: the slim image has no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/engines').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
