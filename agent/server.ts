import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { app } from './app.js'
import { pathwayAgent, auditHook } from './agents.js'
import { buildPathway, fmtDate } from './pathway.js'
import { sim } from './sim.js'
import { getState, resetState, saveState, savePatient, readiness, type PatientRun, type ChecklistItem } from './preop/store.js'
import { loadCohort, getFeaturedPatientIds, preparePatientRun } from './preop/cohort.js'
import { seedStallWorld } from './preop/seed.js'
import { stepTimeline } from './preop/timeline.js'
import { classify, detectRedFlag, BLOODS_FOLLOWUP } from './preop/rules.js'
import { conversations, conversation, approval, renderConversation, lintOutbound, PICKUP, CLOSING, captureConversationSnapshot, restoreConversationSnapshot } from './preop/agent.js'
import { retainRefs, staffAction, escalatePatient } from './preop/tools.js'
import { getAppointmentSessions } from './tools/read.js'
import { writeTools } from './tools/write.js'
import { assertAllowed, sendIMessage, pollIMessages } from './imessage.js'
import { handleVoice } from './preop/voice.js'


const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const PORT = Number(process.env.PORT ?? 8790)

const chat = app.handler.rest({ agent: pathwayAgent, hooks: [auditHook as any], response: { state: true } })

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.png': 'image/png' }

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

async function readBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

const writeDefinitions = writeTools({ tool: (config: any) => config } as any) as any[]
let demoInit: Promise<void> | undefined
async function ensureDemo() {
  demoInit ??= (async () => {
    const existing = getState(), world = existing.world || process.env.SIM_WORLD || 'unlabelled'
    if (/^13health-stall(?:-\d+)?$/.test(world) && Object.keys(existing.patients).length < 4) await seedStallWorld()
    const cohort = await loadCohort()
    if (!Object.keys(existing.patients).length) resetState(world, cohort)
    else saveState({ ...existing, patients: Object.fromEntries(cohort.map(p => [p.patientId, existing.patients[p.patientId]?.transcript.length ? existing.patients[p.patientId] : p])) })
  })()
  try { await demoInit } catch (error) { demoInit = undefined; throw error }
}
async function deliver(patientId: string, text: string, eventText?: string) {
  lintOutbound(text, eventText)
  const p = getState().patients[patientId]
  p.transcript.push({ at: Date.now(), from: 'agent', text }); p.lastContactAt = Date.now(); savePatient(p)
  conversation(p).lastText = text
  if (p.phone) { const sent = await sendIMessage(p.phone, text); if (!sent) console.warn(`[preop] ${patientId}: send unavailable; transcript/console fallback active`) }
}
async function say(patient: PatientRun, text: string, inbound = '', event = false) {
  patient = getState().patients[patient.patientId]
  const c = conversation(patient)
  if (c.paused || c.escalated) return false
  if (c.turns >= 8) { c.paused = true; c.deferredText = text; c.deferredEvent = event; await deliver(patient.patientId, PICKUP); return false }
  if (event) await deliver(patient.patientId, text, text)
  else await deliver(patient.patientId, await renderConversation(patient, text, inbound))
  c.turns++
  return true
}
async function runWrite(patient: PatientRun, name: string, args: Record<string, unknown>, item: ChecklistItem['id']) {
  if (conversation(patient).escalated && name !== 'create_task') throw new Error('Escalated session blocks this write')
  const tool = writeDefinitions.find(t => t.name === name)
  const result = await tool.finalize({ args: tool.schema.parse({ patientId: patient.patientId, ...args }), input: { approved: true } })
  if (result.status !== 'done') throw new Error(`${result.status}: ${JSON.stringify(result.detail ?? result.guidance)}`)
  retainRefs(patient, item, result.result); savePatient(patient)
  return result.result
}
async function offerSlots(patient: PatientRun, intro = '') {
  const c = conversation(patient)
  c.stage = 'slot'; c.slots = await getAppointmentSessions(patient.modifiers.includes('slots_late'))
  if (c.slots.length < 2) { await say(patient, 'The practice needs to confirm two suitable appointments. Please contact the practice for help arranging your visit.'); return }
  const extra = patient.modifiers.includes('add_hba1c') ? ', plus HbA1c for blood sugar' : ''
  await say(patient, `${intro}I can book bloods and ECG, ordering blood count and kidney/salt tests${extra}. Which visit suits you: 1, ${c.slots[0].startsAtText}, or 2, ${c.slots[1].startsAtText}?`)
}
async function demoStart(patientId: string, phone?: string) {
  if (stepping) throw new Error('The timeline is changing; please start again when it finishes')
  if (phone) assertAllowed(phone)
  if (phone && Object.values(getState().patients).some(p => p.phone === phone && p.patientId !== patientId && p.sessionId)) throw new Error('This phone already has an active patient')
  if (getState().patients[patientId]?.transcript.length) throw new Error('This patient is already started; use Reply or Reset')
  const p = await preparePatientRun(patientId)
  if (phone) p.phone = phone
  savePatient(p); conversations.delete(patientId)
  const prefix = p.modifiers.includes('theatre_blocked') ? 'The hospital is confirming your operation date. ' : ''
  await say(p, `Hello ${p.name.split(' ')[0]}, I am coordinating your surgery preparation. ${prefix}Has someone shown you the physiotherapy exercises to do before your operation?`)
  const current = getState().patients[patientId]
  const coded = await sim.action('gp', { type: 'save_problem', patientId, title: 'Pre-operative assessment in progress', problemStatus: 'active' })
  retainRefs(current, 'physio', coded); savePatient(current)
}
const PHYSIO_LEAFLET = 'https://www.medway.nhs.uk/patients-and-visitors/having-surgery/hip-or-knee/'
async function askECG(p: PatientRun) {
  const c = conversation(p)
  c.stage = 'ecg_completion'
  const text = classify('ecg_normal', p).patientExplanation
  await say(p, text, '', true)
}
async function beginResults(p: PatientRun) {
  const c = conversation(p)
  if (!c.postResultsReady || c.postResultsStarted || c.escalated) return false
  c.postResultsStarted = true
  const blood = [...p.results].reverse().find(r => r.itemId === 'bloods')
  if (blood?.outcome === 'bloods_normal') await deliver(p.patientId, blood.classification.patientExplanation, blood.classification.patientExplanation)
  if (c.bloodFollowupNeeded) {
    c.stage = 'blood_followup'
    const text = classify('bloods_low_hb', p).patientExplanation
    await say(p, text, '', true)
  } else await askECG(p)
  return true
}
async function askNutrition(p: PatientRun, intro = '') {
  conversation(p).stage = 'nutrition'
  await say(p, intro + 'Has your surgical team given you any drinks to take before your operation?')
}
async function askArrival(p: PatientRun, intro = '') {
  conversation(p).stage = 'arrival'
  await say(p, intro + 'Do you know where to go when you arrive at the hospital?')
}
async function askFinal(p: PatientRun, intro = '') {
  conversation(p).stage = 'questions'
  await say(p, intro + "Is there anything else you'd like to ask about preparing for your operation?")
}
const replying = new Set<string>()
let stepping = false
const conversationSnapshots = new Map<string, Awaited<ReturnType<typeof captureConversationSnapshot>>>()
export async function demoReply(patientId: string, text: string) {
  if (stepping) throw new Error('The timeline is changing; please send your reply again')
  if (replying.has(patientId)) throw new Error('A reply is already being processed for this patient')
  const patient = getState().patients[patientId]
  const before = patient && structuredClone(conversation(patient))
  replying.add(patientId)
  try { await handleDemoReply(patientId, text) } catch (error) { if (before && !conversations.get(patientId)?.escalated) conversations.set(patientId, before); throw error } finally { replying.delete(patientId) }
}
async function handleDemoReply(patientId: string, text: string) {
  const p = getState().patients[patientId]
  if (!p || !p.transcript.length) throw new Error('Start this patient first')
  const c = conversation(p)
  p.transcript.push({ at: Date.now(), from: 'patient', text }); savePatient(p)
  const symptom = detectRedFlag(text, c.pendingQuestion)
  if (c.escalated) return
  if (symptom) {
    c.escalated = true; c.pendingQuestion = undefined
    c.pendingEvent = classify('red_flag_raised', p)
    try { await escalatePatient(p, symptom) } finally { const explanation = c.pendingEvent!.patientExplanation; await deliver(patientId, explanation, explanation); c.pendingEvent = undefined }
    return
  }
  if (c.paused) return
  const item = (id: ChecklistItem['id']) => p.checklist.find(i => i.id === id)!
  const settle = (id: ChecklistItem['id'], state: ChecklistItem['state'], detail: string) => { Object.assign(item(id), { state, detail, updatedAtStep: getState().step }); savePatient(p) }
  const answer = approval(text)
  const reported = /^(?:yes|yeah|yep)\b/i.test(text.trim()) ? 'yes' : /^(?:no|nope|not yet)\b/i.test(text.trim()) ? 'no' : answer
  if (c.stage === 'physio') {
    const taught = reported === 'yes' || (!/\b(no|not|never|haven.t)\b/i.test(text) && /shown|taught|doing (?:the |my )?exercises/i.test(text))
    if (taught) {
      settle('physio', 'pending', 'Patient confirms physiotherapy teaching; exercise progress still to check')
      c.stage = 'physio_progress'
      await say(p, 'How are you getting on with the exercises you were shown?', text)
    } else if (reported === 'no' || /not|never|haven.t/i.test(text)) {
      settle('physio', 'pending', 'Patient has not had physiotherapy teaching')
      c.stage = 'physio_help'; c.physioHelp = 'contact'
      await say(p, classify('physio_not_started', p).patientExplanation, text)
    } else await say(p, 'Has someone shown you the physiotherapy exercises to do before your operation?', text)
    return
  }
  if (c.stage === 'physio_progress') {
    if (reported === 'no' || /pain|difficult|struggl|cannot|can.t|not started|not (?:going|doing|managing)|not well|not really|haven.t|unsure|help|detail|forgot|leaflet|instructions/i.test(text)) {
      settle('physio', 'pending', 'Patient needs help with prescribed exercises: ' + text)
      c.stage = 'physio_help'; c.physioHelp = /pain|difficult|struggl|cannot|can.t/i.test(text) ? 'contact' : 'leaflet'
      await say(p, c.physioHelp === 'contact' ? 'Your physiotherapy team can check the exercises with you. Would you like help contacting them?' : 'Would you like the NHS joint surgery preparation leaflet to go over alongside your physiotherapist’s advice?', text)
    } else if (reported === 'yes' || /well|fine|good|daily|every day|regular|doing|started|okay|ok/i.test(text)) {
      settle('physio', 'done', 'Patient confirms physiotherapy teaching and exercise progress: ' + text)
      await offerSlots(p)
    } else await say(p, 'Are you managing the exercises you were shown?', text)
    return
  }
  if (c.stage === 'physio_help' || c.stage === 'barrier') {
    if (answer === 'ambiguous') { await say(p, c.lastText, text); return }
    if (answer === 'yes') {
      if (c.physioHelp === 'leaflet') await deliver(patientId, 'Here is the NHS joint surgery preparation information: ' + PHYSIO_LEAFLET + ' Follow your own physiotherapist’s exercise plan.')
      else await runWrite(p, 'create_task', { title: 'Help contacting physiotherapy before surgery', reason: 'Patient agreed to help contacting physiotherapy about preparation exercises' }, 'physio')
    }
    await offerSlots(p)
    return
  }
  if (c.stage === 'slot') {
    const normalized = text.trim().toLowerCase().replace(/[.!]$/, '')
    const index = c.slots.findIndex((s, i) => [String(i + 1), `option ${i + 1}`, i === 0 ? 'one' : 'two', i === 0 ? 'option one' : 'option two', i === 0 ? 'morning' : 'afternoon', s.startsAtText.toLowerCase()].includes(normalized))
    if (index < 0) {
      if (answer === 'no') { const excluded = new Set(c.slots.map(s => s.startsAt)); const alternatives = await getAppointmentSessions(!p.modifiers.includes('slots_late')); c.slots = alternatives.filter(s => !excluded.has(s.startsAt)); if (c.slots.length === 2) await say(p, `I have other times: 1, ${c.slots[0].startsAtText}, or 2, ${c.slots[1].startsAtText}. Which works?`, text); else await say(p, 'I will leave those appointments unbooked. The practice can help find another time.'); return }
      await say(p, 'Please choose option 1 or option 2, or say no to both. Which would you prefer?', text); return
    }
    const slot = c.slots[index]
    try {
      await runWrite(p, 'book_appointment', { ...slot, title: 'Pre-operative blood tests and ECG' }, 'bloods')
      item('ecg').simRefs.push(...item('bloods').simRefs.filter(r => r.kind === 'appointment'))
      await runWrite(p, 'create_task', { title: 'Book pre-op ECG at the phlebotomy visit', reason: 'Patient selected the combined bloods and ECG visit' }, 'ecg')
      for (const panelId of ['fbc', 'ue', ...(p.modifiers.includes('add_hba1c') ? ['hba1c'] : [])]) await runWrite(p, 'order_test', { panelId, clinicalDetails: 'Pre-operative assessment', priority: 'routine', collection: 'next-round' }, 'bloods')
      for (const id of ['bloods', 'ecg'] as const) Object.assign(item(id), { state: 'booked', detail: slot.startsAtText, dueStep: getState().step + 1, updatedAtStep: getState().step })
      savePatient(p)
    } catch (error) { console.warn('[preop] booking/order:', error); await say(p, 'The practice could not complete that arrangement. Please contact the practice to confirm your tests and appointment.'); return }
    c.stage = 'medicines'; await say(p, 'Your blood tests and heart tracing visit are arranged. What medicines do you take, including any blood thinners?', text); return
  }
  if (c.stage === 'medicines') { item('anaesthetic_questions').detail = `Medicines: ${text}`; savePatient(p); c.stage = 'allergies'; await say(p, 'Do you have any allergies or have you had problems with a previous anaesthetic?', text); return }
  if (c.stage === 'allergies') { item('anaesthetic_questions').detail += `; allergies/previous anaesthetic: ${text}`; savePatient(p); c.stage = 'red_flag'; if (await say(p, 'Have you had any chest pain, breathlessness or fever since you were booked?', text)) c.pendingQuestion = 'anaesthetic_red_flag'; return }
  if (c.stage === 'red_flag') {
    if (answer !== 'no' && !/^(none|no symptoms|not at all)$/i.test(text.trim())) { await say(p, 'Please answer yes or no. Have you had any chest pain, breathlessness or fever since you were booked?', text); return }
    c.pendingQuestion = undefined; settle('anaesthetic_questions', 'done', item('anaesthetic_questions').detail + '; no new red-flag symptoms'); c.stage = 'transport'
    const support = [p.modifiers.includes('transport_flag') && 'arrange transport', p.modifiers.includes('carer_flag') && 'include your carer in the plan', p.modifiers.includes('interpreter_flag') && 'book an interpreter for your visit'].filter(Boolean)
    await say(p, support.length ? `The practice can help with your recorded support needs. Shall I ask them to ${support.join(' and ')}?` : 'Is there someone to take you home and stay the first night?', text); return
  }
  if (c.stage === 'transport') {
    if (answer === 'ambiguous') { await say(p, c.lastText, text); return }
    if (answer === 'yes') {
      if (c.supportTask || p.modifiers.includes('transport_flag')) await runWrite(p, 'create_task', { title: 'Arrange transport home after surgery', reason: 'Patient agreed to practice transport help' }, 'transport')
      if (p.modifiers.includes('carer_flag')) await runWrite(p, 'create_task', { title: 'Include carer in pre-operative support plan', reason: 'Patient agreed to carer involvement' }, 'transport')
      if (p.modifiers.includes('interpreter_flag')) await runWrite(p, 'create_task', { title: 'Book interpreter for pre-op visit', reason: 'Patient agreed to interpreter support' }, 'transport')
      settle('transport', 'done', 'Journey and first-night support confirmed or practice help agreed'); c.stage = 'waiting_results'
      if (!await beginResults(p)) await say(p, 'Thank you. Your preparation answers are recorded. We will check in again after your tests.', text)
    } else if (!c.supportTask && !p.modifiers.some(m => ['transport_flag', 'carer_flag', 'interpreter_flag'].includes(m))) { c.supportTask = true; await say(p, 'The practice can help arrange transport and support. Shall I ask them to contact you?', text) }
    else { c.stage = 'waiting_results'; if (!await beginResults(p)) await say(p, 'Please contact the practice when you would like help with transport or support.', text) }
    return
  }
  if (c.stage === 'blood_followup') {
    if (reported === 'ambiguous' && !/\b(spoken|discussed|called|talked|nobody|no one)\b/i.test(text)) { const question = classify('bloods_low_hb', p).patientExplanation; await say(p, question, '', true); return }
    if (reported === 'no' || /not|haven.t|no one|nobody/i.test(text)) await deliver(patientId, BLOODS_FOLLOWUP, BLOODS_FOLLOWUP)
    c.bloodFollowupNeeded = false
    await askECG(p); return
  }
  if (c.stage === 'ecg_completion') {
    if (reported === 'yes' || (!/not|haven.t|no/i.test(text) && /had|done|completed/i.test(text))) {
      settle('ecg', p.results.some(r => r.outcome === 'ecg_new_af') ? 'review' : 'done', 'Patient confirms ECG completed; any flagged tracing still awaits clinician review')
      await askNutrition(p)
    } else if (reported === 'no' || /not|haven.t/i.test(text)) {
      settle('ecg', p.results.some(r => r.outcome === 'ecg_new_af') ? 'review' : 'pending', 'ECG completion not confirmed by patient; any flagged tracing still awaits clinician review')
      await askNutrition(p, 'Please contact your pre-assessment team to arrange your ECG. ')
    } else { const question = classify('ecg_normal', p).patientExplanation; await say(p, question, '', true) }
    return
  }
  if (c.stage === 'nutrition' || c.stage === 'nutrition_type') {
    if (/\?|do I need|should I/i.test(text)) { await say(p, 'Your surgical team should confirm any recommended drinks for you. Have they given you a personal drinks plan?', text); return }
    if (reported === 'no' || /none|not recommended|not given/i.test(text)) { await askArrival(p); return }
    if (c.stage === 'nutrition_type' || reported === 'yes' || /protein|shake|drink|preop|carb/i.test(text)) {
      c.nutritionDrinks = text
      if (/preop|carb/i.test(text) && /protein/i.test(text) && c.stage !== 'nutrition_type') {
        c.stage = 'nutrition_type'
        await say(p, 'Some pre-operation drinks contain carbohydrate rather than protein. What is the name on yours?', text); return
      }
      c.stage = 'nutrition_supply'
      await say(p, /protein/i.test(text) ? 'Have you received the protein shakes your surgical team recommended?' : 'Do you have the drinks your surgical team recommended?', text)
    } else await say(p, 'Has your surgical team recommended any drinks before your operation?', text)
    return
  }
  if (c.stage === 'nutrition_supply') {
    if (reported === 'no' || /not|haven.t|missing/i.test(text)) { await askArrival(p, 'Please contact your pre-assessment team to obtain the recommended drinks. '); return }
    if (reported === 'ambiguous' && !/have|received|got/i.test(text)) { await say(p, c.lastText, text); return }
    c.stage = 'nutrition_timing'
    const diabetes = p.modifiers.includes('add_hba1c'), renal = p.modifiers.includes('renal_caution')
    const intro = renal && diabetes ? 'With diabetes and kidney disease, your teams need to confirm which drinks suit you and your fasting plan. ' : renal ? 'With kidney disease, your kidney team or dietitian should check which drinks suit you. ' : diabetes ? 'With diabetes, your team needs to confirm your drinks and fasting plan. ' : ''
    await say(p, intro + 'What instructions were you given for taking them?', text)
    return
  }
  if (c.stage === 'nutrition_timing') {
    const unclear = /don.t know|unsure|no|not|when|how|\?/i.test(text)
    const intro = /preop|carb/i.test(c.nutritionDrinks ?? '') && /protein/i.test(c.nutritionDrinks ?? '') ? 'Pre-op carbohydrate drinks are not protein shakes; check the label with your team. ' : unclear ? 'Please check the drink timing and your personal fasting instructions with your pre-assessment team. ' : 'Follow your own team’s drink and fasting instructions. '
    await askArrival(p, intro); return
  }
  if (c.stage === 'arrival') {
    if (reported === 'yes' || /letter|know|entrance|ward/i.test(text) && !/don.t|not|unsure/i.test(text)) { await askFinal(p); return }
    if (reported === 'no' || /don.t|not|unsure|where/i.test(text)) { c.stage = 'arrival_help'; await say(p, 'Your admission letter should give your arrival details. Would you like help checking them?', text); return }
    await say(p, 'Do you know where to go when you arrive at the hospital?', text); return
  }
  if (c.stage === 'arrival_help') {
    if (answer === 'ambiguous') { await say(p, c.lastText, text); return }
    if (answer === 'yes') await runWrite(p, 'create_task', { title: 'Confirm hospital arrival details', reason: 'Patient agreed to help checking the admission location and arrival instructions' }, 'transport')
    await askFinal(p, answer === 'yes' ? 'I have asked the team to help check your arrival details. ' : '')
    return
  }
  if (c.stage === 'questions') {
    if (answer === 'no' || /nothing|that.s all|all clear/i.test(text)) { c.stage = 'finished'; await say(p, CLOSING, text); return }
    if (/link|leaflet|NHS/i.test(text) && /drink|protein|shake|carb/i.test(text)) {
      await say(p, 'This NHS leaflet explains carbohydrate pre-op drinks: https://www.royalfree.nhs.uk/patients-and-visitors/patient-information-leaflets/drinking-preop-r-surgery Follow your own team’s drink and fasting instructions.', text)
    } else if (/fast|eat|drink|nutrition|protein|shake|carb/i.test(text)) {
      await say(p, 'Follow your hospital’s personal instructions for drinks and fasting. Please contact pre-assessment if these are missing or unclear.', text)
    } else if (/physio|exercise|leaflet/i.test(text)) {
      await say(p, 'Follow your physiotherapist’s own exercise plan. The NHS joint surgery preparation information is here: ' + PHYSIO_LEAFLET, text)
    } else if (/ECG|tracing|blood|result/i.test(text)) {
      await say(p, 'Your clinical team needs to discuss what your results mean for you. Please contact your pre-assessment team about this.', text)
    } else await say(p, 'Your pre-assessment team can help with that question. Please contact them to check the advice for your operation.', text)
    return
  }
  if (c.stage === 'waiting_results') await beginResults(p)

}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (await handleVoice(req, res, url.pathname)) return
    if (url.pathname.startsWith('/api/demo/') || url.pathname === '/api/board') {
      await ensureDemo()
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (url.pathname === '/api/demo/start') await demoStart(body.patientId, body.phone?.trim() || undefined)
        else if (url.pathname === '/api/demo/reply') await demoReply(body.patientId, String(body.text ?? ''))
        else if (url.pathname === '/api/demo/reset') {
          const world = `13health-stall-${Date.now()}`
          const key = await sim.newWorld(world); sim.setKey(key.apiKey, true)
          conversations.clear(); conversationSnapshots.clear(); resetState(world, []); await seedStallWorld(); const cohort = await loadCohort(); saveState({ ...getState(), patients: Object.fromEntries(cohort.map(p => [p.patientId, p])) })
        } else if (url.pathname === '/api/demo/step') {
          if (stepping || replying.size) throw new Error('Please wait for the current patient reply before changing the timeline')
          stepping = true
          try {
          const beforeState = getState(), before = beforeState.step
          const key = `${beforeState.runId}:${body.direction === -1 ? before - 1 : before}`
          const snapshot = body.direction === 1 && before < 4 ? await captureConversationSnapshot() : conversationSnapshots.get(key)
          if (body.direction === -1 && beforeState.snapshots.length && !snapshot) throw new Error('Rewind needs the original conversation snapshot; reset after restarting the server')
          const { events, state } = await stepTimeline(body.direction, body.outcomes)
          if (state.step !== before && snapshot) {
            if (body.direction === 1) conversationSnapshots.set(key, snapshot)
            else { await restoreConversationSnapshot(snapshot); conversationSnapshots.delete(key) }
          }
          if (body.direction === 1 && state.step > before) {
            for (const c of conversations.values()) { c.turns = 0; c.paused = false }
            for (const { patientId, classification } of events) {
              const patient = getState().patients[patientId]
              if (!patient.transcript.length || conversation(patient).escalated) continue
              const item = [...patient.results].reverse().find(r => r.outcome === classification.code)!.itemId
              const c = conversation(patient)
              c.pendingEvent = classification
              try {
                if (classification.severity === 'urgent') {
                  c.escalated = true; c.pendingQuestion = undefined; c.deferredText = undefined
                  try { await staffAction(patient, classification, item) } finally { await deliver(patientId, classification.patientExplanation, classification.patientExplanation) }
                } else if (item === 'bloods' || item === 'ecg') {
                  await staffAction(patient, classification, item)
                  c.postResultsReady = true
                  if (classification.code === 'bloods_low_hb') c.bloodFollowupNeeded = true
                }
              } finally { c.pendingEvent = undefined }

            }
            for (const [patientId, c] of conversations) {
              if (c.deferredText && !c.escalated) {
                const deferred = c.deferredText, event = c.deferredEvent; c.deferredText = undefined; c.deferredEvent = undefined
                await say(getState().patients[patientId], deferred, '', event)
                if (c.stage === 'red_flag') c.pendingQuestion = 'anaesthetic_red_flag'
              }
            }
            for (const p of Object.values(getState().patients)) if (conversation(p).stage === 'waiting_results') await beginResults(p)
            if (state.step === 4) for (const p of Object.values(getState().patients)) if (p.status === 'done' && conversation(p).stage === 'finished' && conversation(p).lastText !== CLOSING) await deliver(p.patientId, CLOSING)
          }
          } finally { stepping = false }
        } else { json(res, 404, { error: 'Unknown demo route' }); return }
      }
      const state = getState()
      if (url.pathname === '/api/board') {
        const featuredPatientIds = getFeaturedPatientIds()
        const ids = [...featuredPatientIds, ...Object.keys(state.patients).filter(id => !featuredPatientIds.includes(id))]
        const rows = ids.map(id => ({ ...state.patients[id], readiness: readiness(state.patients[id]), daysToSurgery: 28 - 7 * state.step }))
        json(res, 200, { runId: state.runId, world: state.world, step: state.step, cohortCount: rows.length, notReadyCount: rows.filter(p => p.readiness < 1).length, featuredPatientIds, rows })
      } else json(res, 200, state)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req)
      const patientId: string | undefined = body.patientId
      let input = body.input ?? {}
      if (!body.sessionId && patientId) {
        const p = await buildPathway(patientId)
        input = {
          ...input,
          initialState: { session: {
            patientId, patientName: p.patient?.name ?? '', stage: p.currentStage, blockers: p.blockers,
            needs: p.patient?.needs ?? [], goals: p.patient?.goals ?? [],
          } },
        }
      }
      const t0 = Date.now()
      const out = await chat({ sessionId: body.sessionId, input })
      console.log(`[chat] ${patientId ?? out.sessionId} ${out.status} ${Date.now() - t0}ms yields=${out.yieldedTools?.length ?? 0}${out.error ? ' error=' + out.error : ''}`)
      json(res, 200, { sessionId: out.sessionId, status: out.status, text: out.output.text ?? '', yieldedTools: out.yieldedTools ?? [], error: out.error })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/patients/') && url.pathname.endsWith('/pathway')) {
      const id = url.pathname.split('/')[3]
      const p = await buildPathway(id)
      json(res, 200, { ...p, nowText: fmtDate(p.now), events: p.events.map((e) => ({ ...e, when: fmtDate(e.createdAt) })) })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/patients') {
      json(res, 200, await sim.patients(url.searchParams.get('q') ?? ''))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/clock/advance') {
      const body = await readBody(req)
      json(res, 200, await sim.advance(Number(body.minutes ?? 60)))
      return
    }

    // static files from the project root
    const file = url.pathname === '/' ? '/pathway.html' : url.pathname
    if (file.includes('..') || file === '/key.txt') { res.writeHead(404).end(); return }
    try {
      const data = await readFile(join(ROOT, file))
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data)
    } catch {
      res.writeHead(404).end('not found')
    }
  } catch (e) {
    console.error(e)
    json(res, 500, { error: String(e) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[server] http://127.0.0.1:${PORT}/  (model ${process.env.MODEL ?? 'gpt-5.6-luna'} via ${process.env.OPENAI_BASE_URL ?? 'api.openai.com'})`))

pollIMessages(() => Object.values(getState().patients).filter(p => p.phone && p.transcript.length && !conversation(p).escalated).map(p => ({ phone: p.phone!, patientId: p.patientId })), demoReply)
