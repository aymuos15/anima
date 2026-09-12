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
  test: 'treated',
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

export interface Medicines {
  prescriptions: Array<{ id: string; drug: string; status: string; version?: number; quantity?: number; productId?: string; stock?: number; site: Site }>
  tests: Array<{ id: string; title: string; status: string; version?: number }>
  visits: Array<{ id: string; title: string; status: string; version?: number }>
  openTasks: Array<{ id: string; title: string; version?: number }>
  bed?: { id: string; title: string; barrier?: string; expectedDischarge?: string; version?: number }
  attendance?: { id: string; title: string; stage?: string; version?: number }
  stage: 'prescribed' | 'approved' | 'dispensed' | 'collected' | 'none'
  blockers: string[]
}

export interface Pathway {
  patient: Patient | null
  now: number
  currentStage: Stage
  stagesReached: Stage[]
  blockers: string[]
  events: PathwayEvent[]
  capacity: Array<{ site: Site; title: string; total?: number; remaining?: number }>
  medicines: Medicines
  errors: string[]
}

const RX_ORDER = ['draft', 'reviewed', 'approved', 'dispensed', 'collected']

function buildMedicines(events: PathwayEvent[], raw: Array<{ site: Site; r: Resource }>, capacity: Pathway['capacity']): Medicines {
  const seen = new Set<string>()
  const pick = (kind: string) => raw.filter((x) => x.r.kind === kind && x.r.patientId && !seen.has(x.r.id) && seen.add(x.r.id))
  const prescriptions = pick('prescription').map(({ site, r }) => ({
    id: r.id, drug: String(r.data?.drug ?? r.title), status: r.status, version: r.version, site,
    quantity: num(r.data?.quantity), productId: r.data?.productId as string | undefined, stock: num(r.data?.stock),
  }))
  const tests = pick('test').map(({ r }) => ({ id: r.id, title: r.title, status: r.status, version: r.version }))
  const visits = pick('visit').map(({ r }) => ({ id: r.id, title: r.title, status: r.status, version: r.version }))
  const openTasks = pick('task').filter(({ r }) => r.status === 'open').map(({ r }) => ({ id: r.id, title: r.title, version: r.version }))
  const bedR = raw.find((x) => x.r.kind === 'bed' && x.r.status === 'occupied')?.r
  const bed = bedR ? { id: bedR.id, title: bedR.title, barrier: bedR.data?.barrier as string | undefined, expectedDischarge: bedR.data?.expectedDischarge as string | undefined, version: bedR.version } : undefined
  const attR = raw.find((x) => x.r.kind === 'hospital-attendance')?.r
  const attendance = attR ? { id: attR.id, title: attR.title, stage: attR.data?.stage as string | undefined, version: attR.version } : undefined

  const rank = (s: string) => Math.max(0, RX_ORDER.indexOf(s))
  const best = prescriptions.reduce<string | null>((acc, p) => (acc === null || rank(p.status) > rank(acc) ? p.status : acc), null)
  const stage: Medicines['stage'] = best === null ? 'none' : best === 'collected' ? 'collected' : best === 'dispensed' ? 'dispensed' : best === 'approved' ? 'approved' : 'prescribed'

  const blockers: string[] = []
  for (const p of prescriptions) {
    if (p.status === 'approved' && !p.productId) blockers.push(`${p.drug}: approved but not linked to pharmacy stock, so it cannot be dispensed`)
    if (p.status === 'approved' && p.productId) blockers.push(`${p.drug}: approved and linked, waiting to be dispensed`)
    if (p.status === 'dispensed') blockers.push(`${p.drug}: dispensed, waiting to be collected or delivered`)
  }
  if (bed?.barrier && attendance?.stage !== 'discharged') blockers.push(`Hospital bed still occupied: discharge blocked by "${bed.barrier}"`)
  for (const t of openTasks) blockers.push(`Open practice task: ${t.title}`)
  for (const t of tests) if (t.status === 'open') blockers.push(`Test ordered, result not back: ${t.title}`)
  const comm = capacity.find((c) => c.site === 'community')
  if (comm && comm.remaining === 0) blockers.push('No community visit capacity right now')

  return { prescriptions, tests, visits, openTasks, bed, attendance, stage, blockers }
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
  const raw: Array<{ site: Site; r: Resource }> = []
  let now = 0

  for (const entry of views) {
    if (!entry) continue
    now = Math.max(now, entry.v.now ?? 0)
    for (const r of entry.v.resources as Resource[]) {
      if (r.kind === 'capacity') {
        capacity.push({ site: entry.site, title: r.title, total: num(r.data?.total), remaining: num(r.data?.remaining) })
        continue
      }
      if (r.kind === 'bed' && r.status === 'occupied' && entry.site === 'hospital') raw.push({ site: entry.site, r: { ...r, patientId } })
      if (r.patientId !== patientId || NOISE.has(r.kind)) continue
      raw.push({ site: entry.site, r })
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

  const medicines = buildMedicines(unique, raw, capacity)
  return { patient, now, currentStage: current, stagesReached: reached, blockers, events: unique, capacity, medicines, errors }
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
