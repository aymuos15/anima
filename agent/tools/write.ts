import { z } from 'zod'
import type { app as App } from '../app.js'
import { sim, SimError, SITES } from '../sim.js'

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
      sessionVersion: z.number().int().positive(),
      startsAt: z.number().int().describe('Slot start, Unix milliseconds, within the session'),
      startsAtText: z.string().describe('The same time in words for the patient, e.g. Tuesday 23 September, 8:00am'),
      title: z.string().max(120),
    }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run('gp', { type: 'book_appointment', patientId: ctx.args.patientId, sessionId: ctx.args.sessionId, sessionVersion: ctx.args.sessionVersion, startsAt: ctx.args.startsAt, title: ctx.args.title })
      : declined(ctx.input?.note)),
  })

  const order_test = app.tool({
    name: 'order_test',
    description: 'Propose a blood test order. Requires explicit patient approval.',
    schema: z.object({ patientId: z.string(), panelId: z.enum(['fbc', 'ue', 'hba1c', 'lft', 'crp', 'lipids']), priority: z.enum(['routine', 'urgent']).default('routine'), collection: z.enum(['now', 'next-round']).default('next-round'), clinicalDetails: z.string() }),
    yieldSchema: approval,
    finalize: async (ctx) => (ctx.input?.approved
      ? run('gp', { type: 'order_test', patientId: ctx.args.patientId, title: ctx.args.panelId.toUpperCase(), bloodTestOrder: { panel: ctx.args.panelId.toUpperCase(), specimen: 'Blood', panelId: ctx.args.panelId, priority: ctx.args.priority, collection: ctx.args.collection, clinicalDetails: ctx.args.clinicalDetails } })
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
    schema: z.object({ patientId: z.string(), resourceId: z.string(), expectedVersion: z.number().int().positive(), command: z.enum(['review', 'accept', 'complete']), reason: z.string() }),
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

  return [ask_patient, create_task, send_message, book_appointment, order_test, schedule_visit, progress_referral, share_record]
}

export const WRITE_TOOL_NAMES = new Set(['order_test', 'create_task', 'send_message', 'book_appointment', 'schedule_visit', 'progress_referral', 'share_record'])
