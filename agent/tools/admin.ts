import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { app as App } from '../app.js'
import { sim, SITES } from '../sim.js'
import { buildPathway, fmtDate, invalidatePathways } from '../pathway.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 'data')

export const FEATURED = ['SIM-000007', 'SIM-000504', 'SIM-000023', 'SIM-000002', 'SIM-000070', 'SIM-000001']

export function readJson(name: string): any {
  const p = join(dataDir, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

export async function overview() {
  const [clock, ...views] = await Promise.all([
    sim.clock().catch(() => null),
    ...SITES.map((site) => sim.view(site, undefined, 300).then((v) => ({ site, v })).catch(() => null)),
  ])
  const capacity = views.flatMap((x) => x ? x.v.resources.filter((r) => r.kind === 'capacity').map((r) => ({ site: x.site, title: r.title, total: r.data?.total, remaining: r.data?.remaining })) : [])
  const live = views.flatMap((x) => x ? x.v.resources.filter((r) => ['bed', 'robot', 'theatre-slot', 'staff'].includes(r.kind) && !r.patientId).map((r) => ({ site: x.site, kind: r.kind, title: r.title, status: r.status, data: r.data })) : [])
  const waitingNow = views.flatMap((x) => x ? x.v.resources.filter((r) => r.patientId && ['waiting', 'rejected'].includes(r.status)).map((r) => ({ site: x.site, patientId: r.patientId, kind: r.kind, status: r.status, title: r.title, since: fmtDate(r.createdAt) })) : [])
  const cohort = readJson('cohort.json')
  const examples = readJson('examples.json') ?? []
  return { clock: clock ? { now: clock.now, nowText: fmtDate(clock.now), paused: clock.paused } : null, capacity, live, waitingNow, cohort: cohort ? { condition: cohort.condition, builtAt: cohort.builtAt, byCondition: cohort.byCondition } : null, examples }
}

export function adminTools(app: typeof App) {
  const get_overview = app.tool({
    name: 'get_overview',
    description: 'Operational overview of the whole service right now: simulation clock, capacity per site, beds/robots/theatre lists, every record currently waiting or rejected (with patient ids), and the cohort statistics. Call this for any question about the service as a whole.',
    schema: z.object({}),
    execute: async () => {
      const o = await overview()
      return { ...o, examples: o.examples.map((e: any) => ({ id: e.id, name: e.name, pathwayType: e.pathwayType, currentStage: e.currentStage, blockers: e.blockers })) }
    },
  })

  const list_example_patients = app.tool({
    name: 'list_example_patients',
    description: 'Curated list of patients with known pathway stories (id, name, pathway type, story, blockers, suggested next actions). Use to find who to look at for a given problem.',
    schema: z.object({ query: z.string().nullable().optional().describe('Optional text to filter by pathway type, story or condition') }),
    execute: async (ctx) => {
      const ex = (readJson('examples.json') ?? []) as any[]
      const q = ctx.args.query?.toLowerCase()
      return ex.filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q)).map((e) => ({ id: e.id, name: e.name, conditions: e.conditions, pathwayType: e.pathwayType, story: e.story, currentStage: e.currentStage, blockers: e.blockers, suggestedNextActions: e.suggestedNextActions }))
    },
  })

  const scan_patients = app.tool({
    name: 'scan_patients',
    description: 'Rebuild the live pathway for several patients at once and return stage and blockers for each. Slow (about 2 seconds per patient); at most 8 ids.',
    schema: z.object({ patientIds: z.array(z.string()).min(1).max(8) }),
    execute: async (ctx) => Promise.all(ctx.args.patientIds.map(async (id) => {
      try { const p = await buildPathway(id); return { id, name: p.patient?.name, stage: p.currentStage, blockers: p.blockers.concat(p.medicines.blockers), medicines: p.medicines.stage, lastEvent: p.events.length ? `${fmtDate(p.events[p.events.length - 1].createdAt)} ${p.events[p.events.length - 1].title}` : null } }
      catch (e) { return { id, error: String(e) } }
    })),
  })

  const advance_clock = app.tool({
    name: 'advance_clock',
    description: 'Propose advancing the simulation clock so scheduled work completes (visits, results, capacity refresh). Requires approval.',
    schema: z.object({ minutes: z.number().int().min(1).max(1440), reason: z.string() }),
    yieldSchema: z.object({ approved: z.boolean(), note: z.string().optional() }),
    finalize: async (ctx) => {
      if (!ctx.input?.approved) return { status: 'declined' }
      const r = (await sim.advance(ctx.args.minutes)) as any
      invalidatePathways()
      return { status: 'done', now: fmtDate(r.now), events: (r.events ?? []).slice(0, 8).map((e: any) => `${e.type}: ${e.detail}${e.patientId ? ' (' + e.patientId + ')' : ''}`) }
    },
  })

  return [get_overview, list_example_patients, scan_patients, advance_clock]
}
