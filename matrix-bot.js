import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

const MATRIX_HOMESERVER = (process.env.MATRIX_HOMESERVER || "").replace(/\/$/, "")
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || ""
const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || ""
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || ""
const MATRIX_DEVICE_ID = process.env.MATRIX_DEVICE_ID || "OPENCODE_BRIDGE_001"
const MATRIX_SYNC_TIMEOUT_MS = parseInt(process.env.MATRIX_SYNC_TIMEOUT_MS || "30000", 10)
const MATRIX_BOT_NAME = process.env.MATRIX_BOT_NAME || "opencode"
const MATRIX_ALLOWED_ROOMS = new Set(
  (process.env.MATRIX_ROOM_ID || process.env.MATRIX_ALLOWED_ROOMS || "")
    .split(",")
    .map((room) => room.trim())
    .filter(Boolean),
)
const BRIDGE_URL = (process.env.OPENCODE_BRIDGE_URL || `http://127.0.0.1:${process.env.PORT || "5000"}`).replace(/\/$/, "")
const OPENCODE_REQUEST_TIMEOUT_MS = parseInt(process.env.OPENCODE_REQUEST_TIMEOUT_MS || "1860000", 10)
const CHAT_MODEL = process.env.CHAT_MODEL || process.env.DEFAULT_MODEL || "opencode/gpt-5-nano"

function log(message) {
  console.log(`[MATRIX] ${message}`)
}

function logError(message) {
  console.error(`[MATRIX] ${message}`)
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required for Matrix connector`)
  }
}

async function matrixFetch(path, options = {}) {
  const response = await fetch(`${MATRIX_HOMESERVER}${path}`, {
    ...options,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed with HTTP ${response.status}: ${text}`)
  }
  return data
}

async function getAccessToken() {
  if (MATRIX_ACCESS_TOKEN) return MATRIX_ACCESS_TOKEN

  requireEnv("MATRIX_USER_ID", MATRIX_USER_ID)
  requireEnv("MATRIX_PASSWORD", MATRIX_PASSWORD)

  const data = await matrixFetch("/_matrix/client/v3/login", {
    method: "POST",
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: MATRIX_USER_ID },
      password: MATRIX_PASSWORD,
      device_id: MATRIX_DEVICE_ID,
      initial_device_display_name: MATRIX_BOT_NAME,
    }),
  })
  log("authenticated with Matrix")
  return data.access_token
}

// Post a plain text message to the room. No threads, no replies, no edits —
// each response is just one or more regular messages in the channel.
async function sendMessage(token, roomId, body) {
  const chunks = body.match(/[\s\S]{1,3500}/g) || [body]
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(4)}`
    await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: "PUT",
      token,
      body: JSON.stringify({
        msgtype: "m.text",
        body: chunk,
      }),
    })
  }
}

function bridgeConversationId(roomId, event) {
  return `matrix:${roomId}:${event.event_id || event.origin_server_ts || Date.now()}`
}

function requestBridge(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BRIDGE_URL}${path}`)
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest
    const { body, ...requestOptions } = options
    const request = requestFn(url, requestOptions, (response) => {
      let text = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        text += chunk
      })
      response.on("end", () => {
        const status = response.statusCode || 0
        resolve({ ok: status >= 200 && status < 300, status, text })
      })
    })

    request.setTimeout(OPENCODE_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`OpenCode request timed out after ${OPENCODE_REQUEST_TIMEOUT_MS}ms`))
    })
    request.on("error", reject)
    if (body) request.write(body)
    request.end()
  })
}

function requestBridgeStream(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BRIDGE_URL}${path}`)
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest
    const { body, ...requestOptions } = options
    const request = requestFn(url, requestOptions, (response) => {
      const status = response.statusCode || 0
      let raw = ""
      let buffer = ""
      let answer = ""
      let streamError = ""

      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        if (status < 200 || status >= 300) {
          raw += chunk
          return
        }
        buffer += chunk
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() || ""
        for (const block of blocks) {
          const lines = block.split(/\r?\n/)
          const dataText = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!dataText || dataText === "[DONE]") continue
          const data = JSON.parse(dataText)
          if (data.error) {
            streamError = data.error.message || "OpenCode bridge stream failed"
          } else {
            answer += data.choices?.[0]?.delta?.content || ""
          }
        }
      })
      response.on("end", () => {
        if (status < 200 || status >= 300) {
          resolve({ ok: false, status, text: raw })
        } else if (streamError) {
          reject(new Error(streamError))
        } else {
          resolve({ ok: true, status, text: answer || "(no response)" })
        }
      })
    })

    request.setTimeout(OPENCODE_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`OpenCode request timed out after ${OPENCODE_REQUEST_TIMEOUT_MS}ms`))
    })
    request.on("error", reject)
    if (body) request.write(body)
    request.end()
  })
}

async function answerWithOpenCode(prompt, conversationId, model) {
  const response = await requestBridgeStream("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-conversation-id": conversationId,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        {
          role: "user",
          content: `You are running inside a Kubernetes administration pod. Use the shell/kubectl tools available to you to satisfy this request, then return the command output and a brief status summary.\n\nRequest: ${prompt}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenCode bridge failed with HTTP ${response.status}: ${response.text}`)
  }
  return response.text
}

// Plain text message bodies count as instructions. Message edits (m.replace)
// are ignored so editing a previous message never re-triggers a request.
function messageBody(event) {
  if (event?.type !== "m.room.message") return ""
  if (event?.content?.msgtype !== "m.text") return ""
  if (event?.content?.["m.relates_to"]?.rel_type === "m.replace") return ""
  return event.content.body || ""
}

async function completeRequest(token, roomId, request, conversationId, model) {
  try {
    const answer = await answerWithOpenCode(request, conversationId, model)
    await sendMessage(token, roomId, answer)
    log("posted OpenCode response")
  } catch {
    logError("OpenCode request failed")
    await sendMessage(token, roomId, "OpenCode request failed.")
  }
}

async function handleTimelineEvent(token, roomId, event, ownUserId) {
  if (event.sender === ownUserId) return
  if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) return

  const body = messageBody(event).trim()
  if (!body) return

  log("handling Matrix request")
  void completeRequest(token, roomId, body, bridgeConversationId(roomId, event), CHAT_MODEL)
    .catch(() => logError("background Matrix request failed"))
}

async function main() {
  requireEnv("MATRIX_HOMESERVER", MATRIX_HOMESERVER)
  const token = await getAccessToken()
  const whoami = await matrixFetch("/_matrix/client/v3/account/whoami", { token })
  const ownUserId = whoami.user_id || MATRIX_USER_ID
  const initialSync = await matrixFetch("/_matrix/client/v3/sync?timeout=0", { token })
  let since = initialSync.next_batch || ""

  log("listening for Matrix requests")
  while (true) {
    try {
      const query = new URLSearchParams({ timeout: String(MATRIX_SYNC_TIMEOUT_MS) })
      if (since) query.set("since", since)
      const sync = await matrixFetch(`/_matrix/client/v3/sync?${query.toString()}`, { token })
      since = sync.next_batch || since

      for (const roomId of Object.keys(sync.rooms?.invite || {})) {
        if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) continue
        log("joining invited Matrix room")
        await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
          method: "POST",
          token,
          body: JSON.stringify({}),
        })
      }

      for (const [roomId, room] of Object.entries(sync.rooms?.join || {})) {
        for (const event of room.timeline?.events || []) {
          await handleTimelineEvent(token, roomId, event, ownUserId)
        }
      }
    } catch {
      logError("Matrix sync failed; retrying")
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

main().catch((err) => {
  logError(`Matrix connector terminated: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
