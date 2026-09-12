import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const SIM_BASE = process.env.SIM_BASE ?? 'https://sim.animahacks.com'
let KEY = (process.env.SIM_KEY ?? readFileSync(join(here, '..', 'key.txt'), 'utf8')).trim()

export const SITES = ['gp', 'hospital', 'pharmacy', 'community', 'diagnostics', 'wearables', 'referrals'] as const
export type Site = (typeof SITES)[number]

export class SimError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `Sim API ${status}`)
  }
}

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(SIM_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  let data: unknown = text
  try { data = JSON.parse(text) } catch { /* non-json body */ }
  if (!res.ok) throw new SimError(res.status, data, `Sim API ${res.status} ${method} ${path}: ${text.slice(0, 200)}`)
  return data
}

export const sim = {
  setKey: (key: string, persist = false) => { KEY = key.trim(); if (persist) writeFileSync(join(here, 'key-agent.txt'), KEY + '\n', { mode: 0o600 }) },
  newWorld: (teamName: string) => request('POST', '/api/keys', { teamName }) as Promise<{ apiKey: string }>,
  get: (path: string) => request('GET', path),

  patients: (q: string) => request('GET', `/api/sites/gp/patients?q=${encodeURIComponent(q)}`) as Promise<{ total: number; items: Patient[] }>,

  view: (site: Site, patient?: string, limit = 500, offset = 0) =>
    request('GET', `/api/sites/${site}/view?${patient ? `patient=${patient}&` : ''}limit=${limit}&offset=${offset}`) as Promise<View>,

  action: (site: Site, action: Record<string, unknown>) =>
    request('POST', `/api/sites/${site}/actions`, { clientRequestId: randomUUID(), ...action }, { 'Idempotency-Key': randomUUID() }),

  clock: () => request('GET', '/api/clock') as Promise<{ now: number; paused: boolean }>,
  advance: (minutes: number) => request('POST', '/api/clock', { paused: true, advanceMinutes: minutes }),
}

export interface Patient {
  id: string
  name: string
  birthDate: string
  conditions: string[]
  needs: string[]
  goals: string[]
  localIds: Record<string, string>
}

export interface Resource {
  id: string
  kind: string
  title: string
  status: string
  owner?: string
  priority?: string
  patientId?: string
  createdAt: number
  dueAt?: number
  version?: number
  data?: Record<string, unknown>
}

export interface View {
  now: number
  resources: Resource[]
  resourceTotal?: number
}
