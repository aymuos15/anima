// Reuse a running Codex proxy, or start it alongside the local app.
const port = Number(process.env.CODEX_PROXY_PORT ?? 8788)
let proxyRunning = false
try {
  const response = await fetch(`http://127.0.0.1:${port}/v1`, { signal: AbortSignal.timeout(2000) })
  if (await response.text() !== 'codex proxy: POST /v1/responses only') {
    throw new Error(`Port ${port} is occupied by something other than the Codex proxy`)
  }
  proxyRunning = true
} catch (error) {
  if (!(error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED')) throw error
}
if (!proxyRunning) await import('./codex-proxy.js')
await import('../agent/server.js')
