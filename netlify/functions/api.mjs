// Netlify Functions 2.0 entry point (ESM). The Node http server in agent/server.ts is started once per
// function instance on a random loopback port and every /api/* request is proxied to it.
// Bundled by `npm run build:fn` into netlify/functions-dist (see netlify.toml for why).
import { server } from '../../agent/server.ts'

let ready = null

function start() {
  if (!ready) {
    ready = new Promise(function (resolve) {
      server.listen(0, '127.0.0.1', function () { resolve(server.address().port) })
    })
  }
  return ready
}

export default async function handler(req) {
  const port = await start()
  const url = new URL(req.url)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const upstream = await fetch('http://127.0.0.1:' + port + url.pathname + url.search, {
    method: req.method,
    headers: { 'content-type': req.headers.get('content-type') || 'application/json' },
    body: hasBody ? await req.text() : undefined,
  })
  const body = await upstream.arrayBuffer()
  return new Response(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  })
}

export const config = { path: '/api/*' }
