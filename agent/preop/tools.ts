import { z } from 'zod'
import type { app as App } from '../app.js'
import { sim } from '../sim.js'
import { writeTools } from '../tools/write.js'
import { getState, savePatient, type PatientRun, type ChecklistItem } from './store.js'
import { classify, type Classification } from './rules.js'

export function retainRefs(patient: PatientRun, itemId: ChecklistItem['id'], result: unknown) {
  const item = patient.checklist.find(i => i.id === itemId)!
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const r = value as Record<string, unknown>
    if (typeof r.id === 'string' && typeof r.kind === 'string' && !item.simRefs.some(x => x.resourceId === r.id)) item.simRefs.push({ site: String(r.owner ?? 'gp'), resourceId: r.id, kind: r.kind })
    for (const v of Object.values(r)) if (v && typeof v === 'object') visit(v)
  }
  visit(result)
}
export async function staffAction(patient: PatientRun, event: Classification, itemId: ChecklistItem['id']) {
  if (!event.staffAction || !event.allowedActions.includes('create_task')) return
  const a = event.staffAction
  const title = `${a.priority.toUpperCase()} · ${a.owner}: ${a.title}`
  const result = await sim.action('gp', { type: 'create_task', patientId: patient.patientId, title, text: `Priority: ${a.priority}. Clinical owner: ${a.owner}.`, target: a.owner === 'gp' ? 'gp' : 'hospital' })
  retainRefs(patient, itemId, result)
  savePatient(patient)
  const refs = patient.checklist.find(i => i.id === itemId)!.simRefs
  const view = await sim.view('gp', patient.patientId, 500)
  const task = view.resources.find(r => r.kind === 'task' && r.title === title && refs.some(ref => ref.resourceId === r.id))
  if (!task) throw new Error('The created clinical task is not visible in the patient record')
  console.info('[preop-task-record]', JSON.stringify({ patientId: patient.patientId, resourceId: task.id, title: task.title, recordOwner: task.owner, recordPriority: task.priority, intendedClinicalOwner: a.owner, intendedUrgency: a.priority }))

}
export async function escalatePatient(patient: PatientRun, symptom: string) {
  const event = classify('red_flag_raised', patient)
  const item = patient.checklist.find(i => i.id === 'anaesthetic_questions')!
  item.state = 'review'; item.detail = symptom; item.updatedAtStep = getState().step
  patient.results.push({ itemId: item.id, outcome: event.code, step: getState().step, classification: event })
  savePatient(patient)
  await staffAction(patient, { ...event, staffAction: event.staffAction && { ...event.staffAction, title: event.staffAction.title.replace('[symptom]', symptom) } }, item.id)
  return event
}
export function preopTools(app: typeof App) {
  const existing = writeTools(app).filter(t => ['ask_patient', 'book_appointment', 'order_test', 'create_task'].includes(t.name))
  const guarded = existing.map(t => ({ ...t, finalize: t.finalize && (async (ctx: any) => {
    if (ctx.state?.wordingOnly || ctx.state?.escalated || ctx.state?.pendingEvent) return { status: 'blocked', guidance: 'The server owns event actions and this turn.' }
    const result = await (t.finalize as any)(ctx)
    if (result.status === 'done' && ['book_appointment', 'order_test'].includes(t.name)) {
      const patient = getState().patients[ctx.state.patientId]
      if (patient) {
        retainRefs(patient, 'bloods', result.result)
        const item = patient.checklist.find(i => i.id === 'bloods')!
        item.state = 'booked'; item.dueStep = getState().step + 1; item.updatedAtStep = getState().step
        savePatient(patient)
      }
    }
    return result
  }) }))
  const save_problem = app.tool({
    name: 'save_problem', description: 'Record pre-operative assessment in progress once at run start after approval. Never for escalation.',
    schema: z.object({ patientId: z.string(), title: z.string(), problemStatus: z.enum(['active', 'resolved']) }), yieldSchema: z.object({ approved: z.boolean() }),
    finalize: async ctx => {
      if (!ctx.input?.approved || ctx.state.escalated || ctx.state.wordingOnly || ctx.args.title !== 'Pre-operative assessment in progress') return { status: 'blocked' }
      const patient = getState().patients[ctx.state.patientId]
      if (!patient || patient.checklist.some(i => i.simRefs.some(r => r.kind === 'problem'))) return { status: 'blocked' }
      const result = await sim.action('gp', { type: 'save_problem', ...ctx.args }); retainRefs(patient, 'physio', result); savePatient(patient); return result
    },
  })
  const update_checklist = app.tool({
    name: 'update_checklist', description: 'Set a nonclinical conversation item after the patient settles it. Never changes test results or clinical questions.',
    schema: z.object({ itemId: z.enum(['physio', 'transport']), state: z.enum(['pending', 'done']), detail: z.string() }),
    execute: ctx => { if (ctx.state.escalated || ctx.state.wordingOnly || ctx.state.pendingEvent) return { status: 'blocked' }; const p = getState().patients[ctx.state.patientId]; const item = p.checklist.find(i => i.id === ctx.args.itemId)!; Object.assign(item, ctx.args, { updatedAtStep: getState().step }); savePatient(p); return item },
  })
  const escalate = app.tool({ name: 'escalate', description: 'Escalation is server-only. Report symptoms for the deterministic detector.', schema: z.object({ patientId: z.string(), symptom: z.string() }), execute: () => ({ status: 'blocked', guidance: 'The server detector exclusively decides escalation.' }) })
  return [...guarded, save_problem, update_checklist, escalate]
}
