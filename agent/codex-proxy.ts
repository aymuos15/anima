// Local proxy so the ADK's stock OpenAI adapter can use the ChatGPT OAuth token held by Codex CLI.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses'
const REFRESH_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const PORT = Number(process.env.CODEX_PROXY_PORT ?? 8788)

interface Auth { tokens: { access_token: string; refresh_token: string; id_token?: string; account_id: string }; last_refresh?: string }

function jwtExp(token: string) {
  const p = token.split('.')[1]
  const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
  return (JSON.parse(json).exp as number) * 1000
}

async function getAuth(): Promise<Auth> {
  const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf8')) as Auth
  if (jwtExp(auth.tokens.access_token) - Date.now() > 3600_000) return auth
  const res = await fetch(REFRESH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.tokens.refresh_token, client_id: CLIENT_ID }),
  })
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`)
  const t = (await res.json()) as { access_token: string; refresh_token: string; id_token?: string }
  auth.tokens = { ...auth.tokens, access_token: t.access_token, refresh_token: t.refresh_token ?? auth.tokens.refresh_token, id_token: t.id_token ?? auth.tokens.id_token }
  auth.last_refresh = new Date().toISOString()
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2))
  console.log('[proxy] refreshed ChatGPT token')
  return auth
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
    res.writeHead(404).end('codex proxy: POST /v1/responses only')
    return
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  let body: Record<string, unknown>
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { res.writeHead(400).end('bad json'); return }
  body.stream = true
  body.store = false
  delete body.max_output_tokens

  try {
    const auth = await getAuth()
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        'chatgpt-account-id': auth.tokens.account_id,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    })
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache',
    })
    if (!upstream.body) { res.end(); return }
    // The Codex backend sends response.completed with output: [] — rebuild it from output_item.done.
    const items: unknown[] = []
    let buf = ''
    const dec = new TextDecoder()
    const flush = (block: string) => {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) { res.write(block + '\n\n'); return }
      try {
        const ev = JSON.parse(dataLine.slice(5))
        if (ev.type === 'response.output_item.done') items.push(ev.item)
        if (ev.type === 'response.completed' && Array.isArray(ev.response?.output) && ev.response.output.length === 0 && items.length) {
          ev.response.output = items
          res.write(`event: response.completed\ndata: ${JSON.stringify(ev)}\n\n`)
          return
        }
      } catch { /* pass through */ }
      res.write(block + '\n\n')
    }
    for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2) }
    }
    if (buf.trim()) flush(buf)
    res.end()
    console.log(`[proxy] ${body.model} -> ${upstream.status}`)
  } catch (e) {
    console.error('[proxy] error', e)
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: String(e) } }))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[proxy] listening on http://127.0.0.1:${PORT}/v1`))
