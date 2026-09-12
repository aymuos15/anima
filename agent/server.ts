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
import { classify, detectRedFlag } from './preop/rules.js'
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
async function say(patient: PatientRun, text: string, inbound = '') {
  const c = conversation(patient)
  if (c.paused || c.escalated) return false
  if (c.turns >= 8) { c.paused = true; await deliver(patient.patientId, PICKUP); return false }
  await deliver(patient.patientId, await renderConversation(patient, text, inbound))
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
  const extra = patient.modifiers.includes('add_hba1c') ? ' HbA1c also checks your longer-term blood sugar.' : ''
  await say(patient, `${intro}We need a blood count, kidney and salt tests before your anaesthetic.${extra} I will book bloods and a heart tracing together and order the tests. Which works: 1, ${c.slots[0].startsAtText}, or 2, ${c.slots[1].startsAtText}?`)
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
  const transport = p.modifiers.includes('transport_flag') ? 'I can ask the practice to help with your recorded transport need. ' : ''
  await say(p, `Hello ${p.name.split(' ')[0]}, I am coordinating your preparation for ${p.procedureLabel}. ${prefix}${transport}Have you started your preparation exercises?`)
  const current = getState().patients[patientId]
  const coded = await sim.action('gp', { type: 'save_problem', patientId, title: 'Pre-operative assessment in progress', problemStatus: 'active' })
  retainRefs(current, 'physio', coded); savePatient(current)
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
  if (c.turns >= 8) { c.paused = true; c.pendingQuestion = undefined; await deliver(patientId, PICKUP); return }
  const item = (id: ChecklistItem['id']) => p.checklist.find(i => i.id === id)!
  const settle = (id: ChecklistItem['id'], state: ChecklistItem['state'], detail: string) => { Object.assign(item(id), { state, detail, updatedAtStep: getState().step }); savePatient(p) }
  const answer = approval(text)
  if (c.stage === 'physio') {
    if (answer === 'yes' || (!/\b(no|not|never|haven.t)\b/i.test(text) && /started|doing (?:the |my )?exercises/i.test(text))) { settle('physio', 'done', 'Patient has started preparation exercises'); await offerSlots(p); return }
    settle('physio', 'pending', 'Exercises not yet confirmed'); c.stage = 'barrier'
    const explanation = classify('physio_not_started', p).patientExplanation; await deliver(patientId, explanation, explanation); return
  }
  if (c.stage === 'barrier') {
    if (c.barrierTask) {
      if (answer === 'ambiguous') { await say(p, 'Shall I ask the practice to help with that preparation barrier?', text); return }
      if (answer === 'yes') await runWrite(p, 'create_task', { title: 'Help with preparation exercise barrier', reason: c.barrierTask }, 'physio')
      c.barrierTask = undefined
    } else if (/transport|travel|carer|interpreter/i.test(text)) { c.barrierTask = text; await say(p, 'The practice can help with that preparation barrier. Shall I ask them to contact you?', text); return }
    await offerSlots(p, 'The practice can help with your preparation. '); return
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
      settle('transport', 'done', 'Journey and first-night support confirmed or practice help agreed'); c.stage = 'finished'
      await say(p, 'Thank you. Your preparation answers are recorded. We will contact you when your blood tests and heart tracing results are back.', text)
    } else if (!c.supportTask && !p.modifiers.some(m => ['transport_flag', 'carer_flag', 'interpreter_flag'].includes(m))) { c.supportTask = true; await say(p, 'The practice can help arrange transport and support. Shall I ask them to contact you?', text) }
    else { c.stage = 'finished'; await say(p, 'I will leave that support request unarranged. Please contact the practice when you would like help.', text) }
  }
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
              conversation(patient).pendingEvent = classification
              await staffAction(patient, classification, item)
              if (classification.code === 'bloods_low_hb') await runWrite(patient, 'order_test', { panelId: 'fbc', clinicalDetails: 'Repeat FBC with ferritin and iron studies; GP review', priority: 'routine', collection: 'next-round' }, 'bloods')
              await deliver(patientId, classification.patientExplanation, classification.patientExplanation)
              conversation(patient).pendingEvent = undefined
            }
            if (state.step === 4) for (const p of Object.values(getState().patients)) if (p.status === 'done') await deliver(p.patientId, CLOSING)
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
