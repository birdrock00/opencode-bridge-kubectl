/**
 * opencode-proxy
 * Translates OpenAI-compatible API requests → OpenCode V2 REST API → response
 * Supports streaming (SSE), image attachments, multi-provider routing,
 * session reuse with mid-conversation model switching, live progress,
 * retries, and session cleanup.
 *
 * https://github.com/crazyboy24/opencode-proxy
 */

import express from "express"
import fs      from "fs"
import nodePath from "path"

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT                 || "5000",    10)
const OPENCODE_URL  = (process.env.OPENCODE_URL                 || "http://localhost:4096").replace(/\/$/, "")
const OPENCODE_PASS = process.env.OPENCODE_SERVER_PASSWORD      || process.env.OPENCODE_PASSWORD || ""
const OPENCODE_USER = process.env.OPENCODE_SERVER_USERNAME      || "opencode"
const PROVIDER_ID   = process.env.OPENCODE_PROVIDER_ID          || "github-copilot"
const DEFAULT_MODEL = process.env.DEFAULT_MODEL                 || ""
const BRIDGE_KEY    = process.env.OPENCODE_PROXY_API_KEY        || ""
const LOG_LEVEL     = process.env.LOG_LEVEL                     || "info"
const LOG_FILE      = process.env.LOG_FILE                      || ""           // e.g. /data/logs/bridge.log
const TIMEOUT_MS    = parseInt(process.env.TIMEOUT_MS           || "600000",   10) // 0 = no timeout
const HEARTBEAT_MS  = parseInt(process.env.HEARTBEAT_MS         || "15000",    10)
const PROGRESS_POLL_MS = parseInt(process.env.PROGRESS_POLL_MS  || "3000",     10)
const RETRY_COUNT   = parseInt(process.env.RETRY_COUNT          || "2",        10)
const RETRY_DELAY   = parseInt(process.env.RETRY_DELAY_MS       || "2000",     10)
const SESSION_TTL_H = parseInt(process.env.SESSION_TTL_HOURS    || "2",        10)
const CLEANUP_EVERY = parseInt(process.env.CLEANUP_INTERVAL_MS  || "3600000",  10) // 1hr

const BRIDGE_VERSION = "2.0.0"

// ─── Session map (conversation → OpenCode session) ──────────────────────────
// Keyed by x-conversation-id header or a hash of the first user message.
// Allows the same OpenCode session to be reused across a multi-turn conversation,
// giving OpenCode full context of files opened, edits made, bash history, etc.
const sessionMap = new Map() // conversationId → { sessionId, providerID, modelID, lastUsed }
const SESSION_MAP_TTL = SESSION_TTL_H * 60 * 60 * 1000

function pruneSessionMap() {
  const cutoff = Date.now() - SESSION_MAP_TTL
  for (const [k, v] of sessionMap.entries()) {
    if (v.lastUsed < cutoff) sessionMap.delete(k)
  }
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString()

let logStream = null
if (LOG_FILE) {
  const dir = nodePath.dirname(LOG_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" })
}

function writeLog(line) {
  console.log(line)
  if (logStream) logStream.write(line + "\n")
}

const logger = {
  info:  (...a) => LOG_LEVEL !== "silent" && writeLog(`[${ts()}] INFO  ${a.join(" ")}`),
  debug: (...a) => LOG_LEVEL === "debug"  && writeLog(`[${ts()}] DEBUG ${a.join(" ")}`),
  error: (...a) => LOG_LEVEL !== "silent" && writeLog(`[${ts()}] ERROR ${a.join(" ")}`),
}

// ─── OpenCode V2 REST helpers ────────────────────────────────────────────────
//
// V2 API surface used by the bridge:
//   GET    /api/health                          → { healthy, version, pid }
//   GET    /api/model                           → { data: [{ providerID, modelID, ... }] }
//   POST   /api/session                         → { data: { id } }
//   POST   /api/session/{id}/model              → 204 (switches model for later prompts)
//   POST   /api/session/{id}/prompt             → { data: user message } (async)
//   POST   /api/session/{id}/wait               → 204 when the agent loop is idle
//   GET    /api/session/{id}/message            → { data: [messages] } NEWEST FIRST
//   GET    /api/session                         → { data: [sessions] }
//   DELETE /api/session/{id}                    → 204
//   PUT    /api/session/{id}/instructions/entries/{key} → 204

function withTimeout(ms) {
  if (!ms || ms <= 0) return { signal: undefined, clear: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function baseHeaders() {
  const h = { "Content-Type": "application/json" }
  if (OPENCODE_PASS) h["Authorization"] = `Basic ${Buffer.from(`${OPENCODE_USER}:${OPENCODE_PASS}`).toString("base64")}`
  return h
}

async function ocRequest(method, path, body, timeoutMs = TIMEOUT_MS) {
  const { signal, clear } = withTimeout(timeoutMs)
  try {
    const res = await fetch(`${OPENCODE_URL}${path}`, {
      method,
      headers: baseHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (err) {
    if (err.name === "AbortError") {
      const timeout = new Error(`OpenCode ${method} ${path} timed out after ${timeoutMs}ms`)
      timeout.name = "AbortError"
      throw timeout
    }
    throw err
  } finally {
    clear()
  }
}

async function ocGet(path, timeoutMs = TIMEOUT_MS) {
  const r = await ocRequest("GET", path, undefined, timeoutMs)
  if (!r.ok) throw new Error(`OpenCode GET ${path} → ${r.status}`)
  if (!r.text) return null
  try { return JSON.parse(r.text) }
  catch { throw new Error(`OpenCode GET ${path} → invalid JSON: ${r.text.slice(0, 300)}`) }
}

async function ocPost(path, body, timeoutMs = TIMEOUT_MS) {
  const r = await ocRequest("POST", path, body, timeoutMs)
  if (!r.ok) throw new Error(`OpenCode POST ${path} → ${r.status}: ${r.text.slice(0, 300)}`)
  if (!r.text) return null // 204 No Content (wait, model switch)
  try { return JSON.parse(r.text) }
  catch { throw new Error(`OpenCode POST ${path} → invalid JSON: ${r.text.slice(0, 300)}`) }
}

async function ocPut(path, body, timeoutMs = 10000) {
  const r = await ocRequest("PUT", path, body, timeoutMs)
  if (!r.ok) throw new Error(`OpenCode PUT ${path} → ${r.status}: ${r.text.slice(0, 300)}`)
  return null
}

async function ocDelete(path) {
  const r = await ocRequest("DELETE", path, undefined, 10000)
  return r.ok
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry(fn, retries = RETRY_COUNT, delayMs = RETRY_DELAY) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // Don't retry aborts (timeout) or 4xx errors
      if (err.name === "AbortError")              throw err
      if (err.message.match(/→ 4\d\d/))          throw err
      if (i < retries) {
        logger.error(`Attempt ${i + 1} failed: ${err.message} — retrying in ${delayMs}ms`)
        await new Promise(r => setTimeout(r, delayMs))
      }
    }
  }
  throw lastErr
}

// ─── Session cleanup ──────────────────────────────────────────────────────────

async function cleanupOldSessions() {
  try {
    const data     = await ocGet("/api/session", 30000)
    const sessions = Array.isArray(data) ? data : (data?.data ?? [])
    const cutoff   = Date.now() - SESSION_TTL_H * 60 * 60 * 1000
    let   deleted  = 0

    for (const s of sessions) {
      const created = s.time?.created ?? s.created ?? 0
      // Only delete sessions created by the bridge (title starts with "bridge-")
      if (created < cutoff && s.title?.startsWith("bridge-")) {
        const ok = await ocDelete(`/api/session/${s.id}`)
        if (ok) deleted++
      }
    }

    if (deleted > 0) logger.info(`Session cleanup: deleted ${deleted} old sessions (>${SESSION_TTL_H}h)`)
  } catch (err) {
    logger.error("Session cleanup failed:", err.message)
  }
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Converts an OpenAI image_url into a V2 file attachment ({ uri, name }).
 * data: URIs pass through; remote URLs are fetched and inlined as data URIs
 * (V2 attachments only accept data: and file: URIs).
 */
async function imageToAttachment(url, index) {
  if (url.startsWith("data:")) return { uri: url, name: `image-${index}` }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`image fetch ${url} → ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error(`image exceeds 20MB limit: ${url}`)
  const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0]
  return { uri: `data:${mime};base64,${buf.toString("base64")}`, name: `image-${index}` }
}

/**
 * Converts OpenAI messages → V2 prompt { text, files }.
 *
 * V2 prompts are text plus file attachments, so:
 * - system messages are handled separately (session instructions entry)
 * - assistant tool_calls and tool results are flattened into text
 * - image_url parts become file attachments (base64 data URIs)
 * - audio / file parts are silently skipped
 */
async function buildPrompt(messages) {
  const segments = []
  const files    = []

  for (const m of messages) {
    if (m.role === "system") continue
    const role = m.role.toUpperCase()

    // Assistant tool_calls (may also have text content)
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (typeof m.content === "string" && m.content) {
        segments.push(`[${role}]\n${m.content}`)
      }
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? tc.name
        const args = tc.function?.arguments ?? tc.arguments ?? "{}"
        segments.push(`[${role} tool_call]\n${name} ${args}`)
      }
      continue
    }

    // Tool result messages
    if (m.role === "tool") {
      segments.push(`[TOOL RESULT]\n${m.content ?? ""}`)
      continue
    }

    // String content
    if (typeof m.content === "string") {
      segments.push(`[${role}]\n${m.content}`)
      continue
    }

    // Array content (multimodal)
    if (Array.isArray(m.content)) {
      const texts  = []
      let   imgIdx = 0
      for (const c of m.content) {
        if (c.type === "text") {
          texts.push(c.text ?? "")
        } else if (c.type === "image_url") {
          const url = c.image_url?.url ?? ""
          if (!url) continue
          try {
            files.push(await imageToAttachment(url, imgIdx++))
          } catch (err) {
            logger.debug(`skipping image ${url}: ${err.message}`)
          }
        }
        // audio / file silently skipped
      }
      if (texts.length) segments.push(`[${role}]\n${texts.join("\n")}`)
    }
  }

  return { text: segments.join("\n\n"), files }
}

function toolOutputText(content) {
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) return content.map(p => p.text ?? "").join("").trim()
  return ""
}

function progressSnapshot(messages) {
  const segments = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message.type !== "assistant") continue
    for (const item of message.content ?? []) {
      if (item.type === "text" && item.text?.trim()) {
        segments.push(item.text.trim())
        continue
      }
      if (item.type !== "tool") continue
      const state  = item.state ?? {}
      const status = state.status ?? "running"
      const input  = state.input ? JSON.stringify(state.input).slice(0, 200) : ""
      const output = status === "completed" ? toolOutputText(state.content) : ""
      segments.push([`[tool ${status}] ${item.name ?? "tool"}${input ? ` ${input}` : ""}`, output].filter(Boolean).join("\n"))
    }
  }

  const text = segments.join("\n\n")
  if (text.length <= 3000) return text
  return `${text.slice(0, 1400)}\n\n... live output truncated ...\n\n${text.slice(-1400)}`
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (!BRIDGE_KEY) return next()
  const header = req.headers["authorization"] ?? ""
  const token  = header.startsWith("Bearer ") ? header.slice(7) : header
  if (token !== BRIDGE_KEY) {
    return res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } })
  }
  next()
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: "50mb" }))     // large enough for image payloads

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", async (req, res) => {
  try {
    const data = await ocGet("/api/health", 10000)
    res.json({ status: "ok", bridge_version: BRIDGE_VERSION, opencode: { connected: true, ...data }, active_sessions: sessionMap.size })
  } catch (err) {
    res.json({ status: "ok", bridge_version: BRIDGE_VERSION, opencode: { connected: false, error: err.message }, active_sessions: sessionMap.size })
  }
})

// ─── Models ──────────────────────────────────────────────────────────────────

app.get("/v1/models", authMiddleware, async (req, res) => {
  try {
    const data   = await ocGet("/api/model")
    const models = (Array.isArray(data) ? data : data?.data ?? [])
      .map(m => ({ id: `${m.providerID}/${m.modelID}`, object: "model", owned_by: m.providerID, created: 0 }))

    if (models.length === 0) throw new Error("No models configured")
    logger.debug(`Returning ${models.length} models`)
    return res.json({ object: "list", data: models })

  } catch (err) {
    logger.error("Failed to fetch models:", err.message)
    res.status(502).json({ error: { message: err.message, type: "bridge_error" } })
  }
})

// ─── Chat completions ────────────────────────────────────────────────────────

app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const reqId = `req_${Date.now()}`
  const { messages, model, stream, tools } = req.body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: "`messages` must be a non-empty array", type: "invalid_request_error" }
    })
  }

  // Model can be bare "gpt-4o" or provider-prefixed "provider/model".
  // When omitted, OpenCode's configured default agent model is used.
  const requestedModel = model || DEFAULT_MODEL
  let providerID = ""
  let modelID    = ""
  if (requestedModel) {
    if (requestedModel.includes("/")) {
      const [p, ...m] = requestedModel.split("/")
      providerID = p
      modelID    = m.join("/")
    } else {
      providerID = PROVIDER_ID
      modelID    = requestedModel
    }
  }

  if (tools?.length) logger.info(`[${reqId}] ignoring ${tools.length} client tool definitions (OpenCode V2 uses its own tools)`)

  logger.info(`[${reqId}] → provider=${providerID || "(default)"} model=${modelID || "(default)"} messages=${messages.length} stream=${!!stream}`)

  const startMs = Date.now()

  // Derive a conversation ID from the request:
  // 1. x-conversation-id header (Matrix bot or any client that sends it)
  // 2. Fallback: hash of the first user message content (stable per conversation start)
  const convId = req.headers["x-conversation-id"]
    ?? req.headers["x-session-id"]
    ?? (() => {
         const first = messages.find(m => m.role === "user")
         const text  = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content)
         let h = 0
         for (const c of (text ?? "")) { h = (Math.imul(31, h) + c.charCodeAt(0)) | 0 }
         return `hash_${Math.abs(h)}`
       })()

  try {
    // 1. Get or create OpenCode session for this conversation
    pruneSessionMap()
    const existing   = sessionMap.get(convId)
    const modelChanged = !!existing && !!requestedModel &&
      (existing.providerID !== providerID || existing.modelID !== modelID)
    // x-working-directory lets the client tell OpenCode which project to work in
    const workDir = req.headers["x-working-directory"] ?? null

    if (existing && !modelChanged) {
      const sessionId = existing.sessionId
      existing.lastUsed = Date.now()
      logger.debug(`[${reqId}] reusing session ${sessionId} for conv ${convId}`)
      await runPrompt(reqId, res, startMs, sessionId, messages, stream, modelID, requestedModel)
    } else if (existing) {
      const sessionId = existing.sessionId
      await ocPost(`/api/session/${encodeURIComponent(sessionId)}/model`, { model: { id: modelID, providerID } })
      existing.providerID = providerID
      existing.modelID    = modelID
      existing.lastUsed   = Date.now()
      logger.info(`[${reqId}] switched session ${sessionId} model to ${providerID}/${modelID}`)
      await runPrompt(reqId, res, startMs, sessionId, messages, stream, modelID, requestedModel)
    } else {
      const sessionBody = { title: `bridge-${reqId}` }
      if (modelID) sessionBody.model = { id: modelID, providerID }
      if (workDir) sessionBody.location = { directory: workDir }
      const session = await withRetry(() => ocPost("/api/session", sessionBody))
      const sessionId = session?.data?.id ?? session?.id
      if (!sessionId) throw new Error("OpenCode did not return a session id")
      sessionMap.set(convId, { sessionId, providerID, modelID, lastUsed: Date.now() })
      logger.debug(`[${reqId}] new session ${sessionId} for conv ${convId}${workDir ? ` dir=${workDir}` : ""}`)
      await runPrompt(reqId, res, startMs, sessionId, messages, stream, modelID, requestedModel)
    }

  } catch (err) {
    logger.error(`[${reqId}] ✗ ${Date.now() - startMs}ms ${err.message}`)
    // Remove from session map so next request starts a fresh session
    sessionMap.delete(convId)

    if (stream) {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        res.flushHeaders()
      }
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "bridge_error" } })}\n\n`)
      res.write("data: [DONE]\n\n")
      return res.end()
    }

    if (!res.headersSent) {
      return res.status(502).json({ error: { message: err.message, type: "bridge_error" } })
    }
  }
})

// ─── Prompt execution ────────────────────────────────────────────────────────

async function runPrompt(reqId, res, startMs, sessionId, messages, stream, modelID, requestedModel) {
  // System message → session instructions entry (injected into the agent context)
  const systemMsg = messages.find(m => m.role === "system")
  if (systemMsg) {
    const sysText = typeof systemMsg.content === "string"
      ? systemMsg.content
      : (systemMsg.content ?? []).map(c => c.text ?? "").join("\n")
    if (sysText.trim()) {
      try {
        await ocPut(`/api/session/${encodeURIComponent(sessionId)}/instructions/entries/bridge-system`, { value: sysText })
      } catch (err) {
        logger.debug(`[${reqId}] unable to set system instructions: ${err.message}`)
      }
    }
  }

  // Build prompt — when reusing a session, send only the latest user message
  // since OpenCode already has prior context in its session history.
  const msgsToSend = [messages[messages.length - 1]]
  const { text, files } = await buildPrompt(msgsToSend)
  if (files.length) logger.info(`[${reqId}] multimodal — ${files.length} image attachment(s)`)

  // Start SSE heartbeat + progress polling before the slow OpenCode calls
  let heartbeat = null
  let progressPoll = null
  let progressPending = false
  let lastProgress = ""
  const emitProgress = async () => {
    if (!stream || progressPending) return
    progressPending = true
    try {
      const data = await ocGet(`/api/session/${encodeURIComponent(sessionId)}/message`, 10000)
      const msgs = Array.isArray(data) ? data : data?.data ?? []
      const snapshot = progressSnapshot(msgs)
      if (!snapshot || snapshot === lastProgress) return
      lastProgress = snapshot
      res.write(`event: progress\ndata: ${JSON.stringify({ session_id: sessionId, text: snapshot })}\n\n`)
    } catch (err) {
      logger.debug(`[${reqId}] unable to read live progress: ${err.message}`)
    } finally {
      progressPending = false
    }
  }
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()
    heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS)
    progressPoll = setInterval(() => void emitProgress(), PROGRESS_POLL_MS)
  }

  try {
    // 1. Send the prompt (async — OpenCode returns the user message immediately)
    const promptBody = { text }
    if (files.length) promptBody.files = files
    const promptResult = await ocPost(`/api/session/${encodeURIComponent(sessionId)}/prompt`, promptBody)
    const userMsgId = promptResult?.data?.id ?? promptResult?.id ?? null

    // 2. Block until the agent loop is idle
    await ocPost(`/api/session/${encodeURIComponent(sessionId)}/wait`, undefined)

    // 3. Fetch messages (NEWEST FIRST) and find this turn's assistant messages
    const msgData  = await ocGet(`/api/session/${encodeURIComponent(sessionId)}/message`)
    const allMsgs  = Array.isArray(msgData) ? msgData : msgData?.data ?? []
    const userIdx  = userMsgId ? allMsgs.findIndex(m => m.id === userMsgId) : -1
    const turnMsgs = userIdx > 0 ? allMsgs.slice(0, userIdx) : allMsgs
    const assistants = turnMsgs.filter(m => m.type === "assistant")
    const finalMsg = assistants[0]
    if (!finalMsg) throw new Error("OpenCode returned no assistant response")
    if (finalMsg.error) throw new Error(`OpenCode agent error: ${finalMsg.error.message ?? JSON.stringify(finalMsg.error)}`)

    // 4. Extract response — join all text parts in the final assistant message
    const textSegments = (finalMsg.content ?? [])
      .filter(c => c.type === "text" && c.text)
      .map(c => c.text.trim())
      .filter(Boolean)
    const responseText = textSegments.join("\n\n")

    // Collect OpenCode's tool outputs from this turn and append as a
    // structured block so the caller can see what happened
    const toolLines = []
    for (const m of assistants) {
      for (const c of m.content ?? []) {
        if (c.type !== "tool") continue
        const state = c.state ?? {}
        if (state.status !== "completed") continue
        const out = toolOutputText(state.content)
        if (out) toolLines.push(`**${c.name ?? "tool"}:** ${out}`)
      }
    }
    const toolResultBlock = toolLines.length
      ? "\n\n---\n**Tool outputs:**\n" + toolLines.join("\n")
      : ""
    const fullResponseText = responseText + toolResultBlock

    const tokens = finalMsg.tokens ?? {}
    const usage = {
      prompt_tokens:     (tokens.input ?? 0) + (tokens.cache?.read ?? 0),
      completion_tokens: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
      total_tokens:      (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0),
    }

    const finishReason = finalMsg.finish === "length" ? "length" : "stop"
    logger.info(`[${reqId}] ✓ ${Date.now() - startMs}ms tokens=${usage.total_tokens} chars=${fullResponseText.length} finish=${finishReason}`)

    const cmplId  = `chatcmpl-${sessionId}`
    const created = Math.floor(Date.now() / 1000)
    const responseModel = requestedModel || modelID || "default"

    // 5a. Streaming response
    if (stream) {
      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: responseModel,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`)

      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: responseModel,
        choices: [{ index: 0, delta: { content: fullResponseText }, finish_reason: null }],
      })}\n\n`)

      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: responseModel,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage,
      })}\n\n`)

      res.write("data: [DONE]\n\n")
      return res.end()
    }

    // 5b. Non-streaming response
    return res.json({
      id: cmplId, object: "chat.completion", created, model: responseModel,
      choices: [{ index: 0, message: { role: "assistant", content: fullResponseText }, finish_reason: finishReason }],
      usage,
    })
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (progressPoll) clearInterval(progressPoll)
  }
}

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } })
})

// ─── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", async () => {
  logger.info(`opencode-bridge v${BRIDGE_VERSION} started (OpenCode V2)`)
  logger.info(`  Listening  : http://0.0.0.0:${PORT}`)
  logger.info(`  OpenCode   : ${OPENCODE_URL}`)
  logger.info(`  Auth       : ${BRIDGE_KEY ? "enabled" : "disabled"}`)
  logger.info(`  OC Auth    : ${OPENCODE_PASS ? `enabled (user=${OPENCODE_USER})` : "disabled"}`)
  logger.info(`  Timeout    : ${TIMEOUT_MS}ms${TIMEOUT_MS === 0 ? " (no timeout)" : ""}`)
  logger.info(`  Heartbeat  : ${HEARTBEAT_MS}ms`)
  logger.info(`  Progress   : poll every ${PROGRESS_POLL_MS}ms for streaming requests`)
  logger.info(`  Retries    : ${RETRY_COUNT} × ${RETRY_DELAY}ms delay`)
  logger.info(`  Sessions   : cleanup every ${CLEANUP_EVERY / 60000}min, TTL ${SESSION_TTL_H}h`)
  logger.info(`  Log file   : ${LOG_FILE || "stdout only"}`)
  logger.info(`  Session map: persistent sessions per conversation (TTL ${SESSION_TTL_H}h)`)

  try {
    const h = await ocGet("/api/health", 10000)
    logger.info(`  OpenCode health: ✓ v${h.version ?? "unknown"}`)
  } catch {
    logger.error(`  OpenCode health: ✗ not reachable — check OPENCODE_URL`)
  }

  // Start session cleanup scheduler
  setInterval(cleanupOldSessions, CLEANUP_EVERY)
  // Run once after 30s on startup to clean any leftover sessions
  setTimeout(cleanupOldSessions, 30000)
})

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down…`)
  if (logStream) logStream.end()
  server.close(() => { logger.info("Server closed"); process.exit(0) })
  setTimeout(() => process.exit(1), 5000)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))
