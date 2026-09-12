import { z } from 'zod'
import type { app as App } from '../app.js'
import { sim, SITES } from '../sim.js'
import { buildPathway, fmtDate } from '../pathway.js'

const siteSchema = z.enum(SITES)

export function readTools(app: typeof App) {
  const search_patients = app.tool({
    name: 'search_patients',
    description: 'Search registered patients by name, id or condition. Returns up to 10 matches.',
    schema: z.object({ q: z.string().describe('Search text, e.g. a name, SIM id or condition') }),
    execute: async (ctx) => {
      const r = await sim.patients(ctx.args.q)
      return { total: r.total, patients: r.items.slice(0, 10).map((p) => ({ id: p.id, name: p.name, birthDate: p.birthDate, conditions: p.conditions, needs: p.needs, goals: p.goals })) }
    },
  })

  const get_patient_pathway = app.tool({
    name: 'get_patient_pathway',
    description: 'Read every record for a patient across GP, hospital, pharmacy, community, diagnostics, wearables and referrals, stitched into one timeline with the current stage, blockers and capacity. Call this before deciding what to say to the patient.',
    schema: z.object({ patientId: z.string().describe('Patient id such as SIM-000007') }),
    execute: async (ctx) => {
      const p = await buildPathway(ctx.args.patientId)
      return {
        patient: p.patient,
        simTime: fmtDate(p.now),
        currentStage: p.currentStage,
        stagesReached: p.stagesReached,
        blockers: p.blockers,
        capacity: p.capacity,
        recentEvents: p.events.slice(-25).map((e) => ({ id: e.id, when: fmtDate(e.createdAt), site: e.site, kind: e.kind, status: e.status, title: e.title, priority: e.priority, version: e.version, data: e.data })),
        errors: p.errors,
      }
    },
  })

  const get_capacity = app.tool({
    name: 'get_capacity',
    description: 'Read service capacity (total and remaining slots) for a site.',
    schema: z.object({ site: siteSchema }),
    execute: async (ctx) => {
      const v = await sim.view(ctx.args.site, undefined, 200)
      return v.resources.filter((r) => r.kind === 'capacity').map((r) => ({ title: r.title, total: r.data?.total, remaining: r.data?.remaining }))
    },
  })

  const get_appointment_sessions = app.tool({
    name: 'get_appointment_sessions',
    description: 'List bookable GP appointment sessions (clinic lists) with their ids, versions and times. Needed before book_appointment.',
    schema: z.object({}),
    execute: async () => {
      return getAppointmentSessions()
    },
  })

  const get_resource = app.tool({
    name: 'get_resource',
    description: 'Read one resource by id from a site, including its current version. Read the resource immediately before any versioned write.',
    schema: z.object({ site: siteSchema, resourceId: z.string(), patientId: z.string().nullable().optional() }),
    execute: async (ctx) => {
      const v = await sim.view(ctx.args.site, ctx.args.patientId ?? undefined, 500)
      const r = v.resources.find((x) => x.id === ctx.args.resourceId)
      return r ?? { error: 'not found' }
    },
  })

  return [search_patients, get_patient_pathway, get_capacity, get_appointment_sessions, get_resource]
}


export async function getAppointmentSessions(late = false) {
  const { now } = await sim.clock()
  const options: Array<{ sessionId: string; sessionVersion: number; startsAt: number; startsAtText: string; title: string; period: string }> = []
  for (let day = 0; day < 10 && options.length < 2; day++) {
    const date = new Date(now + day * 86400000).toISOString().slice(0, 10)
    const view = await sim.get(`/api/sites/gp/appointments?date=${date}`) as { sessions?: import('../sim.js').Resource[]; appointments?: import('../sim.js').Resource[] }
    for (const period of ['AM', 'PM']) {
      if (options.some(o => o.period === period)) continue
      const candidates: typeof options = []
      for (const r of view.sessions ?? []) {
        if (r.status !== 'open' || r.data?.mode !== 'in-person' || !r.title.includes(period)) continue
        const d = r.data!, increment = Number(d.slotMinutes ?? 15) * 60000
        for (let at = Number(d.startsAt); at < Number(d.endsAt); at += increment) {
          if (at <= now || (d.blockedSlots as Array<{ startsAt: number }> ?? []).some(b => b.startsAt === at)) continue
          if ((view.appointments ?? []).some(a => a.status !== 'cancelled' && a.data?.sessionId === r.id && a.data?.startsAt === at)) continue
          candidates.push({ sessionId: r.id, sessionVersion: r.version!, startsAt: at, startsAtText: fmtDate(at), title: r.title, period })
        }
      }
      candidates.sort((a, b) => late ? b.startsAt - a.startsAt : a.startsAt - b.startsAt)
      if (candidates[0]) options.push(candidates[0])
    }
  }
  return options
}
