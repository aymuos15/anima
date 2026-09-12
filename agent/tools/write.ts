import { z } from 'zod'
import type { app as App } from '../app.js'
import { sim, SimError, SITES } from '../sim.js'
import { invalidatePathways } from '../pathway.js'

// Every write tool yields: the run pauses, the patient answers in the app, finalize runs the sim action only on approval.
const approval = z.object({
  approved: z.boolean().describe('Whether the patient approved this action'),
  note: z.string().optional().describe('Anything the patient added'),
})

function declined(note?: string) {
  return { status: 'declined' as const, note, guidance: 'The patient declined. Acknowledge briefly and offer an alternative or ask what would suit.' }
}

async function run(site: (typeof SITES)[number], action: Record<string, unknown>) {
  try {
    const result = await sim.action(site, action)
    invalidatePathways(typeof action.patientId === 'string' ? action.patientId : undefined)
    return { status: 'done' as const, result }
  } catch (e) {
    if (e instanceof SimError && e.status === 409) {
      return { status: 'conflict' as const, detail: e.body, guidance: 'Capacity is exhausted or the version is stale. Re-read the pathway and offer the patient an alternative. Do not retry the same request.' }
    }
    return { status: 'error' as const, detail: String(e) }
  }
}

export function writeTools(app: typeof App) {
  const ask_patient = app.tool({
    name: 'ask_patient',
    description: 'Ask the patient a question with a short list of tap-to-answer options. Use this for any choice (dates, preferences, yes/no) instead of asking in prose. The run pauses until they answer.',
    schema: z.object({
      question: z.string().describe('The question, one sentence, plain English'),
      options: z.array(z.string().min(1).max(40)).min(2).max(4).describe('Short option labels the patient can tap'),
    }),
    yieldSchema: z.object({ choice: z.string().describe('The option the patient chose, or free text') }),
    finalize: (ctx) => ({ question: ctx.args.question, choice: ctx.input?.choice }),
  })

  const create_task = app.tool({
    name: 'create_task',
    description: 'Propose a follow-up task for the GP practice about this patient. Requires patient approval.',
    schema: z.object({ patientId: z.string(), title: z.string().min(3).max(120), reason: z.string().describe('One sentence for the patient explaining why') }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved ? run('gp', { type: 'create_task', patientId: ctx.args.patientId, title: ctx.args.title }) : declined(ctx.input?.note)),
  })

  const send_message = app.tool({
    name: 'send_message',
    description: 'Propose sending the patient a written confirmation by SMS or email (for example appointment details). Requires patient approval.',
    schema: z.object({ patientId: z.string(), subject: z.string().max(160), body: z.string().max(2000), channel: z.enum(['sms', 'email']) }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run('gp', { type: 'send_message', patientId: ctx.args.patientId, messagingCommand: { kind: 'create', subject: ctx.args.subject, body: ctx.args.body, channel: ctx.args.channel, allowReply: true } })
      : declined(ctx.input?.note)),
  })

  const book_appointment = app.tool({
    name: 'book_appointment',
    description: 'Propose booking the patient into a GP appointment session. Get sessionId, sessionVersion and a startsAt inside the session from get_appointment_sessions first. Requires patient approval.',
    schema: z.object({
      patientId: z.string(),
      sessionId: z.string(),
      sessionVersion: z.number().int().min(1),
      startsAt: z.number().int().describe('Slot start, Unix milliseconds, within the session'),
      startsAtText: z.string().describe('The same time in words for the patient, e.g. Tuesday 23 September, 8:00am'),
      title: z.string().max(120),
    }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run('gp', { type: 'book_appointment', patientId: ctx.args.patientId, sessionId: ctx.args.sessionId, sessionVersion: ctx.args.sessionVersion, startsAt: ctx.args.startsAt, title: ctx.args.title })
      : declined(ctx.input?.note)),
  })

  const schedule_visit = app.tool({
    name: 'schedule_visit',
    description: 'Propose a community team home visit for the patient. Capacity is limited. Requires patient approval.',
    schema: z.object({ patientId: z.string(), title: z.string().max(120), reason: z.string() }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved ? run('gp', { type: 'schedule_visit', patientId: ctx.args.patientId, title: ctx.args.title }) : declined(ctx.input?.note)),
  })

  const progress_referral = app.tool({
    name: 'progress_referral',
    description: 'Propose moving a referral forward (review, accept or complete) on the referrals service. Read the referral first for its current version. Requires patient approval.',
    schema: z.object({ patientId: z.string(), resourceId: z.string(), expectedVersion: z.number().int().min(1), command: z.enum(['review', 'accept', 'complete']), reason: z.string() }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run('referrals', { type: ctx.args.command, patientId: ctx.args.patientId, resourceId: ctx.args.resourceId, expectedVersion: ctx.args.expectedVersion })
      : declined(ctx.input?.note)),
  })

  const share_record = app.tool({
    name: 'share_record',
    description: 'Propose sharing a document (for example an imaging report) with another service so a referral can proceed. Requires patient approval.',
    schema: z.object({ patientId: z.string(), site: z.enum(SITES), resourceId: z.string(), target: z.enum(SITES), reason: z.string() }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run(ctx.args.site, { type: 'share_record', patientId: ctx.args.patientId, resourceId: ctx.args.resourceId, target: ctx.args.target })
      : declined(ctx.input?.note)),
  })

  const prescription_action = app.tool({
    name: 'prescription_action',
    description: 'Propose moving a prescription through the pharmacy: link_stock (attach a pharmacy product and quantity so it can be dispensed), review, accept, dispense (deducts stock) or collect. Use the prescription id and its current version from get_patient_pathway medicines. Requires patient approval.',
    schema: z.object({
      patientId: z.string(), resourceId: z.string(), expectedVersion: z.number().int().min(1),
      command: z.enum(['link_stock', 'review', 'accept', 'dispense', 'collect']),
      productId: z.string().nullable().optional().describe('For link_stock, e.g. pharmacy-product-furosemide'),
      quantity: z.number().int().min(1).nullable().optional().describe('For link_stock, units to supply, e.g. 28'),
      reason: z.string().describe('One sentence for the patient'),
    }),
    yieldSchema: approval,
    finalize: async (ctx) => {
      if (!ctx.input?.approved) return declined(ctx.input?.note)
      const a = ctx.args
      const base = { patientId: a.patientId, resourceId: a.resourceId, expectedVersion: a.expectedVersion }
      return a.command === 'link_stock'
        ? run('pharmacy', { type: 'link_prescription_stock', ...base, productId: a.productId, quantity: a.quantity })
        : run('pharmacy', { type: a.command, ...base })
    },
  })

  const order_test = app.tool({
    name: 'order_test',
    description: 'Propose ordering a blood test for monitoring (for example U&E after starting a diuretic). Results arrive in diagnostics after time passes. Requires patient approval.',
    schema: z.object({
      patientId: z.string(), title: z.string().max(120),
      panelId: z.enum(['fbc', 'ue', 'hba1c', 'lft', 'crp', 'lipids']), priority: z.enum(['routine', 'urgent']),
      clinicalDetails: z.string().max(500), reason: z.string().describe('One sentence for the patient'),
    }),
    yieldSchema: approval,
    finalize: async (ctx) => {
      if (!ctx.input?.approved) return declined(ctx.input?.note)
      const a = ctx.args
      const names: Record<string, string> = { fbc: 'Full blood count', ue: 'Urea & electrolytes', hba1c: 'HbA1c', lft: 'Liver function tests', crp: 'C-reactive protein', lipids: 'Lipid profile' }
      return run('gp', { type: 'order_test', patientId: a.patientId, title: a.title, bloodTestOrder: { panel: names[a.panelId], panelId: a.panelId, specimen: 'Blood', priority: a.priority, collection: 'next-round', clinicalDetails: a.clinicalDetails } })
    },
  })

  const hospital_command = app.tool({
    name: 'hospital_command',
    description: 'Propose moving the patient\'s hospital attendance forward: assign (needs clinician), assess (needs clinician), refer, admit, or discharge (needs disposition, e.g. "Home with community follow-up"). Use the attendance id and version from get_patient_pathway medicines.attendance. Requires patient approval.',
    schema: z.object({
      patientId: z.string(), resourceId: z.string(), expectedVersion: z.number().int().min(1),
      command: z.enum(['assign', 'assess', 'refer', 'admit', 'discharge']),
      clinician: z.string().nullable().optional(), disposition: z.string().nullable().optional(), location: z.string().nullable().optional(),
      reason: z.string().describe('One sentence for the patient'),
    }),
    yieldSchema: approval,
    finalize: async (ctx) => {
      if (!ctx.input?.approved) return declined(ctx.input?.note)
      const a = ctx.args
      const extra: Record<string, unknown> = {}
      if (a.clinician) extra.clinician = a.clinician
      if (a.disposition) extra.disposition = a.disposition
      if (a.location) extra.location = a.location
      return run('hospital', { type: 'update_attendance', patientId: a.patientId, resourceId: a.resourceId, expectedVersion: a.expectedVersion, hospitalCommand: a.command, ...extra })
    },
  })

  const complete_task = app.tool({
    name: 'complete_task',
    description: 'Propose closing an open GP practice task once what it asked for has been arranged (for example monitoring is booked). Use the task id and version from get_patient_pathway medicines.openTasks. Requires patient approval.',
    schema: z.object({ patientId: z.string(), resourceId: z.string(), expectedVersion: z.number().int().min(1), reason: z.string().describe('One sentence for the patient') }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run('gp', { type: 'complete', patientId: ctx.args.patientId, resourceId: ctx.args.resourceId, expectedVersion: ctx.args.expectedVersion })
      : declined(ctx.input?.note)),
  })

  return [ask_patient, create_task, send_message, book_appointment, schedule_visit, progress_referral, share_record, prescription_action, order_test, hospital_command, complete_task]
}

export const WRITE_TOOL_NAMES = new Set(['create_task', 'send_message', 'book_appointment', 'schedule_visit', 'progress_referral', 'share_record', 'prescription_action', 'order_test', 'hospital_command', 'complete_task'])
