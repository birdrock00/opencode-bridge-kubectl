# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS bridge

ARG OPENCODE_BRIDGE_REPO=https://github.com/crazyboy24/opencode-bridge.git
ARG OPENCODE_BRIDGE_REF=main

WORKDIR /app
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${OPENCODE_BRIDGE_REF}" "${OPENCODE_BRIDGE_REPO}" .
RUN npm install --omit=dev

FROM docker.io/bitnami/kubectl:latest AS kubectl

FROM node:22-alpine AS runtime

ENV PORT=5000 \
    OPENCODE_SERVER_HOST=0.0.0.0 \
    OPENCODE_SERVER_PORT=4096 \
    OPENCODE_ENV_FILE=/secrets/opencode/.env \
    WORKSPACE_DIR=/workspace/rpi \
    START_OPENCODE_SERVER=true \
    HOME=/root \
    PATH=/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      git \
      tini \
      wget

COPY --from=bridge /app /app
COPY --from=kubectl /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl
COPY matrix-bot.js /app/matrix-bot.js

RUN chmod +x /usr/local/bin/kubectl \
    && curl -fsSL https://opencode.ai/install | bash \
    && mkdir -p /workspace /data

COPY <<'EOF' /usr/local/bin/start-opencode-bridge
#!/bin/sh
set -eu

log() {
  echo "[STARTUP] $*"
}

if [ -f "$OPENCODE_ENV_FILE" ]; then
  log "Loading environment from $OPENCODE_ENV_FILE"
  set -a
  . "$OPENCODE_ENV_FILE"
  set +a
else
  log "No env file found at $OPENCODE_ENV_FILE; continuing with Kubernetes environment"
fi

mkdir -p "$(dirname "$WORKSPACE_DIR")" /data

if [ -n "${GIT_REPO_URL:-}" ]; then
  log "Refreshing git checkout from $GIT_REPO_URL"
  rm -rf "$WORKSPACE_DIR"
  git clone --depth "${GIT_CLONE_DEPTH:-1}" "$GIT_REPO_URL" "$WORKSPACE_DIR"
fi

if [ -d "$WORKSPACE_DIR/.git" ]; then
  cd "$WORKSPACE_DIR"
  git rev-parse --short HEAD 2>/dev/null | sed 's/^/[STARTUP] workspace checkout: /'
else
  log "Workspace checkout not present at $WORKSPACE_DIR"
  cd /app
fi

if [ "${START_OPENCODE_SERVER:-true}" = "true" ]; then
  export OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_SERVER_PORT}}"
  log "Starting OpenCode server on ${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}"
  opencode serve --hostname "$OPENCODE_SERVER_HOST" --port "$OPENCODE_SERVER_PORT" &
  opencode_pid="$!"

  trap 'kill "$opencode_pid" 2>/dev/null || true' INT TERM EXIT

  for _ in $(seq 1 60); do
    if wget -qO- "$OPENCODE_URL" >/dev/null 2>&1; then
      log "OpenCode server is reachable at $OPENCODE_URL"
      break
    fi
    sleep 1
  done
fi

cd /app
if [ "${CONNECTOR:-}" = "matrix" ] || [ -n "${MATRIX_HOMESERVER:-}" ]; then
  log "Starting OpenCode API bridge on port ${PORT}"
  node bridge.js &
  bridge_pid="$!"
  trap 'kill "$opencode_pid" "$bridge_pid" 2>/dev/null || true' INT TERM EXIT

  for _ in $(seq 1 60); do
    if wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      log "OpenCode API bridge is reachable on port ${PORT}"
      break
    fi
    sleep 1
  done

  log "Starting Matrix connector"
  exec node matrix-bot.js
fi

log "Starting OpenCode API bridge on port ${PORT}"
exec node bridge.js
EOF

RUN chmod +x /usr/local/bin/start-opencode-bridge

EXPOSE 5000 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["start-opencode-bridge"]
