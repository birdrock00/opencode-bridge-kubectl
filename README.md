# opencode-bridge-kubectl

Container image for running OpenCode with `kubectl`, an OpenAI-compatible HTTP
bridge, and an optional Matrix chat connector.

The image can be used in two modes:

- **API bridge**: exposes `/v1/chat/completions`, `/v1/models`, and `/health`
  while forwarding work to the bundled OpenCode server or an external
  `OPENCODE_URL`.
- **Matrix bridge**: starts the API bridge internally and responds to Matrix
  messages beginning with `!oc` by default.

The container includes `kubectl`, `git`, `ssh`, and `ansible`; give it only the
Kubernetes credentials and repository access that its workload needs.

All hostnames, users, room IDs, repositories, and credentials in this document
are intentionally fabricated examples. Do not use them as credentials.

## Container Image

GitHub Actions publishes images to GHCR on changes to `main`:

```text
ghcr.io/birdrock00/opencode-bridge-kubectl:latest
```

## Required Inputs

For API bridge mode:

- OpenCode must have credentials/configuration for the provider selected by
  `OPENCODE_PROVIDER_ID` and `DEFAULT_MODEL`. These provider credentials are
  consumed by OpenCode, not interpreted by `bridge.js`.
- Set `OPENCODE_PROXY_API_KEY` if the HTTP API will be reachable by anything
  outside a trusted local network.

For Matrix bridge mode:

- `MATRIX_HOMESERVER`
- Either `MATRIX_ACCESS_TOKEN`, or both `MATRIX_USER_ID` and
  `MATRIX_PASSWORD`
- OpenCode provider credentials/configuration for the selected model

Important: the current in-container Matrix connector does not attach
`OPENCODE_PROXY_API_KEY` to its requests to the API bridge. For Matrix mode,
leave `OPENCODE_PROXY_API_KEY` unset and do not publish the proxy port outside
the pod/container. Use API bridge mode separately when authenticated HTTP
access is required.

## Environment Variables

### OpenCode And API Bridge

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `5000` | HTTP port for the OpenAI-compatible bridge. |
| `OPENCODE_URL` | No | `http://localhost:4096` | OpenCode REST endpoint used by the bridge. The entrypoint sets a localhost URL automatically when it starts the bundled server. |
| `OPENCODE_SERVER_USERNAME` | No | `opencode` | Basic-auth user for `OPENCODE_URL` when `OPENCODE_SERVER_PASSWORD` is set. |
| `OPENCODE_SERVER_PASSWORD` | Recommended | Empty | Password used to protect and access the bundled or external OpenCode server. |
| `OPENCODE_PROVIDER_ID` | No | `github-copilot` | OpenCode provider identifier sent with bridge requests. Select a provider configured in OpenCode. |
| `DEFAULT_MODEL` | No | `gpt-4o` | Default model for HTTP API requests that omit `model`; also a fallback for Matrix `CHAT_MODEL`. |
| `OPENCODE_PROXY_API_KEY` | Recommended for API mode | Empty | Bearer token required by `/v1/*` endpoints when set. Do not set for the bundled Matrix mode described above. |
| `LOG_LEVEL` | No | `info` | Bridge logging level: `debug`, `info`, or `silent`. |
| `LOG_FILE` | No | Empty | Optional append-only bridge log file path, such as `/data/logs/bridge.log`. |
| `TIMEOUT_MS` | No | `600000` | OpenCode HTTP request timeout in milliseconds. |
| `HEARTBEAT_MS` | No | `15000` | SSE heartbeat interval in milliseconds. |
| `PROGRESS_POLL_MS` | No | `3000` | Interval for polling and emitting streaming progress. |
| `RETRY_COUNT` | No | `2` | Number of retries for eligible OpenCode request failures. |
| `RETRY_DELAY_MS` | No | `2000` | Delay between retries in milliseconds. |
| `SESSION_TTL_HOURS` | No | `2` | Age after which bridge-created OpenCode sessions may be cleaned up. |
| `CLEANUP_INTERVAL_MS` | No | `3600000` | Session cleanup interval in milliseconds. |

### Container Startup And Workspace

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `START_OPENCODE_SERVER` | No | `true` | Set to `false` to use only an external `OPENCODE_URL`. |
| `OPENCODE_SERVER_HOST` | No | `0.0.0.0` | Bind host for the bundled OpenCode server. |
| `OPENCODE_SERVER_PORT` | No | `4096` | Bind port for the bundled OpenCode server. |
| `OPENCODE_ENV_FILE` | No | `/secrets/opencode/.env` | Optional shell-format env file sourced by the entrypoint before startup. |
| `WORKSPACE_DIR` | No | `/workspace/rpi` | Working checkout used when OpenCode runs tools. Set this to your mounted or cloned project directory. |
| `GIT_REPO_URL` | No | Empty | Git repository cloned into `WORKSPACE_DIR` on every container start. |
| `GIT_CLONE_DEPTH` | No | `1` | Clone depth when `GIT_REPO_URL` is set. |
| `CONNECTOR` | No | Empty | Set to `matrix` to run the Matrix connector. Setting `MATRIX_HOMESERVER` also enables it. |

If `GIT_REPO_URL` requires credentials, configure standard Git/SSH
authentication through an appropriate read-only mount or credential mechanism.
Do not store private keys in an image or ConfigMap.

### Matrix Connector

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MATRIX_HOMESERVER` | Matrix mode | Empty | Matrix client-server base URL. |
| `MATRIX_ACCESS_TOKEN` | Conditional | Empty | Existing bot access token. When set, password login is skipped. |
| `MATRIX_USER_ID` | Conditional | Empty | Bot Matrix user ID; required with `MATRIX_PASSWORD` when no access token is provided. |
| `MATRIX_PASSWORD` | Conditional | Empty | Bot password for Matrix login when no access token is provided. |
| `MATRIX_DEVICE_ID` | No | `OPENCODE_BRIDGE_001` | Device ID used during password login. |
| `MATRIX_BOT_NAME` | No | `opencode` | Device display name used during password login. |
| `MATRIX_TRIGGER` | No | `!oc` | Prefix that invokes the bot. |
| `MATRIX_ROOM_ID` | No | Empty | Comma-separated room allowlist; takes precedence over `MATRIX_ALLOWED_ROOMS`. Empty allows all joined rooms. |
| `MATRIX_ALLOWED_ROOMS` | No | Empty | Comma-separated room allowlist used when `MATRIX_ROOM_ID` is empty. |
| `MATRIX_SYNC_TIMEOUT_MS` | No | `30000` | Matrix long-poll sync timeout in milliseconds. |
| `MATRIX_PROGRESS_INTERVAL_MS` | No | `60000` | Frequency of elapsed-time status updates in milliseconds. |
| `OPENCODE_BRIDGE_URL` | No | `http://127.0.0.1:${PORT}` | API bridge URL used by the Matrix connector. |
| `OPENCODE_REQUEST_TIMEOUT_MS` | No | `1860000` | Connector-to-bridge request timeout in milliseconds. |
| `CHAT_MODEL` | No | `DEFAULT_MODEL`, then `opencode/gpt-5-nano` | Model initially selected for Matrix conversations. |
| `CHAT_MODEL_ALIASES` | No | Empty | Comma-separated aliases in `alias=model-id` form for Matrix `model`/`using` commands. |

### OpenCode Provider Credentials

Provider credentials are pass-through environment values used by OpenCode.
The exact names depend on the OpenCode provider you select. For example, a
provider may accept a value such as `OPENAI_API_KEY`; consult OpenCode/provider
documentation and place secrets in Docker Compose secrets, a protected env
file, or a Kubernetes Secret.

## Docker Compose: Matrix Mode

This example runs only the Matrix connector interface. It intentionally does
not publish port `5000`, because Matrix mode currently uses the internal proxy
without `OPENCODE_PROXY_API_KEY`.

Create `.env` with synthetic values replaced by your own:

```dotenv
CONNECTOR=matrix
MATRIX_HOMESERVER=https://matrix.ember-quartz-731.example
MATRIX_ACCESS_TOKEN=syt_7dfba2b54245d69410f60612533bb3655f58
MATRIX_ROOM_ID=!ops_room_10c0c4ad7f47f7d2:matrix.ember-quartz-731.example
MATRIX_DEVICE_ID=OC_BRIDGE_4F92A1
MATRIX_BOT_NAME=quartz-opencode-helper
MATRIX_TRIGGER=!quartz

OPENCODE_SERVER_PASSWORD=password_Cf82ddpBJ3MdaVmwIplJg1MFZqI
OPENCODE_PROVIDER_ID=openai
DEFAULT_MODEL=gpt-4.1-mini
CHAT_MODEL=openai/gpt-4.1-mini
CHAT_MODEL_ALIASES=quick=openai/gpt-4.1-mini,deep=openai/o3-mini
OPENAI_API_KEY=sk-example_e513809fecf929f53d6cc4322b1e7df7587c1eec

WORKSPACE_DIR=/workspace/project
GIT_REPO_URL=https://github.com/lantern-sable-482/sample-infra-playground.git
GIT_CLONE_DEPTH=1
LOG_LEVEL=info
```

Create `compose.yaml`:

```yaml
services:
  opencode-matrix-bridge:
    image: ghcr.io/birdrock00/opencode-bridge-kubectl:latest
    env_file:
      - .env
    volumes:
      - workspace:/workspace
      - bridge-data:/data
    restart: unless-stopped

volumes:
  workspace:
  bridge-data:
```

Start it:

```bash
docker compose up -d
docker compose logs -f opencode-matrix-bridge
```

## Docker Compose: Authenticated API Mode

For API mode, publish the proxy port and provide a bearer token:

```yaml
services:
  opencode-api-bridge:
    image: ghcr.io/birdrock00/opencode-bridge-kubectl:latest
    ports:
      - "5000:5000"
    environment:
      OPENCODE_SERVER_PASSWORD: "password_Cf82ddpBJ3MdaVmwIplJg1MFZqI"
      OPENCODE_PROVIDER_ID: "openai"
      DEFAULT_MODEL: "gpt-4.1-mini"
      OPENAI_API_KEY: "sk-example_e513809fecf929f53d6cc4322b1e7df7587c1eec"
      OPENCODE_PROXY_API_KEY: "proxy_d03dd59872950c506ceda671ac85971cf9eb20fc"
      WORKSPACE_DIR: "/workspace/project"
    volumes:
      - workspace:/workspace
      - bridge-data:/data

volumes:
  workspace:
  bridge-data:
```

Example authenticated request:

```bash
curl http://localhost:5000/v1/chat/completions \
  -H 'Authorization: Bearer proxy_d03dd59872950c506ceda671ac85971cf9eb20fc' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"List the files in the workspace."}]}'
```

## Kubernetes: Matrix Mode

The following example uses a `Secret` for credentials and a `ConfigMap` for
non-secret controls. Every identity and secret below is fictitious.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: quartz-oc-bridge
---
apiVersion: v1
kind: Secret
metadata:
  name: opencode-bridge-secrets
  namespace: quartz-oc-bridge
type: Opaque
stringData:
  MATRIX_ACCESS_TOKEN: "syt_7dfba2b54245d69410f60612533bb3655f58"
  OPENCODE_SERVER_PASSWORD: "password_Cf82ddpBJ3MdaVmwIplJg1MFZqI"
  OPENAI_API_KEY: "sk-example_e513809fecf929f53d6cc4322b1e7df7587c1eec"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencode-bridge-config
  namespace: quartz-oc-bridge
data:
  CONNECTOR: "matrix"
  MATRIX_HOMESERVER: "https://matrix.ember-quartz-731.example"
  MATRIX_ROOM_ID: "!ops_room_10c0c4ad7f47f7d2:matrix.ember-quartz-731.example"
  MATRIX_DEVICE_ID: "OC_BRIDGE_4F92A1"
  MATRIX_BOT_NAME: "quartz-opencode-helper"
  MATRIX_TRIGGER: "!quartz"
  OPENCODE_PROVIDER_ID: "openai"
  DEFAULT_MODEL: "gpt-4.1-mini"
  CHAT_MODEL: "openai/gpt-4.1-mini"
  CHAT_MODEL_ALIASES: "quick=openai/gpt-4.1-mini,deep=openai/o3-mini"
  WORKSPACE_DIR: "/workspace/project"
  GIT_REPO_URL: "https://github.com/lantern-sable-482/sample-infra-playground.git"
  GIT_CLONE_DEPTH: "1"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-matrix-bridge
  namespace: quartz-oc-bridge
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode-matrix-bridge
  template:
    metadata:
      labels:
        app: opencode-matrix-bridge
    spec:
      containers:
        - name: bridge
          image: ghcr.io/birdrock00/opencode-bridge-kubectl:latest
          envFrom:
            - configMapRef:
                name: opencode-bridge-config
            - secretRef:
                name: opencode-bridge-secrets
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: data
              mountPath: /data
          readinessProbe:
            httpGet:
              path: /health
              port: 5000
            initialDelaySeconds: 20
            periodSeconds: 15
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 500m
              memory: 1Gi
      volumes:
        - name: workspace
          emptyDir: {}
        - name: data
          emptyDir: {}
```

For an authenticated API-only Kubernetes deployment, omit all `MATRIX_*`
values and `CONNECTOR`, set `OPENCODE_PROXY_API_KEY` in the `Secret`, and add
a `Service`/Ingress appropriate for your authentication and network policy.

## Kubernetes Access

The image carries `kubectl`, but no cluster access is granted automatically.
For in-cluster use, set `serviceAccountName` on the pod and bind only the RBAC
permissions required by the tasks the bot is allowed to perform. Avoid broad
cluster-admin credentials for a chat-triggered workload.

## Build Arguments

These values are used only when building the image:

| Argument | Default | Description |
| --- | --- | --- |
| `OPENCODE_BRIDGE_REPO` | `https://github.com/crazyboy24/opencode-bridge.git` | Upstream proxy source repository cloned into the image. |
| `OPENCODE_BRIDGE_REF` | `main` | Upstream branch or ref to clone. |
