image := "ghcr.io/mortennordbye/cfr-poker-lab:latest"
url := "http://localhost:" + env_var_or_default("CFR_PORT", "8787")

default:
    @just --list

# Build the image locally and start the app in the background
up:
    docker compose up -d --build
    @echo "cfr-poker-lab running at {{url}}"

# Start with the published image from ghcr.io (no local build)
pull:
    docker compose pull
    docker compose up -d --no-build
    @echo "cfr-poker-lab running at {{url}}"

# Stop the app (solves and calibration samples stay in the cfr_cache volume)
down:
    docker compose down

restart:
    docker compose restart

logs:
    docker compose logs -f

# Open the app in the browser
open:
    open {{url}}

# Build the image, then run every engine test suite inside it (a throwaway cache, not the real one)
test:
    docker compose build
    docker run --rm --tmpfs /app/cache:uid=1000,gid=1000 {{image}} sh -c '\
      node engines/hu-preflop/test.js && \
      node engines/sixmax-preflop/test.js && \
      node engines/postflop-js/test.js && \
      node engines/postflop/test.js'

# Run without Docker (needs Node 26, and Rust for the postflop engine)
dev:
    node server.js
