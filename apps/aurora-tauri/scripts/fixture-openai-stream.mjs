import { createServer } from 'node:http'

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

const server = createServer((request, response) => {
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
