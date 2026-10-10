import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const port = Number(process.env.AURORA_MODEL_FIXTURE_PORT ?? 0)
const partial = process.env.AURORA_MODEL_FIXTURE_PARTIAL ?? 'Fixture partial response'
const completed = process.env.AURORA_MODEL_FIXTURE_COMPLETED ?? 'Fixture completed response'
const pauseTimeoutMs = Number(process.env.AURORA_MODEL_FIXTURE_PAUSE_TIMEOUT_MS ?? 30_000)
const pending = new Map()
const completedTurnIds = new Set()
let armedTurnId = null

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body)
}

function fixtureEmbedding(input) {
  const tokens = typeof input === 'string'
    ? input.trim().split(/\s+/u).filter(Boolean)
    : input.map(String)
  const vector = Array(8).fill(0)
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest()
    const bucket = digest.readUInt32BE(0) % vector.length
    vector[bucket] += digest[4] & 1 ? 1 : -1
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (magnitude === 0) vector[0] = 1
  else for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude
  return { vector, tokenCount: tokens.length }
}

function clearTurn(turn) {
  clearTimeout(turn.timer)
  pending.delete(turn.id)
}

function failTurn(turn, reason) {
  if (pending.get(turn.id) !== turn) return
  clearTurn(turn)
  if (!turn.response.destroyed) {
    turn.response.write(`event: error\ndata: ${JSON.stringify({ error: reason, turn_id: turn.id })}\n\n`)
    turn.response.destroy()
  }
}

function resumeTurn(turn) {
  if (pending.get(turn.id) !== turn) return false
  clearTurn(turn)
  completedTurnIds.add(turn.id)
  turn.response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: completed } }], turn_id: turn.id })}\n\n`)
  turn.response.write('data: [DONE]\n\n')
  turn.response.end()
  return true
}

const server = createServer(async (request, response) => {
  const armMatch = request.url?.match(/^\/__fixture\/arm\/([^/]+)$/u)
  if (request.method === 'POST' && armMatch) {
    const turnId = decodeURIComponent(armMatch[1])
    if (!turnId || armedTurnId || pending.has(turnId) || completedTurnIds.has(turnId)) {
      return json(response, 409, { error: 'turn_already_armed_or_seen' })
    }
    armedTurnId = turnId
    return json(response, 200, { ok: true, turnId })
  }

  const statusMatch = request.url?.match(/^\/__fixture\/status\/([^/]+)$/u)
  if (request.method === 'GET' && statusMatch) {
    const turnId = decodeURIComponent(statusMatch[1])
    return json(response, 200, { armed: armedTurnId === turnId, pending: pending.has(turnId), completed: completedTurnIds.has(turnId), turnId })
  }

  const resumeMatch = request.url?.match(/^\/__fixture\/resume\/([^/]+)$/u)
  if (request.method === 'POST' && resumeMatch) {
    const turnId = decodeURIComponent(resumeMatch[1])
    const turn = pending.get(turnId)
    if (!turn) return json(response, 404, { error: 'turn_not_found' })
    resumeTurn(turn)
    return json(response, 200, { ok: true, turnId })
  }

  if (request.method !== 'GET' && request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' })
  if (request.url === '/v1/models') return json(response, 200, { data: [{ id: 'aurora-ui-acceptance-fixture', object: 'model' }] })
  if (request.method === 'POST' && request.url === '/v1/embeddings') {
    let body
    try {
      body = await readJson(request)
    } catch {
      return json(response, 400, { error: 'invalid_json' })
    }
    const inputs = typeof body.input === 'string'
      ? [body.input]
      : Array.isArray(body.input) && body.input.every(Number.isInteger)
        ? [body.input]
        : body.input
    if (!Array.isArray(inputs) || !inputs.every((item) => typeof item === 'string' || (Array.isArray(item) && item.every(Number.isInteger)))) {
      return json(response, 400, { error: 'input_must_be_text_or_token_arrays' })
    }
    let tokenCount = 0
    const data = inputs.map((input, index) => {
      const embedding = fixtureEmbedding(input)
      tokenCount += embedding.tokenCount
      return { object: 'embedding', index, embedding: embedding.vector }
    })
    response.setHeader('x-aurora-fixture-semantics', 'deterministic hash vectors; not semantic embeddings')
    return json(response, 200, {
      object: 'list',
      data,
      model: body.model ?? 'aurora-ui-acceptance-fixture',
      usage: { prompt_tokens: tokenCount, total_tokens: tokenCount },
    })
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: 'not_found' })

  const requestedTurnId = request.headers['x-aurora-acceptance-turn-id']?.toString().trim()
  if (requestedTurnId && (pending.has(requestedTurnId) || completedTurnIds.has(requestedTurnId))) {
    return json(response, 409, { error: 'duplicate_turn_id', turnId: requestedTurnId })
  }
  if (!armedTurnId) return json(response, 409, { error: 'target_turn_not_armed' })
  if (requestedTurnId && requestedTurnId !== armedTurnId) return json(response, 409, { error: 'turn_id_does_not_match_armed_target' })
  const turnId = armedTurnId
  if (pending.has(turnId) || completedTurnIds.has(turnId)) return json(response, 409, { error: 'duplicate_turn_id', turnId })
  armedTurnId = null

  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const turn = { id: turnId, response, timer: null, closed: false }
  const cleanup = () => {
    if (turn.closed) return
    turn.closed = true
    if (pending.get(turn.id) === turn) clearTurn(turn)
  }
  turn.timer = setTimeout(() => failTurn(turn, 'target_turn_pause_timeout'), Number.isFinite(pauseTimeoutMs) ? pauseTimeoutMs : 30_000)
  pending.set(turnId, turn)
  request.once('aborted', cleanup)
  response.once('close', cleanup)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }], turn_id: turnId })}\n\n`)
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(JSON.stringify({ fixture: true, baseUrl: `http://127.0.0.1:${address.port}`, model: 'aurora-ui-acceptance-fixture', requestScopedPause: true }))
})

const close = () => {
  for (const turn of pending.values()) failTurn(turn, 'fixture_shutdown')
  server.close(() => process.exit(0))
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
