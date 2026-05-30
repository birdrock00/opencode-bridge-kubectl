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
const OPENCODE_REQUEST_TIMEOUT_MS = parseInt(process.env.OPENCODE_REQUEST_TIMEOUT_MS || "0", 10)
const CHAT_MODEL = process.env.CHAT_MODEL || process.env.DEFAULT_MODEL || "opencode/gpt-5-nano"
const CHAT_MODEL_ALIASES = parseModelAliases(process.env.CHAT_MODEL_ALIASES || "")
const threadModels = new Map()
const threadQueues = new Map()
const activeThreads = new Set()

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

function selectedModel(threadId) {
  return threadModels.get(threadId) || CHAT_MODEL
}

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

async function sendMessage(token, roomId, body, threadRootId = "", replyToEventId = "") {
  const chunks = body.match(/[\s\S]{1,3500}/g) || [body]
  let firstEventId = ""
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const content = {
      msgtype: "m.text",
      body: chunk,
    }
    if (threadRootId) {
      content["m.relates_to"] = {
        rel_type: "m.thread",
        event_id: threadRootId,
        is_falling_back: true,
        "m.in_reply_to": { event_id: replyToEventId || threadRootId },
      }
    }
    const event = await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: "PUT",
      token,
      body: JSON.stringify(content),
    })
    firstEventId ||= event.event_id || ""
  }
  return firstEventId
}

async function replaceMessage(token, roomId, eventId, body, threadRootId = "", replyToEventId = "") {
  if (!eventId) {
    await sendMessage(token, roomId, body, threadRootId, replyToEventId)
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

function threadKey(roomId, rootId) {
  return `${roomId}:${rootId}`
}

function bridgeConversationId(roomId, rootId) {
  return `matrix:${threadKey(roomId, rootId)}`
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

    if (OPENCODE_REQUEST_TIMEOUT_MS > 0) {
      request.setTimeout(OPENCODE_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`OpenCode request timed out after ${OPENCODE_REQUEST_TIMEOUT_MS}ms`))
      })
    }
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

    if (OPENCODE_REQUEST_TIMEOUT_MS > 0) {
      request.setTimeout(OPENCODE_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`OpenCode request timed out after ${OPENCODE_REQUEST_TIMEOUT_MS}ms`))
      })
    }
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

function threadRootId(event) {
  const relation = event?.content?.["m.relates_to"]
  return relation?.rel_type === "m.thread" ? relation.event_id || "" : ""
}

function isTriggerMessage(body) {
  return body === MATRIX_TRIGGER || body.startsWith(`${MATRIX_TRIGGER} `)
}

async function isActiveThread(token, roomId, rootId) {
  const key = threadKey(roomId, rootId)
  if (activeThreads.has(key)) return true
  try {
    const root = await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rootId)}`, { token })
    if (isTriggerMessage(messageBody(root).trim())) {
      activeThreads.add(key)
      return true
    }
  } catch {
    logError("failed to load Matrix thread root")
  }
  return false
}

function enqueueThreadTask(key, task) {
  const previous = threadQueues.get(key) || Promise.resolve()
  const next = previous.then(task, task).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key)
  })
  threadQueues.set(key, next)
  return next
}

async function completeRequest(token, roomId, request, conversationId, model, statusEventId, rootId, replyToEventId) {
  const startedAt = Date.now()
  let progressUpdate = Promise.resolve()
  const progress = setInterval(() => {
    progressUpdate = progressUpdate
      .then(() => replaceMessage(
        token,
        roomId,
        statusEventId,
        `Running ${model}; ${formatElapsed(Date.now() - startedAt)} elapsed. I will post the result when it finishes.`,
        rootId,
        replyToEventId,
      ))
      .catch(() => logError("failed to update progress status"))
  }, MATRIX_PROGRESS_INTERVAL_MS)

  try {
    const answer = await answerWithOpenCode(request, conversationId, model, (text) => {
      progressUpdate = progressUpdate
        .then(async () => {
          const body = `Live output (${formatElapsed(Date.now() - startedAt)} elapsed):\n${formatProgress(text)}`
          await sendMessage(token, roomId, body, rootId, replyToEventId)
        })
        .catch(() => logError("failed to publish live progress"))
    })
    clearInterval(progress)
    await progressUpdate
    await replaceMessage(token, roomId, statusEventId, `Completed ${model} after ${formatElapsed(Date.now() - startedAt)}. Posting result.`, rootId, replyToEventId)
      .catch(() => logError("failed to update completion status"))
    await sendMessage(token, roomId, answer, rootId, replyToEventId)
  } catch {
    logError("OpenCode request failed")
    clearInterval(progress)
    await progressUpdate
    await replaceMessage(token, roomId, statusEventId, `Failed ${model} after ${formatElapsed(Date.now() - startedAt)}.`, rootId, replyToEventId)
      .catch(() => logError("failed to update failure status"))
    await sendMessage(token, roomId, "OpenCode request failed.", rootId, replyToEventId)
  } finally {
    clearInterval(progress)
  }
}

async function handleTimelineEvent(token, roomId, event, ownUserId) {
  if (event.sender === ownUserId) return
  if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) return

  const body = messageBody(event).trim()
  if (!body) return

  let rootId = threadRootId(event)
  const startsThread = !rootId && isTriggerMessage(body)
  if (!startsThread && (!rootId || !(await isActiveThread(token, roomId, rootId)))) return
  if (startsThread) {
    rootId = event.event_id
    if (!rootId) return
    activeThreads.add(threadKey(roomId, rootId))
  }

  const prompt = startsThread ? body.slice(MATRIX_TRIGGER.length).trim() : body
  const key = threadKey(roomId, rootId)
  const controlPrompt = startsThread
    ? prompt
    : (isTriggerMessage(body) ? body.slice(MATRIX_TRIGGER.length).trim() : "")
  const isControlMessage = startsThread || isTriggerMessage(body)
  if (!prompt) {
    await sendMessage(token, roomId, `Started a new OpenCode conversation. Reply in this thread with the first request, or use ${MATRIX_TRIGGER} model <alias> to select a model.`, rootId, event.event_id)
    return
  }

  const modelCommand = isControlMessage && controlPrompt.match(/^model(?:\s+(.+))?$/i)
  if (modelCommand) {
    const modelName = (modelCommand[1] || "").trim()
    if (!modelName) {
      await sendMessage(token, roomId, `Current model: ${selectedModel(key)}\n\nAvailable models:\n${modelList()}`, rootId, event.event_id)
      return
    }
    const model = resolveModel(modelName)
    threadModels.set(key, model)
    await sendMessage(token, roomId, `OpenCode model set to ${model}. Reply in this thread with a request.`, rootId, event.event_id)
    return
  }

  if (isControlMessage && /^models$/i.test(controlPrompt)) {
    await sendMessage(token, roomId, `Available models:\n${modelList()}`, rootId, event.event_id)
    return
  }

  const usingCommand = isControlMessage && controlPrompt.match(/^using\s+(\S+)\s+([\s\S]+)$/i)
  const model = usingCommand ? resolveModel(usingCommand[1]) : selectedModel(key)
  const request = usingCommand ? usingCommand[2].trim() : prompt
  if (!request) {
    await sendMessage(token, roomId, `Usage: ${MATRIX_TRIGGER} using <alias|model-id> <request>`, rootId, event.event_id)
    return
  }

  log("handling Matrix request")
  void enqueueThreadTask(key, async () => {
    const statusEventId = await sendMessage(token, roomId, `Accepted. Running ${model}; I will post the result when it finishes.`, rootId, event.event_id)
    await completeRequest(token, roomId, request, bridgeConversationId(roomId, rootId), model, statusEventId, rootId, event.event_id)
  })
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

main().catch(() => {
  logError("Matrix connector terminated")
  process.exit(1)
})
