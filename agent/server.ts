import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { app } from './app.js'
import { pathwayAgent, auditHook } from './agents.js'
import { buildPathway, fmtDate } from './pathway.js'
import { sim } from './sim.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const PORT = Number(process.env.PORT ?? 8790)

const chat = app.handler.rest({ agent: pathwayAgent, hooks: [auditHook as any], response: { state: true } })

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.png': 'image/png' }

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

async function readBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req)
      const patientId: string | undefined = body.patientId
      let input = body.input ?? {}
      if (!body.sessionId && patientId) {
        const p = await buildPathway(patientId)
        input = {
          ...input,
          initialState: { session: {
            patientId, patientName: p.patient?.name ?? '', stage: p.currentStage, blockers: p.blockers,
            needs: p.patient?.needs ?? [], goals: p.patient?.goals ?? [],
          } },
        }
      }
      const t0 = Date.now()
      const out = await chat({ sessionId: body.sessionId, input })
      console.log(`[chat] ${patientId ?? out.sessionId} ${out.status} ${Date.now() - t0}ms yields=${out.yieldedTools?.length ?? 0}${out.error ? ' error=' + out.error : ''}`)
      json(res, 200, { sessionId: out.sessionId, status: out.status, text: out.output.text ?? '', yieldedTools: out.yieldedTools ?? [], error: out.error })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/patients/') && url.pathname.endsWith('/pathway')) {
      const id = url.pathname.split('/')[3]
      const p = await buildPathway(id)
      json(res, 200, { ...p, nowText: fmtDate(p.now), events: p.events.map((e) => ({ ...e, when: fmtDate(e.createdAt) })) })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/patients') {
      json(res, 200, await sim.patients(url.searchParams.get('q') ?? ''))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/clock/advance') {
      const body = await readBody(req)
      json(res, 200, await sim.advance(Number(body.minutes ?? 60)))
      return
    }

    // static files from the project root
    const file = url.pathname === '/' ? '/pathway.html' : url.pathname
    if (file.includes('..') || file === '/key.txt') { res.writeHead(404).end(); return }
    try {
      const data = await readFile(join(ROOT, file))
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data)
    } catch {
      res.writeHead(404).end('not found')
    }
  } catch (e) {
    console.error(e)
    json(res, 500, { error: String(e) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[server] http://127.0.0.1:${PORT}/  (model ${process.env.MODEL ?? 'gpt-5.6-luna'} via ${process.env.OPENAI_BASE_URL ?? 'api.openai.com'})`))
