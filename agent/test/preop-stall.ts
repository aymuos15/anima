import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { sim, type Patient } from '../sim.js'
const mock = process.argv.includes('--mock'), writes: any[] = [], file = new URL('../demo-state.json', import.meta.url)
const prior = mock && existsSync(file) ? readFileSync(file) : undefined
let exitCode = 0
if (mock) {
  const { getAppointmentSessions } = await import('../tools/read.js')
  const clock = sim.clock, get = sim.get
  const start = 1789200900000, minute = 60000
  // Captured live collision: r-3665 occupies Dr Maya Shah at 08:15 without sessionId.
  const appointment = { id: 'r-3665', kind: 'appointment', title: 'Practice follow-up', status: 'booked', patientId: 'SIM-000001', createdAt: 1789200000000, data: { mode: 'in-person', startsAt: start, clinician: 'Dr Maya Shah', durationMinutes: 15, capacityReserved: false } }
  const sessions = ['AM', 'PM'].map((period, i) => ({ id: `session-${period}`, kind: 'appointment-session', title: `Main surgery · ${period}`, status: 'open', version: 1, createdAt: 1789200000000, data: { mode: 'in-person', clinician: 'Dr Maya Shah', startsAt: start + i * 285 * minute, endsAt: start + (i * 285 + 60) * minute, slotMinutes: 15, blockedSlots: [] } }))
  try {
    sim.clock = async () => ({ now: 1789200000000, paused: true })
    const cases = [
      { label: 'captured booking without sessionId blocks same clinician', data: appointment.data, status: 'booked', want: start + 15 * minute },
      { label: 'appointment starting earlier overlaps candidate', data: { ...appointment.data, startsAt: start - 5 * minute }, status: 'booked', want: start + 15 * minute },
      { label: 'appointment starting inside candidate blocks both overlapping slots', data: { ...appointment.data, startsAt: start + 5 * minute }, status: 'booked', want: start + 30 * minute },
      { label: 'adjacent earlier appointment leaves candidate free', data: { ...appointment.data, startsAt: start - 15 * minute }, status: 'booked', want: start },
      { label: 'other clinician leaves candidate free', data: { ...appointment.data, clinician: 'Nurse Alex Morgan' }, status: 'booked', want: start },
      { label: 'same session blocks even without clinician', data: { startsAt: start, durationMinutes: 15, sessionId: 'session-AM' }, status: 'booked', want: start + 15 * minute },
      { label: 'cancelled appointment frees candidate', data: appointment.data, status: 'cancelled', want: start },
      { label: 'completed appointment remains occupied diary history', data: appointment.data, status: 'completed', want: start + 15 * minute },
    ]
    for (const c of cases) {
      sim.get = async () => ({ sessions, appointments: [{ ...appointment, data: c.data, status: c.status }] })
      const slots = await getAppointmentSessions()
      assert.equal(slots[0].startsAt, c.want, c.label)
      assert.deepEqual(slots.map(s => s.period), ['AM', 'PM'], 'retain both real periods')
    }
    sim.get = async () => ({ sessions, appointments: [{ ...appointment, data: { ...appointment.data, startsAt: start + 40 * minute } }] })
    assert.deepEqual((await getAppointmentSessions(true)).map(s => s.startsAt), [start + 15 * minute, start + 330 * minute], 'late preference selects latest non-overlapping real slot in each period')
  } finally { sim.clock = clock; sim.get = get }
  console.log('appointment availability regressions passed')
}
if (mock) {
  process.env.PREOP_MODEL_OFF = '1'; process.env.PORT = '8791'
  const now = Date.UTC(2026, 8, 12, 7), resources: any[] = []
  const people: Patient[] = ['PLAIN', 'MODIFIED'].map((id, i) => ({ id: `HARNESS-${id}`, name: `Harness ${id}`, birthDate: '1970-01-01', conditions: ['Awaiting elective surgery', ...(i ? ['diabetes', 'CKD'] : [])], needs: i ? ['Transport'] : [], goals: [], localIds: {} }))
  sim.clock = async () => ({ now, paused: true })
  sim.patients = async q => ({ total: 2, items: q.startsWith('HARNESS-') ? people.filter(p => p.id === q) : people })
  sim.view = async (_site, patient) => ({ now, resources: [{ id: 'surgery-' + patient, patientId: patient, kind: 'surgery', title: 'Elective joint surgery', status: 'booked', createdAt: now, dueAt: now + 28 * 86400000 }, ...resources.filter(r => r.patientId === patient)] })
  sim.get = async () => ({ appointments: resources.filter(r => r.kind === 'appointment'), sessions: ['AM', 'PM'].map((period, i) => ({ id: `session-${period}`, title: `Practice nurse ${period}`, status: 'open', version: 1, data: { mode: 'in-person', startsAt: now + (i ? 7 : 2) * 3600000, endsAt: now + (i ? 9 : 4) * 3600000, slotMinutes: 15 } })) })
  sim.action = async (_site, action) => { writes.push(action); const r = { ...action, id: `written-${writes.length}`, kind: action.type === 'book_appointment' ? 'appointment' : action.type === 'order_test' ? 'blood-test-order' : action.type === 'save_problem' ? 'problem' : 'task', owner: 'gp', data: action, createdAt: now }; resources.push(r); return { resource: r } }
  sim.advance = async minutes => { writes.push({ type: 'clock', minutes }); return {} }
  sim.setKey = () => {}
  sim.newWorld = async () => ({ apiKey: 'harness-key' })
  const { resetState } = await import('../preop/store.js'); resetState('harness', [])
  await import('../server.js')
}
const base = process.env.PREOP_BASE ?? `http://127.0.0.1:${mock ? 8791 : 8790}`
async function api(path: string, body?: unknown) { const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const out = await r.json() as any; assert.equal(r.status, 200, JSON.stringify(out)); return out }
try {
  const { classify } = await import('../preop/rules.js'), { assertAllowed } = await import('../imessage.js'), { lintOutbound, conversation } = await import('../preop/agent.js')
  const board = await api('/api/board'), plain = board.rows.find((p: any) => !p.transcript.length && !p.modifiers.length) ?? board.rows.find((p: any) => !p.transcript.length)
  const modified = board.rows.find((p: any) => !p.transcript.length && p.patientId !== plain.patientId && p.modifiers.includes('add_hba1c')) ?? board.rows.find((p: any) => !p.transcript.length && p.patientId !== plain.patientId)
  assert.ok(plain && modified, 'two unstarted patients required')
  const reply = (patientId: string, text: string) => api('/api/demo/reply', { patientId, text })
  await api('/api/demo/start', { patientId: plain.patientId }); let state = await reply(plain.patientId, 'yes'); assert.match(state.patients[plain.patientId].transcript.at(-1).text, /How are you getting on/); state = await reply(plain.patientId, 'Going well every day')
  const bloods = (s: any) => s.patients[plain.patientId].checklist.find((i: any) => i.id === 'bloods')
  const count = bloods(state).simRefs.length; state = await reply(plain.patientId, 'perhaps'); assert.equal(bloods(state).simRefs.length, count)
  for (const text of ['1', 'I take paracetamol', 'No allergies or previous problems', 'no', 'yes']) state = await reply(plain.patientId, text)
  const run = state.patients[plain.patientId]; assert.equal(run.checklist.filter((i: any) => i.state === 'done').length, 3); assert.ok(bloods(state).simRefs.some((r: any) => r.kind === 'appointment'))
  const beforeStep = run.transcript.length
  state = await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_normal', ecg: 'ecg_normal', physio: 'physio_done' } }); assert.equal(state.patients[plain.patientId].checklist.find((i: any) => i.id === 'ecg').state, 'pending')
  const eventTexts = state.patients[plain.patientId].transcript.slice(beforeStep).filter((x: any) => x.from === 'agent').map((x: any) => x.text)
  assert.deepEqual(eventTexts.slice(-2), [classify('bloods_normal', run).patientExplanation, classify('ecg_normal', run).patientExplanation])
  state = await reply(plain.patientId, 'yes'); assert.equal(state.patients[plain.patientId].status, 'ready'); assert.match(state.patients[plain.patientId].transcript.at(-1).text, /drinks/)
  for (const text of ['no', 'yes', 'no']) state = await reply(plain.patientId, text)
  assert.equal(conversation(state.patients[plain.patientId]).stage, 'finished')
  await api('/api/demo/start', { patientId: modified.patientId }); for (const text of ['yes', 'Going well', '2', 'No medicines', 'No allergies']) await reply(modified.patientId, text)
  let historyBefore: unknown
  if (mock) {
    const { app } = await import('../app.js')
    const pending = await app.sessions.get((await api('/api/demo/state')).patients[modified.patientId].sessionId)
    pending!.input.message('BEFORE_REWIND_BOUNDARY'); await app.sessions.commit(pending!)
    historyBefore = JSON.stringify((await app.sessions.get(pending!.id))!.events)
    const countBefore = (await api('/api/demo/state')).patients[modified.patientId].transcript.length
    const stepped = await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_normal', ecg: 'ecg_normal' } })
    assert.equal(stepped.patients[modified.patientId].transcript.length, countBefore, 'results never stack another question over an unanswered anaesthetic question')
    const future = await app.sessions.get(pending!.id)
    future!.input.message('FUTURE_HISTORY_MUST_DISAPPEAR'); future!.state.update({ daysToSurgery: 0 }); await app.sessions.commit(future!)
  }
  const beforeFlag = writes.length; state = await reply(modified.patientId, 'yes'); assert.equal(state.patients[modified.patientId].status, 'clinical_review')
  const safety = classify('red_flag_raised', state.patients[modified.patientId]).patientExplanation; assert.equal(state.patients[modified.patientId].transcript.at(-1).text, safety)
  const afterFlag = state.patients[modified.patientId].transcript.length; state = await reply(modified.patientId, 'Can we continue?'); assert.equal(state.patients[modified.patientId].transcript.length, afterFlag + 1)
  if (mock) { assert.deepEqual(writes.slice(beforeFlag).map(w => w.type), ['create_task']); assert.deepEqual(writes.filter(w => w.type === 'order_test' && w.patientId === modified.patientId).map(w => w.bloodTestOrder.panelId), ['fbc', 'ue', 'hba1c']) }
  if (mock) {
    const { app } = await import('../app.js')
    state = await api('/api/demo/step', { direction: -1 })
    const restored = state.patients[modified.patientId]
    assert.equal(conversation(restored).escalated, false)
    assert.equal(conversation(restored).stage, 'red_flag')
    assert.equal(conversation(restored).pendingQuestion, 'anaesthetic_red_flag')
    const restoredSession = await app.sessions.get(restored.sessionId)
    assert.equal(JSON.stringify(restoredSession!.events), historyBefore, 'ADK history rewinds exactly')
    assert.equal(restoredSession!.state.daysToSurgery, 21)
    state = await reply(modified.patientId, 'no')
    assert.equal(conversation(state.patients[modified.patientId]).stage, 'transport', 'restored conversation continues')
    const refreshed = await app.sessions.get(restored.sessionId)
    assert.equal(refreshed!.state.checklist.find((i: any) => i.id === 'anaesthetic_questions').state, 'done', 'typed ADK state refreshes on the later turn')
    assert.equal(refreshed!.state.daysToSurgery, 21)
    assert.ok(!JSON.stringify(refreshed!.events).includes('FUTURE_HISTORY_MUST_DISAPPEAR'))
  }
  assert.throws(() => assertAllowed('+19999999999'), /IMESSAGE_ALLOW/)
  for (const p of Object.values(state.patients) as any[]) for (const m of p.transcript) if (m.from === 'agent') lintOutbound(m.text)
  const finalBoard = await api('/api/board'); assert.equal(finalBoard.notReadyCount, finalBoard.cohortCount - finalBoard.rows.filter((p: any) => p.readiness === 1).length)
  if (mock) { const clockWrites = writes.filter(w => w.type === 'clock').length; await api('/api/demo/step', { direction: -1 }); assert.equal(writes.filter(w => w.type === 'clock').length, clockWrites); const reset = await api('/api/demo/reset', {}); assert.notEqual(reset.world, 'harness'); assert.equal(Object.keys(reset.patients).length, 2) }
  if (mock) {
    const { getState, resetState } = await import('../preop/store.js')
    const { loadCohort } = await import('../preop/cohort.js')
    const { conversations } = await import('../preop/agent.js')
    const { BLOODS_FOLLOWUP } = await import('../preop/rules.js')
    const last = (id: string) => getState().patients[id].transcript.filter(m => m.from === 'agent').at(-1)!.text
    const fresh = async (id: string) => { resetState('harness', await loadCohort()); conversations.clear(); await api('/api/demo/start', { patientId: id }) }
    const prepared = async (id: string) => { await fresh(id); for (const t of ['yes', 'Going well', '1', 'Paracetamol', 'No allergies', 'no', 'yes']) await reply(id, t) }
    await fresh(plain.patientId); await reply(plain.patientId, 'no')
    assert.match(last(plain.patientId), /help contacting your physiotherapy/)
    let before = writes.length; await reply(plain.patientId, 'perhaps'); assert.equal(writes.length, before)
    await reply(plain.patientId, 'yes'); assert.equal(writes.slice(before).filter(w => w.type === 'create_task').length, 1)
    assert.equal(getState().patients[plain.patientId].checklist.find(i => i.id === 'physio')!.state, 'pending')
    await fresh(plain.patientId); await reply(plain.patientId, 'yes'); await reply(plain.patientId, 'I need the leaflet')
    before = writes.length; await reply(plain.patientId, 'yes'); assert.equal(writes.length, before)
    assert.ok(getState().patients[plain.patientId].transcript.some(m => m.text.includes('https://www.medway.nhs.uk/')))
    await prepared(plain.patientId)
    before = writes.length
    state = await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_low_hb', ecg: 'ecg_new_af' } })
    assert.equal(last(plain.patientId), 'Has anyone spoken to you about your blood results yet?')
    assert.ok(!getState().patients[plain.patientId].transcript.some(m => m.text === BLOODS_FOLLOWUP))
    assert.equal(writes.slice(before).filter(w => w.type === 'order_test').length, 0, 'routine abnormal results never auto-order tests')
    state = await reply(plain.patientId, 'no')
    assert.deepEqual(state.patients[plain.patientId].transcript.slice(-2).map((m: any) => m.text), [BLOODS_FOLLOWUP, 'Have you had your ECG?'])
    state = await reply(plain.patientId, 'yes'); assert.equal(state.patients[plain.patientId].checklist.find((i: any) => i.id === 'ecg').state, 'review', 'completion cannot clear flagged tracing')
    assert.ok(!state.patients[plain.patientId].transcript.some((m: any) => /irregular rhythm|tracing is normal/i.test(m.text)))
    for (const t of ['My surgical team recommended protein shakes', 'yes', 'I do not know when', 'no', 'yes', 'no']) state = await reply(plain.patientId, t)
    assert.ok(state.patients[plain.patientId].transcript.some((m: any) => /personal fasting instructions/.test(m.text)))
    assert.ok(writes.some(w => w.type === 'create_task' && w.title === 'Confirm hospital arrival details'))
    await prepared(plain.patientId)
    await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_low_hb', ecg: 'ecg_normal' } })
    await reply(plain.patientId, 'yes')
    assert.ok(!getState().patients[plain.patientId].transcript.some(m => m.text === BLOODS_FOLLOWUP), 'prior contact skips the conditional 24h copy')
    await prepared(plain.patientId)
    await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_normal', ecg: 'ecg_new_af' } })
    await reply(plain.patientId, 'no')
    assert.equal(getState().patients[plain.patientId].checklist.find(i => i.id === 'ecg')!.state, 'review', 'denying completion cannot clear flagged ECG review')
    await reply(plain.patientId, 'Do I need protein shakes?')
    assert.match(last(plain.patientId), /Have they given you a personal drinks plan/)
    assert.doesNotMatch(last(plain.patientId), /received the protein shakes/)
    for (const mention of ['My friend suggested protein shakes', 'I bought protein shakes myself', 'Protein shakes were recommended', 'My friend recommended protein shakes and I have not asked my surgical team', 'My gym team recommended protein shakes', 'My surgical team did not recommend protein shakes']) {
      await prepared(plain.patientId)
      await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_normal', ecg: 'ecg_normal' } })
      await reply(plain.patientId, 'yes')
      const start = getState().patients[plain.patientId].transcript.length
      await reply(plain.patientId, mention)
      assert.doesNotMatch(last(plain.patientId), /received the protein shakes|drinks your surgical team recommended/, mention)
      if (!mention.includes('did not')) { assert.equal(conversation(getState().patients[plain.patientId]).stage, 'nutrition'); await reply(plain.patientId, 'no') }
      assert.ok(!getState().patients[plain.patientId].transcript.slice(start).some(m => /obtain the recommended drinks/.test(m.text)), mention)
    }
    await prepared(modified.patientId)
    await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_normal', ecg: 'ecg_normal' } })
    for (const t of ['yes', 'My surgical team recommended protein shakes', 'yes']) await reply(modified.patientId, t)
    assert.match(last(modified.patientId), /diabetes and kidney disease/)
    assert.match(last(modified.patientId), /fasting plan/)
    await prepared(plain.patientId)
    await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_normal', ecg: 'ecg_normal' } })
    await reply(plain.patientId, 'yes'); await reply(plain.patientId, 'My surgical team gave me preop protein drinks')
    assert.match(last(plain.patientId), /carbohydrate rather than protein/)
    assert.match(last(plain.patientId), /name on yours/)
    await reply(plain.patientId, 'preOp'); await reply(plain.patientId, 'yes'); await reply(plain.patientId, 'I do not know')
    assert.match(last(plain.patientId), /personal fasting instructions/)
    await prepared(plain.patientId)
    before = writes.length
    await api('/api/demo/step', { direction: 1, outcomes: { bloods: 'bloods_high_k', ecg: 'ecg_new_af' } })
    assert.ok(conversation(getState().patients[plain.patientId]).escalated)
    assert.equal(last(plain.patientId), classify('bloods_high_k', getState().patients[plain.patientId]).patientExplanation)
    const after = writes.length, messages = getState().patients[plain.patientId].transcript.filter(m => m.from === 'agent').length
    await reply(plain.patientId, 'yes'); await api('/api/demo/step', { direction: 1 })
    assert.equal(writes.filter(w => w.type !== 'clock').length, writes.slice(0, after).filter(w => w.type !== 'clock').length)
    assert.equal(getState().patients[plain.patientId].transcript.filter(m => m.from === 'agent').length, messages)
    resetState('harness', await loadCohort()); conversations.clear()
  }
  if (mock) {
    const { app } = await import('../app.js')
    const { renderConversation } = await import('../preop/agent.js')
    const { getState } = await import('../preop/store.js')
    const p = getState().patients[plain.patientId]
    const examples = [
      ['Paracetamol', 'Do you have any allergies or have you had problems with a previous anaesthetic?', 'Thanks. Any allergies or problems with an anaesthetic?'],
      ['perhaps', 'Shall I ask the practice to help with that preparation barrier?', 'Would you like the practice to call you?'],
      ['yes', 'Has your surgical team given you any drinks to take before your operation?', 'Your ECG is normal. Has your surgical team given you any drinks to take before your operation?'],
    ]
    process.env.PREOP_MODEL_OFF = '0'
    try {
      for (const [inbound, canonical, rejected] of examples) {
        let calls = 0
        const replyTurn = async (input: any) => { calls++; return { sessionId: input.sessionId, status: 'completed', output: { text: rejected }, yieldedTools: [] } }
        assert.equal(await renderConversation(p, canonical, inbound, replyTurn as any), canonical)
        assert.equal(calls, 1, 'invalid model wording never triggers a model retry')
      }
      const canonical = examples[0][1], valid = 'Thank you. ' + canonical
      assert.equal(await renderConversation(p, canonical, 'Paracetamol', (async (input: any) => ({ sessionId: input.sessionId, status: 'completed', output: { text: valid }, yieldedTools: [] })) as any), valid, 'valid ordinary ADK output is retained')
    } finally { process.env.PREOP_MODEL_OFF = '1' }
    await api('/api/demo/start', { patientId: plain.patientId })
    const before = structuredClone(conversation(getState().patients[plain.patientId]))
    const agentCount = getState().patients[plain.patientId].transcript.filter(m => m.from === 'agent').length
    const commit = app.sessions.commit
    app.sessions.commit = async () => { throw new Error('Injected session commit failure') }
    try {
      const failed = await fetch(base + '/api/demo/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patientId: plain.patientId, text: 'yes' }) })
      assert.equal(failed.status, 500)
      assert.deepEqual(conversation(getState().patients[plain.patientId]), before, 'failed delivery rolls back stage and turn count')
      assert.equal(getState().patients[plain.patientId].transcript.filter(m => m.from === 'agent').length, agentCount)
    } finally { app.sessions.commit = commit }
    const action = sim.action
    sim.action = async () => { throw new Error('Injected urgent task API failure') }
    try {
      const failed = await fetch(base + '/api/demo/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patientId: plain.patientId, text: 'I have chest pain' }) })
      assert.equal(failed.status, 500)
      assert.ok(conversation(getState().patients[plain.patientId]).escalated, 'task failure must never undo clinical escalation')
      assert.equal(getState().patients[plain.patientId].transcript.at(-1)!.text, classify('red_flag_raised', getState().patients[plain.patientId]).patientExplanation)
      const count = getState().patients[plain.patientId].transcript.filter(m => m.from === 'agent').length
      await reply(plain.patientId, 'Can we continue?')
      assert.equal(getState().patients[plain.patientId].transcript.filter(m => m.from === 'agent').length, count)
    } finally { sim.action = action }
  }
  const evidence = { gates: { ambiguousNoWrite: true, appointmentAndOrders: true, fiveDoneReady: true, exactEvents: true, affirmativeContextEscalation: true, modelOff: mock, noLaterQuestion: true, whitelist: true, boardCounts: true, rewindAndReset: mock, restoredADKHistory: mock, restoredPendingQuestion: mock, refreshedTypedState: mock, modelQuestionFallback: mock, validModelOutputRetained: mock, failedDeliveryRollback: mock, failedTaskKeepsEscalation: mock }, transport: 'console', patientIds: [plain.patientId, modified.patientId], golden: { eventTexts, safety }, writes }
  writeFileSync('/tmp/preop-stall-evidence.json', JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence.gates))
} catch (error) { exitCode = 1; console.error(error) }
finally { if (mock) { if (prior) writeFileSync(file, prior); else if (existsSync(file)) unlinkSync(file); process.exit(exitCode) } else process.exitCode = exitCode }
