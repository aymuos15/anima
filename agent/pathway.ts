import { sim, SITES, type Resource, type Site, type Patient } from './sim.js'

export type Stage = 'referred' | 'assessed' | 'waiting' | 'treated' | 'discharged' | 'other'

const STAGE_BY_KIND: Record<string, Stage> = {
  referral: 'referred',
  'pharmacy-referral': 'referred',
  encounter: 'assessed',
  'hospital-attendance': 'assessed',
  appointment: 'assessed',
  surgery: 'waiting',
  'theatre-slot': 'waiting',
  task: 'waiting',
  visit: 'treated',
  prescription: 'treated',
  'discharge-summary': 'discharged',
}

const NOISE = new Set(['report', 'observation', 'ehr-record', 'capacity', 'appointment-session', 'message-template', 'conversation'])

export interface PathwayEvent {
  site: Site
  id: string
  kind: string
  status: string
  title: string
  priority?: string
  createdAt: number
  dueAt?: number
  version?: number
  stage: Stage
  data?: Record<string, unknown>
}

export interface Pathway {
  patient: Patient | null
  now: number
  currentStage: Stage
  stagesReached: Stage[]
  blockers: string[]
  events: PathwayEvent[]
  capacity: Array<{ site: Site; title: string; total?: number; remaining?: number }>
  errors: string[]
}

export async function buildPathway(patientId: string): Promise<Pathway> {
  const errors: string[] = []
  const [patientRes, ...views] = await Promise.all([
    sim.patients(patientId).catch((e) => { errors.push(`patients: ${e.message}`); return null }),
    ...SITES.map((site) => sim.view(site, patientId).then((v) => ({ site, v })).catch((e) => { errors.push(`${site}: ${e.message}`); return null })),
  ])

  const patient = patientRes?.items.find((p) => p.id === patientId) ?? null
  const events: PathwayEvent[] = []
  const capacity: Pathway['capacity'] = []
  let now = 0

  for (const entry of views) {
    if (!entry) continue
    if ((entry.v.resourceTotal ?? entry.v.resources.length) > entry.v.resources.length) {
      errors.push(`${entry.site}: incomplete resource inventory (${entry.v.resources.length}/${entry.v.resourceTotal})`)
    }
    now = Math.max(now, entry.v.now ?? 0)
    for (const r of entry.v.resources as Resource[]) {
      if (r.kind === 'capacity') {
        capacity.push({ site: entry.site, title: r.title, total: num(r.data?.total), remaining: num(r.data?.remaining) })
        continue
      }
      if (r.patientId !== patientId || NOISE.has(r.kind)) continue
      events.push({
        site: entry.site, id: r.id, kind: r.kind, status: r.status, title: r.title, priority: r.priority,
        createdAt: r.createdAt, dueAt: r.dueAt, version: r.version, stage: STAGE_BY_KIND[r.kind] ?? 'other',
        data: compactData(r.data),
      })
    }
  }

  // hospital and gp both project shared documents; keep one copy per resource id
  const seen = new Set<string>()
  const unique = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
  unique.sort((a, b) => a.createdAt - b.createdAt)

  const order: Stage[] = ['referred', 'assessed', 'waiting', 'treated', 'discharged']
  const reached = order.filter((s) => unique.some((e) => e.stage === s))
  const open = unique.filter((e) => ['waiting', 'open', 'rejected', 'inpatient', 'booked'].includes(e.status))
  const current: Stage = open.find((e) => e.stage === 'waiting') ? 'waiting'
    : open.find((e) => e.stage === 'referred') ? 'referred'
    : reached[reached.length - 1] ?? 'other'

  const blockers = unique
    .filter((e) => e.status === 'rejected' || e.status === 'waiting')
    .map((e) => `${e.title} (${e.kind}, ${e.status}, ${e.site})`)
  for (const c of capacity) if (c.remaining === 0) blockers.push(`No capacity: ${c.title} (${c.site})`)

  return { patient, now, currentStage: current, stagesReached: reached, blockers, events: unique, capacity, errors }
}

function num(v: unknown): number | undefined { return typeof v === 'number' ? v : undefined }

function compactData(d?: Record<string, unknown>) {
  if (!d) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue
    if (typeof v === 'string') out[k] = v.length > 240 ? v.slice(0, 240) + '…' : v
    else if (typeof v === 'number' && /At$/.test(k) && v > 1e12) out[k] = fmtDate(v)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export function fmtDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}
