// Nine real ADK conversation scenarios with captured simulator writes; no external patient sends.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { sim, type Patient } from '../sim.js'
process.env.PORT = '8792'; process.env.PREOP_MODEL_OFF = '0'
const file = new URL('../demo-state.json', import.meta.url), prior = existsSync(file) ? readFileSync(file) : undefined
const writes: any[] = [], resources: any[] = [], now = Date.UTC(2026, 8, 12, 7)
let active = 0, modelTurns = 0, successfulModelResponses = 0
const turnEvidence: any[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init: any) => { const model = String(input instanceof Request ? input.url : input).includes('/responses'); if (model) modelTurns++; const response = await originalFetch(input, init); if (model && response.ok) successfulModelResponses++; return response }) as typeof fetch
const people: Patient[] = Array.from({ length: 9 }, (_, i) => ({ id: `EVAL-${i + 1}`, name: `Eval Patient${i + 1}`, birthDate: '1970-01-01', conditions: ['Awaiting elective surgery', ...(i === 8 ? ['Diabetes'] : [])], needs: i === 8 ? ['Transport'] : [], goals: [], localIds: {} }))
sim.clock = async () => ({ now, paused: true })
sim.patients = async q => ({ total: people.length, items: q.startsWith('EVAL-') ? people.filter(p => p.id === q) : people })
sim.view = async (_site, patient) => ({ now, resources: [{ id: 'surgery-' + patient, patientId: patient, kind: patient === 'EVAL-9' ? 'theatre-slot' : 'surgery', title: 'Elective knee surgery', status: patient === 'EVAL-9' ? 'waiting' : 'booked', createdAt: now, dueAt: now + 28 * 86400000 }, ...resources.filter(r => r.patientId === patient)] })
sim.get = async () => ({ appointments: resources.filter(r => r.kind === 'appointment'), sessions: ['AM', 'PM'].map((period, i) => ({ id: `session-${active}-${period}`, title: `Practice nurse ${period}`, status: 'open', version: 1, data: { mode: 'in-person', startsAt: now + (i ? 7 : 2) * 3600000, endsAt: now + (i ? 9 : 4) * 3600000, slotMinutes: 15 } })) })
sim.action = async (site, action) => { const evidence = { ...action, site, returnedResource: undefined as any }; writes.push(evidence); const r = { ...action, id: `written-${writes.length}`, kind: action.type === 'book_appointment' ? 'appointment' : action.type === 'order_test' ? 'blood-test-order' : action.type === 'save_problem' ? 'problem' : 'task', owner: 'gp', data: action, createdAt: now }; resources.push(r); evidence.returnedResource = r; return { resource: r } }
sim.advance = async () => ({})
const { resetState, getState, savePatient, readiness } = await import('../preop/store.js')
const { loadCohort } = await import('../preop/cohort.js')
const { classify } = await import('../preop/rules.js')
const { conversations, conversation, lintOutbound, PICKUP, CLOSING } = await import('../preop/agent.js')
resetState('eval', await loadCohort()); await import('../server.js')
async function api(path: string, body: unknown, allowed: string[] = []) {
  const beforeWrites = writes.length, beforeTranscript = getState().patients[`EVAL-${active}`]?.transcript.length ?? 0
  let error: unknown
  try {
    const r = await fetch('http://127.0.0.1:8792'+path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const out = await r.json() as any; assert.equal(r.status, 200, JSON.stringify(out)); return out
  } catch (e) { error = e; throw e }
  finally {
    const outbound = (getState().patients[`EVAL-${active}`]?.transcript.slice(beforeTranscript) ?? []).filter(m => m.from === 'agent')
    const actual = writes.slice(beforeWrites), failures: string[] = []
    for (const m of outbound) try { lintOutbound(m.text) } catch (e) { failures.push(String(e)) }
    for (const w of actual) if (!allowed.includes(w.type)) failures.push(`Disallowed write ${w.type}; allowed: ${allowed.join(', ') || 'none'}`)
    turnEvidence.push({ scenario: active, path, body, allowedWrites: allowed, outbound, writes: actual, failures, error: error && String(error) })
    if (!error) assert.deepEqual(failures, [], 'Every turn must pass wording and write allowlist gates')
  }
}
const reply = (text: string, allowed: string[] = []) => api('/api/demo/reply', { patientId: `EVAL-${active}`, text }, allowed)
const run = () => getState().patients[`EVAL-${active}`]
const last = () => run().transcript.filter(m => m.from === 'agent').at(-1)!.text
const results: any[] = []
async function scenario(number: number, name: string, fn: () => Promise<void>) {
  active = number; const beforeWrites = writes.length, beforeModels = modelTurns, beforeSuccess = successfulModelResponses, beforeTurns = turnEvidence.length
  try {
    resetState(`eval-${number}`, await loadCohort()); conversations.clear()
    await api('/api/demo/start', { patientId: `EVAL-${active}` }, ['save_problem']); assert.ok(run().sessionId, 'persisted ADK session required')
    await fn()
    for (const m of run().transcript) if (m.from === 'agent') lintOutbound(m.text)
    assert.ok(successfulModelResponses > beforeSuccess, 'scenario requires successful actual model response')
    results.push({ number, name, pass: true, modelAttempts: modelTurns-beforeModels, successfulModelResponses: successfulModelResponses-beforeSuccess, turns: turnEvidence.slice(beforeTurns), sessionId: run().sessionId, transcript: run().transcript, writes: writes.slice(beforeWrites) }); console.log(`PASS ${number} ${name}`)
  } catch(error) { results.push({ number, name, pass:false, modelAttempts:modelTurns-beforeModels, successfulModelResponses:successfulModelResponses-beforeSuccess, sessionId:run()?.sessionId, transcript:run()?.transcript ?? [], turns:turnEvidence.slice(beforeTurns), error:String(error), writes:writes.slice(beforeWrites) }); console.error(`FAIL ${number} ${name}: ${error}`) }
  writeFileSync('/tmp/preop-model-evals.json', JSON.stringify({ model: process.env.MODEL ?? 'gpt-5.6-luna', transport:'console', simulator:'captured fixture', modelCounterSemantics:'modelAttempts counts /responses fetch attempts; successfulModelResponses counts successful HTTP responses (scenario pass additionally requires parsed ADK output and session)', results }, null, 2))
}
try {
  await scenario(1, 'happy path actual conversation and approved writes', async () => {
    const before = writes.length
    await reply('yes'); assert.equal(writes.length, before, 'No writes before slot approval')
    await reply('perhaps'); assert.equal(writes.length, before, 'Ambiguous slot reply approves no writes')
    await reply('1', ['book_appointment','create_task','order_test'])
    for(const t of ['Paracetamol','No allergies','no','yes']) await reply(t)
    assert.equal(writes.filter(w=>w.patientId===run().patientId && w.type==='book_appointment').length,1)
    assert.deepEqual(writes.filter(w=>w.patientId===run().patientId && w.type==='order_test').map(w=>w.bloodTestOrder.panelId),['fbc','ue'])
    await api('/api/demo/step',{direction:1,outcomes:{bloods:'bloods_normal',ecg:'ecg_normal'}}); assert.equal(run().status,'ready')
    for(let n=0;n<3;n++) await api('/api/demo/step',{direction:1}); assert.equal(run().status,'done'); assert.equal(last(),CLOSING)
  })
  for (const [n,code,item] of [[2,'bloods_low_hb','bloods'],[3,'bloods_high_k','bloods'],[4,'ecg_new_af','ecg']] as const) await scenario(n,code,async()=>{
    const p=run(), checklist=p.checklist.find(i=>i.id===item)!;checklist.state='booked';checklist.dueStep=2;savePatient(p)
    await api('/api/demo/step',{direction:1,outcomes:{physio:'physio_done'}})
    const beforeReadiness=readiness(run()), surgeryDate=run().surgeryDate
    const before=writes.length;await api('/api/demo/step',{direction:1,outcomes:{[item]:code,physio:'physio_done'}},code==='bloods_low_hb'?['create_task','order_test']:['create_task'])
    const c=classify(code,p);assert.ok(run().transcript.some(m=>m.text===c.patientExplanation));assert.equal(run().status,'clinical_review')
    const eventWrites=writes.slice(before).filter(w=>w.patientId===p.patientId);assert.deepEqual(eventWrites.map(w=>w.type).sort(),(code==='bloods_low_hb'?['create_task','order_test']:['create_task']).sort());const task=eventWrites.find(w=>w.type==='create_task')!;assert.equal(task.site,'gp');assert.match(task.title,new RegExp('^'+c.staffAction!.priority.toUpperCase()+' · '+c.staffAction!.owner+': '));assert.equal(task.priority,undefined,'Unsupported Action.priority must not be sent');assert.equal(task.owner,undefined,'Unsupported Action.owner must not be sent');assert.equal(task.returnedResource.title,task.title);assert.ok(task.title.includes(c.staffAction!.title));assert.ok(task.returnedResource.id);assert.equal(getState().step,2);assert.equal(run().surgeryDate,surgeryDate)
    if(code==='bloods_high_k'){assert.equal(readiness(run()),beforeReadiness);assert.equal(run().checklist.find(i=>i.id==='bloods')!.state,'review');assert.ok(last().includes('call you today'))}
    if(code==='bloods_low_hb'){const order=eventWrites.find(w=>w.type==='order_test')!;assert.equal(order.bloodTestOrder.panelId,'fbc');assert.match(order.bloodTestOrder.clinicalDetails,/ferritin.*iron studies.*GP review/);assert.ok(last().includes('Your operation date has not changed.'))}
  })
  await scenario(5,'physio barrier requires explicit task consent',async()=>{
    await reply('no');assert.equal(last(),classify('physio_not_started',run()).patientExplanation)
    let before=writes.length;await reply('I have not got round to it');assert.equal(writes.length,before,'Nonfixable barrier creates no task')
    resetState('eval-5-positive',await loadCohort());conversations.clear()
    await api('/api/demo/start',{patientId:run().patientId},['save_problem']);await reply('no')
    assert.equal(last(),classify('physio_not_started',run()).patientExplanation)
    before=writes.length;await reply('I need transport');assert.equal(writes.length,before)
    await reply('perhaps');assert.equal(writes.length,before)
    await reply('yes',['create_task']);assert.equal(writes.slice(before).filter(w=>w.type==='create_task').length,1)
  })
  await scenario(6,'red flag stops actual persisted conversation',async()=>{
    await reply('yes');await reply('2',['book_appointment','create_task','order_test'])
    for(const t of ['No medicines','No allergies'])await reply(t)
    assert.equal(conversation(run()).pendingQuestion,'anaesthetic_red_flag')
    const before=writes.length;await reply('yes',['create_task'])
    assert.equal(last(),classify('red_flag_raised',run()).patientExplanation)
    assert.deepEqual(writes.slice(before).map(w=>w.type),['create_task']);assert.match(writes[before].returnedResource.title,/^URGENT · preop_nurse:/)
    const count=run().transcript.filter(m=>m.from==='agent').length, afterStop=writes.length
    await reply('Can we continue?');await reply('yes')
    await api('/api/demo/step',{direction:1,outcomes:{bloods:'bloods_low_hb',ecg:'ecg_new_af'}})
    assert.equal(writes.length,afterStop,'No writes after stop, including a later results event')
    assert.equal(run().transcript.filter(m=>m.from==='agent').length,count,'No later outbound or question')
  })
  await scenario(7,'declined slot offers distinct alternatives without booking',async()=>{await reply('yes');const first=conversation(run()).slots.map(s=>s.startsAt);const before=writes.length;await reply('no');assert.equal(writes.length,before);assert.equal(conversation(run()).slots.length,2,'Two nonempty alternatives required');assert.ok(conversation(run()).slots.every(s=>!first.includes(s.startsAt)));for(const slot of conversation(run()).slots)assert.ok(last().includes(slot.startsAtText),'Alternative times must appear in outbound')})
  await scenario(8,'deterministic ninth-message budget',async()=>{await reply('yes');for(let n=0;n<6;n++)await reply('perhaps');assert.equal(run().transcript.filter(m=>m.from==='agent').length,8);await reply('perhaps');assert.equal(run().transcript.filter(m=>m.from==='agent').length,9);assert.equal(last(),PICKUP);assert.ok(conversation(run()).paused)})
  await scenario(9,'diabetes transport and theatre block modify actual plan',async()=>{
    assert.deepEqual([...run().modifiers].sort(),['add_hba1c','theatre_blocked','transport_flag'])
    const first=last();assert.match(first,/(?:can|will|offer|ask).*practice.*(?:help|arrange).*transport/i);assert.match(first,/confirm/i)
    assert.ok(!/\?[^?]*transport|(?:need|want|have|is there).*transport[^?]*\?/i.test(first),'Recorded transport need must be offered, not asked again')
    await reply('yes');assert.match(last(),/HbA1c|blood sugar/i)
    await reply('1',['book_appointment','create_task','order_test'])
    assert.deepEqual(writes.filter(w=>w.patientId===run().patientId && w.type==='order_test').map(w=>w.bloodTestOrder.panelId),['fbc','ue','hba1c'])
    for(const text of ['Paracetamol','No allergies','no'])await reply(text)
    assert.match(last(),/Shall I|Would you like|May I/i);assert.ok(!/carer|interpreter/i.test(last()),'Untriggered modifiers must not be offered')
    const before=writes.length;await reply('perhaps');assert.equal(writes.length,before)
    await reply('yes',['create_task']);assert.deepEqual(writes.slice(before).map(w=>w.title),['Arrange transport home after surgery'])
    for(const m of run().transcript.filter(m=>m.from==='agent'))assert.ok(!/(?:operation|surgery|theatre).{0,35}(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}[ /-]\d{1,2}|\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December))/i.test(m.text),'Blocked theatre date must never be promised')
  })
} finally { if(prior)writeFileSync(file,prior);else if(existsSync(file))unlinkSync(file);process.exit(results.length===9 && results.every(r=>r.pass)?0:1) }
