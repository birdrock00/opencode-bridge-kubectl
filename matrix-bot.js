const MATRIX_HOMESERVER = (process.env.MATRIX_HOMESERVER || "").replace(/\/$/, "")
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || ""
const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || ""
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || ""
const MATRIX_DEVICE_ID = process.env.MATRIX_DEVICE_ID || "OPENCODE_BRIDGE_001"
const MATRIX_SYNC_TIMEOUT_MS = parseInt(process.env.MATRIX_SYNC_TIMEOUT_MS || "30000", 10)
const MATRIX_TRIGGER = process.env.MATRIX_TRIGGER || "!oc"
const MATRIX_BOT_NAME = process.env.MATRIX_BOT_NAME || "opencode"
const MATRIX_ALLOWED_ROOMS = new Set(
  (process.env.MATRIX_ROOM_ID || process.env.MATRIX_ALLOWED_ROOMS || "")
    .split(",")
    .map((room) => room.trim())
    .filter(Boolean),
)
const BRIDGE_URL = (process.env.OPENCODE_BRIDGE_URL || `http://127.0.0.1:${process.env.PORT || "5000"}`).replace(/\/$/, "")
const CHAT_MODEL = process.env.CHAT_MODEL || process.env.DEFAULT_MODEL || "opencode/gpt-5-nano"
const CHAT_MODEL_ALIASES = parseModelAliases(process.env.CHAT_MODEL_ALIASES || "")
const roomModels = new Map()

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
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
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

async function answerWithOpenCode(prompt, conversationId, model) {
  const response = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-conversation-id": conversationId,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: `You are running inside a Kubernetes administration pod. Use the shell/kubectl tools available to you to satisfy this request, then return the command output and a brief status summary.\n\nRequest: ${prompt}`,
        },
      ],
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`OpenCode bridge failed with HTTP ${response.status}: ${text}`)
  }
  const data = JSON.parse(text)
  return data.choices?.[0]?.message?.content || "(no response)"
}

function messageBody(event) {
  if (event?.type !== "m.room.message") return ""
  if (event?.content?.msgtype !== "m.text") return ""
  return event.content.body || ""
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

  log(`handling ${MATRIX_TRIGGER} request in ${roomId} from ${event.sender}`)
  try {
    const answer = await answerWithOpenCode(request, bridgeConversationId(roomId, event), model)
    await sendMessage(token, roomId, answer)
  } catch (error) {
    console.error(error)
    await sendMessage(token, roomId, `OpenCode request failed: ${error.message}`)
  }
}

async function main() {
  requireEnv("MATRIX_HOMESERVER", MATRIX_HOMESERVER)
  const token = await getAccessToken()
  const whoami = await matrixFetch("/_matrix/client/v3/account/whoami", { token })
  const ownUserId = whoami.user_id || MATRIX_USER_ID
  let since = ""

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
