import { readFileSync, appendFileSync } from 'node:fs'
import { openai } from '@animahealth/adk/openai'
import { app } from '../app.js'
import { readTools } from '../tools/read.js'
import { preopTools } from './tools.js'

export const protocol = readFileSync(new URL('./skills/elective-preop.md', import.meta.url), 'utf8')
export const SYSTEM = `You are the pre-operative coordinator for Northbank General, messaging one patient who is booked for elective surgery. Use their real record and active modifiers. NHS plain English, short sentences, no jargon, exclamation marks or emojis. Aim for at most 35 words; always under 80 words and at most one question per message. First name at the start only.
Never interpret tests, diagnose, reassure about symptoms, or decide clinical severity. All result and safety-net messages are emitted verbatim by the server from rules.ts; never replace them. An escalated session permits only the server's create_task and no further questions, now or later.
Never invent dates, slots, results, clinicians or phone numbers. Use real sessions. Propose every write and wait for explicit approval. Ambiguous replies never approve a write. Never retry a conflict.
Before results: physio teaching and progress, appointment, three anaesthetic questions, transport. After results: blood follow-up, ECG completion only, individual nutrition drinks, arrival, final questions. Respect needs and goals. The server owns the protocol stage and clinical detector. If wordingOnly is true, do not call ANY tool: write the next patient message using the supplied facts and required final question. Preserve the supplied text exactly; you may prefix only "Thank you. " or "Thanks. " when appropriate and within 35 words. Preserve every logistical commitment and recorded modifier. The current incoming instruction contains the authoritative step and patient response. It does not authorize any clinical inference. Theatre-blocked patients get no promise of a surgery day.`
export const preopAgent = app.agent({
  name: 'preop_agent',
  model: openai(process.env.MODEL ?? 'gpt-5.6-luna', { reasoning: { effort: 'low' } }),
  context: [
    app.context.system(SYSTEM),
    app.context.system(protocol),
    app.context.system(ctx => `Patient ${ctx.state.patientName} (${ctx.state.patientId}); procedure ${ctx.state.procedureLabel}; days to surgery ${ctx.state.daysToSurgery}; needs ${ctx.state.needs.join(', ')}; conditions ${ctx.state.conditions.join(', ')}; modifiers ${ctx.state.modifiers.join(', ')}; checklist ${JSON.stringify(ctx.state.checklist)}; pending event ${JSON.stringify(ctx.state.pendingEvent ?? null)}; escalated ${ctx.state.escalated}; wordingOnly ${ctx.state.wordingOnly}.`),
    app.context.history(),
  ],
  tools: [...readTools(app).filter(t => t.name !== 'search_patients'), ...preopTools(app)],
})

import { getState, savePatient, type PatientRun } from './store.js'
import { getAppointmentSessions } from '../tools/read.js'
import type { Session } from '@animahealth/adk'
export type Slot = Awaited<ReturnType<typeof getAppointmentSessions>>[number]
export interface Conversation {
  stage: 'physio' | 'physio_progress' | 'physio_help' | 'barrier' | 'slot' | 'medicines' | 'allergies' | 'red_flag' | 'transport' | 'waiting_results' | 'blood_followup' | 'ecg_completion' | 'nutrition' | 'nutrition_type' | 'nutrition_supply' | 'nutrition_timing' | 'arrival' | 'arrival_help' | 'questions' | 'finished'
  turns: number
  paused: boolean
  escalated: boolean
  pendingQuestion?: 'anaesthetic_red_flag'
  slots: Slot[]
  lastText: string
  supportTask?: boolean
  barrierTask?: string
  deferredText?: string
  deferredEvent?: boolean
  postResultsReady?: boolean
  postResultsStarted?: boolean
  bloodFollowupNeeded?: boolean
  physioHelp?: 'contact' | 'leaflet'
  nutritionDrinks?: string
  pendingEvent?: import('./rules.js').Classification
}
export const conversations = new Map<string, Conversation>()
export const PICKUP = 'We will pick this up next week. Your pre-op team can help if you need anything before then.'
export const CLOSING = "Your preparation answers are recorded. Follow your hospital's instructions about eating, drinking and medicines. Your hospital team will confirm the operation arrangements."
export function conversation(patient: PatientRun): Conversation {
  let c = conversations.get(patient.patientId)
  if (!c) {
    c = { stage: 'physio', turns: 0, paused: false, escalated: patient.checklist.some(i => i.state === 'review' && i.id === 'anaesthetic_questions'), slots: [], lastText: '' }
    conversations.set(patient.patientId, c)
  }
  return c
}
export function approval(text: string, options: string[] = []): 'yes' | 'no' | 'ambiguous' {
  const t = text.trim().toLowerCase().replace(/[.!]$/, '')
  if (options.some(o => o.toLowerCase() === t) || /^(yes|yes please|ok|okay|sure|please do|agreed|go ahead)$/.test(t)) return 'yes'
  if (/^(no|no thanks|not now|later|neither|cancel)$/.test(t)) return 'no'
  return 'ambiguous'
}
export function lintOutbound(text: string, eventText?: string) {
  if (!text.trim() || text.trim().split(/\s+/).length >= 80 || (text.match(/\?/g) ?? []).length > 1 || /nothing to worry about|should be fine|a bit high but|you (?:have|probably have) (?:anaemia|anemia|atrial fibrillation)/i.test(text)) throw new Error('Outbound wording gate failed')
  if (eventText !== undefined && text !== eventText) throw new Error('Event explanation is not verbatim')
}
const preopChat = app.handler.rest({ agent: preopAgent, response: { state: true } })
export async function renderConversation(patient: PatientRun, approvedText: string, inbound = '', runTurn: typeof preopChat = preopChat) {
  lintOutbound(approvedText)
  const state = { ...patient, patientName: patient.name, daysToSurgery: 28 - 7 * getState().step, goals: [], wordingOnly: true, escalated: conversation(patient).escalated, pendingEvent: conversation(patient).pendingEvent }
  const session = (patient.sessionId && await app.sessions.get(patient.sessionId)) || await app.sessions.create()
  session.state.update(state)
  const updated = await app.sessions.commit(session)
  if (!updated.ok) throw new Error('Could not refresh the pre-op session state')
  patient.sessionId = session.id
  savePatient(patient)
  if (process.env.PREOP_MODEL_OFF === '1') return approvedText
  let raw = ''
  try {
    const out = await runTurn({ sessionId: patient.sessionId, input: { message: `Current record and protocol state: ${JSON.stringify(state)}\nPatient reply: ${JSON.stringify(inbound)}\nWrite the next patient message using these approved facts. Preserve the final question exactly. Copy the approved text exactly; optionally prefix only "Thank you. " or "Thanks. " if the result is at most 35 words. No tools, new promises or clinical interpretation: ${approvedText}`, state } })
    raw = out.output.text ?? ''
    if (out.error || out.status === 'error' || out.yieldedTools?.length) throw new Error(`Pre-op model turn failed: ${out.error ?? out.status}`)
    patient.sessionId = out.sessionId
    savePatient(patient)
    lintOutbound(raw)
    const prefixes = ['', 'Thank you. ', 'Thanks. ']
    if (!prefixes.some(prefix => raw === prefix + approvedText)) throw new Error('Model changed approved protocol facts')
    if (raw !== approvedText && raw.trim().split(/\s+/).length > 35) throw new Error('Model acknowledgement exceeded concise turn target')
    return raw
  } catch (error) {
    appendFileSync('/tmp/preop-wording-rejections.jsonl', JSON.stringify({ at: new Date().toISOString(), patientId: patient.patientId, reason: String(error), raw, canonical: approvedText }) + '\n', { mode: 0o600 })
    console.warn('[preop] canonical protocol message used after model output failed its gate')
    return approvedText
  }
}


export async function captureConversationSnapshot() {
  const sessions: Session[] = []
  for (const patient of Object.values(getState().patients)) {
    if (!patient.sessionId) continue
    const session = await app.sessions.get(patient.sessionId)
    if (session) sessions.push(session.clone())
  }
  return { conversations: structuredClone([...conversations]), sessions }
}
export async function restoreConversationSnapshot(snapshot: Awaited<ReturnType<typeof captureConversationSnapshot>>) {
  conversations.clear()
  for (const [id, c] of snapshot.conversations) conversations.set(id, structuredClone(c))
  for (const session of snapshot.sessions) {
    await app.sessions.delete(session.id)
    const result = await app.sessions.commit(session.clone(), 0)
    if (!result.ok) throw new Error('Could not restore the pre-op session history')
  }
}
