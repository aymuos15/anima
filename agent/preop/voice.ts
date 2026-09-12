import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getState } from './store.js'
import { SYSTEM, protocol } from './agent.js'

function voiceKey() {
  if (process.env.OPENAI_REALTIME_API_KEY) return process.env.OPENAI_REALTIME_API_KEY
  try {
    return readFileSync(`${homedir()}/.config/anima/demo.env`, 'utf8').split('\n')
      .find(line => line.startsWith('OPENAI_REALTIME_API_KEY='))?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '')
  } catch { return undefined }
}

export async function handleVoice(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith('/api/demo/voice/')) return false
  const key = voiceKey()
  const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  if (req.method === 'GET' && path === '/api/demo/voice/status') {
    json(200, { available: Boolean(key), transport: 'browser', gatePassed: false }); return true
  }
  try {
    if (!key) throw new Error('Voice key unavailable')
    if (req.method !== 'POST') { json(404, { error: 'Unknown voice route' }); return true }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const patient = getState().patients[body.patientId]
    if (!patient?.transcript.length) { json(400, { error: 'Start this patient in the console first' }); return true }
    if (path === '/api/demo/voice/connect') {
      if (typeof body.sdp !== 'string') throw new Error('Missing audio connection offer')
      const form = new FormData()
      form.set('sdp', body.sdp)
      form.set('session', JSON.stringify({
        type: 'realtime', model: 'gpt-realtime', output_modalities: ['text'], tools: [],
        instructions: `${SYSTEM}\n\n${protocol}\n\nVoice transport only. Never create a response or call tools. Input transcription is sent to the existing pre-op server, which owns every decision and message.`,
        audio: { input: {
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 700, create_response: false, interrupt_response: false },
          noise_reduction: { type: 'near_field' },
        } },
      }))
      const upstream = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(25000) })
      if (!upstream.ok) { console.warn('[voice] Realtime connection:', upstream.status); throw new Error(`Voice connection unavailable (${upstream.status})`) }
      res.writeHead(200, { 'Content-Type': 'application/sdp' }).end(await upstream.text())
    } else if (path === '/api/demo/voice/speak') {
      const entry = patient.transcript[body.transcriptIndex]
      if (!Number.isInteger(body.transcriptIndex) || entry?.from !== 'agent') throw new Error('Select an approved agent transcript message')
      const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: entry.text, response_format: 'mp3' }), signal: AbortSignal.timeout(25000),
      })
      if (!upstream.ok) { console.warn('[voice] Speech:', upstream.status); throw new Error(`Speech unavailable (${upstream.status})`) }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).end(Buffer.from(await upstream.arrayBuffer()))
    } else json(404, { error: 'Unknown voice route' })
  } catch (error) {
    console.warn('[voice]', error instanceof Error ? error.message : 'Voice request failed')
    if (!res.headersSent) json(502, { error: error instanceof Error ? error.message : 'Voice request failed' })
  }
  return true
}
