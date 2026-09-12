import { z } from 'zod'
import type { app as App } from '../app.js'
import { sim, SITES } from '../sim.js'
import { buildPathway, fmtDate } from '../pathway.js'
import { readJson } from './admin.js'

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
        medicines: p.medicines,
        letters: p.letters.map((l) => ({ id: l.id, title: l.title, status: l.status, sentBy: l.sentBy, when: fmtDate(l.sentAt ?? l.createdAt), sections: Object.fromEntries(l.sections.map((s) => [s.key, s.text])) })),
        repeatMedicines: p.repeats,
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
      const v = await sim.view('gp', undefined, 500)
      return v.resources
        .filter((r) => r.kind === 'appointment-session' && r.status === 'open')
        .slice(0, 12)
        .map((r) => ({ sessionId: r.id, sessionVersion: r.version, title: r.title, startsAt: r.data?.startsAt, startsAtText: typeof r.data?.startsAt === 'number' ? fmtDate(r.data.startsAt as number) : undefined, endsAt: r.data?.endsAt, slotMinutes: r.data?.slotMinutes, mode: r.data?.mode, clinician: r.data?.clinician }))
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

  const get_similar_pathways = app.tool({
    name: 'get_similar_pathways',
    description: 'Statistics from a cohort of other patients in this world with the same condition: how many are at each stage, typical days between stages, typical waiting time, common blockers and needs. Use it when the patient asks what is typical, how long things usually take, or what happens to people like them. Always say the figures come from other patients in this (synthetic) service, not a promise about them.',
    schema: z.object({ condition: z.string().describe('Condition name, e.g. Arthritis') }),
    execute: async (ctx) => {
      const c = loadCohort()
      const key = Object.keys(c.byCondition).find((k) => k.toLowerCase() === ctx.args.condition.toLowerCase())
      const group = key ? c.byCondition[key] : null
      if (!group) return { available: Object.keys(c.byCondition).filter((k) => k !== 'all'), note: `No cohort for ${ctx.args.condition}; overall figures follow`, overall: c.byCondition.all }
      const examples = c.patients.filter((p: any) => p.conditions.includes(key)).filter((p: any) => Object.keys(p.transitionsDays).length).slice(0, 5)
        .map((p: any) => ({ currentStage: p.currentStage, transitionsDays: p.transitionsDays, waitingDays: p.waitingDays, blockers: p.blockers.slice(0, 2) }))
      return { condition: key, builtAt: c.builtAt, cohort: group, examples }
    },
  })

  return [search_patients, get_patient_pathway, get_capacity, get_appointment_sessions, get_resource, get_similar_pathways]
}

function loadCohort(): any { return readJson('cohort.json') }
