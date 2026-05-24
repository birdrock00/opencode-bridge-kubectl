import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

const MATRIX_HOMESERVER = (process.env.MATRIX_HOMESERVER || "").replace(/\/$/, "")
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || ""
const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || ""
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || ""
const MATRIX_DEVICE_ID = process.env.MATRIX_DEVICE_ID || "OPENCODE_BRIDGE_001"
const MATRIX_SYNC_TIMEOUT_MS = parseInt(process.env.MATRIX_SYNC_TIMEOUT_MS || "30000", 10)
const MATRIX_PROGRESS_INTERVAL_MS = parseInt(process.env.MATRIX_PROGRESS_INTERVAL_MS || "60000", 10)
const MATRIX_TRIGGER = process.env.MATRIX_TRIGGER || "!oc"
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
const CHAT_MODEL_ALIASES = parseModelAliases(process.env.CHAT_MODEL_ALIASES || "")
const roomModels = new Map()
const activeRooms = new Set()

function parseModelAliases(value) {
  const aliases = new Map()
  for (const item of value.split(",")) {
    const [alias, ...modelParts] = item.split("=")
    const model = modelParts.join("=").trim()
    if (alias?.trim() && model) aliases.set(alias.trim().toLowerCase(), model)
  }
  return aliases
}

function modelList() {
  const aliases = [...CHAT_MODEL_ALIASES.entries()]
    .map(([alias, model]) => `${alias}: ${model}`)
    .join("\n")
  return [`default: ${CHAT_MODEL}`, aliases].filter(Boolean).join("\n")
}

function resolveModel(value) {
  const key = value.trim().toLowerCase()
  if (!key || key === "default") return CHAT_MODEL
  return CHAT_MODEL_ALIASES.get(key) || value.trim()
}

function selectedModel(roomId) {
  return roomModels.get(roomId) || CHAT_MODEL
}

function log(message) {
  console.log(`[MATRIX] ${message}`)
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
  log(`logged in as ${data.user_id}`)
  return data.access_token
}

async function sendMessage(token, roomId, body) {
  const chunks = body.match(/[\s\S]{1,3500}/g) || [body]
  let firstEventId = ""
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const event = await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: "PUT",
      token,
      body: JSON.stringify({
        msgtype: "m.text",
        body: chunk,
      }),
    })
    firstEventId ||= event.event_id || ""
  }
  return firstEventId
}

async function replaceMessage(token, roomId, eventId, body) {
  if (!eventId) {
    await sendMessage(token, roomId, body)
    return
  }

  const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
    method: "PUT",
    token,
    body: JSON.stringify({
      msgtype: "m.text",
      body: `* ${body}`,
      "m.new_content": { msgtype: "m.text", body },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    }),
  })
}

function formatElapsed(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function formatProgress(text) {
  if (text.length <= 3100) return text
  return `${text.slice(0, 1450)}\n\n... live output truncated ...\n\n${text.slice(-1450)}`
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

function requestBridgeStream(path, options = {}, onProgress) {
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
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message"
          const dataText = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!dataText || dataText === "[DONE]") continue
          const data = JSON.parse(dataText)
          if (event === "progress") {
            onProgress(data.text || "")
          } else if (data.error) {
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

async function answerWithOpenCode(prompt, conversationId, model, onProgress) {
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
  }, onProgress)

  if (!response.ok) {
    throw new Error(`OpenCode bridge failed with HTTP ${response.status}: ${response.text}`)
  }
  return response.text
}

function messageBody(event) {
  if (event?.type !== "m.room.message") return ""
  if (event?.content?.msgtype !== "m.text") return ""
  return event.content.body || ""
}

async function completeRequest(token, roomId, request, conversationId, model, statusEventId) {
  const startedAt = Date.now()
  let progressEventId = ""
  let progressUpdate = Promise.resolve()
  const progress = setInterval(() => {
    progressUpdate = progressUpdate
      .then(() => replaceMessage(
        token,
        roomId,
        statusEventId,
        `Running ${model}; ${formatElapsed(Date.now() - startedAt)} elapsed. I will post the result when it finishes.`,
      ))
      .catch((error) => console.error(error))
  }, MATRIX_PROGRESS_INTERVAL_MS)

  try {
    const answer = await answerWithOpenCode(request, conversationId, model, (text) => {
      progressUpdate = progressUpdate
        .then(async () => {
          const body = `Live output (${formatElapsed(Date.now() - startedAt)} elapsed):\n${formatProgress(text)}`
          if (progressEventId) {
            await replaceMessage(token, roomId, progressEventId, body)
          } else {
            progressEventId = await sendMessage(token, roomId, body)
          }
        })
        .catch((error) => console.error(error))
    })
    clearInterval(progress)
    await progressUpdate
    await replaceMessage(token, roomId, statusEventId, `Completed ${model} after ${formatElapsed(Date.now() - startedAt)}. Posting result.`)
      .catch((error) => console.error(error))
    await sendMessage(token, roomId, answer)
  } catch (error) {
    console.error(error)
    clearInterval(progress)
    await progressUpdate
    await replaceMessage(token, roomId, statusEventId, `Failed ${model} after ${formatElapsed(Date.now() - startedAt)}.`)
      .catch((editError) => console.error(editError))
    await sendMessage(token, roomId, `OpenCode request failed: ${error.message}`)
  } finally {
    clearInterval(progress)
    activeRooms.delete(roomId)
  }
}

async function handleTimelineEvent(token, roomId, event, ownUserId) {
  if (event.sender === ownUserId) return
  if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) return

  const body = messageBody(event).trim()
  if (!body.startsWith(MATRIX_TRIGGER)) return

  const prompt = body.slice(MATRIX_TRIGGER.length).trim()
  if (!prompt) {
    await sendMessage(token, roomId, `Usage: ${MATRIX_TRIGGER} <request>\n${MATRIX_TRIGGER} model <alias|model-id>\n${MATRIX_TRIGGER} using <alias|model-id> <request>`)
    return
  }

  const modelCommand = prompt.match(/^model(?:\s+(.+))?$/i)
  if (modelCommand) {
    const modelName = (modelCommand[1] || "").trim()
    if (!modelName) {
      await sendMessage(token, roomId, `Current model: ${selectedModel(roomId)}\n\nAvailable models:\n${modelList()}`)
      return
    }
    const model = resolveModel(modelName)
    roomModels.set(roomId, model)
    await sendMessage(token, roomId, `OpenCode model set to ${model}`)
    return
  }

  if (/^models$/i.test(prompt)) {
    await sendMessage(token, roomId, `Available models:\n${modelList()}`)
    return
  }

  const usingCommand = prompt.match(/^using\s+(\S+)\s+([\s\S]+)$/i)
  const model = usingCommand ? resolveModel(usingCommand[1]) : selectedModel(roomId)
  const request = usingCommand ? usingCommand[2].trim() : prompt
  if (!request) {
    await sendMessage(token, roomId, `Usage: ${MATRIX_TRIGGER} using <alias|model-id> <request>`)
    return
  }

  if (activeRooms.has(roomId)) {
    await sendMessage(token, roomId, "An OpenCode request is already running in this room.")
    return
  }

  log(`handling ${MATRIX_TRIGGER} request in ${roomId} from ${event.sender}`)
  activeRooms.add(roomId)
  let statusEventId
  try {
    statusEventId = await sendMessage(token, roomId, `Accepted. Running ${model}; I will post the result when it finishes.`)
  } catch (error) {
    activeRooms.delete(roomId)
    throw error
  }
  void completeRequest(token, roomId, request, bridgeConversationId(roomId, event), model, statusEventId)
    .catch((error) => console.error(error))
}

async function main() {
  requireEnv("MATRIX_HOMESERVER", MATRIX_HOMESERVER)
  const token = await getAccessToken()
  const whoami = await matrixFetch("/_matrix/client/v3/account/whoami", { token })
  const ownUserId = whoami.user_id || MATRIX_USER_ID
  const initialSync = await matrixFetch("/_matrix/client/v3/sync?timeout=0", { token })
  let since = initialSync.next_batch || ""

  log(`listening for ${MATRIX_TRIGGER} as ${ownUserId}`)
  while (true) {
    try {
      const query = new URLSearchParams({ timeout: String(MATRIX_SYNC_TIMEOUT_MS) })
      if (since) query.set("since", since)
      const sync = await matrixFetch(`/_matrix/client/v3/sync?${query.toString()}`, { token })
      since = sync.next_batch || since

      for (const roomId of Object.keys(sync.rooms?.invite || {})) {
        if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) continue
        log(`joining invited room ${roomId}`)
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
    } catch (error) {
      console.error(error)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
