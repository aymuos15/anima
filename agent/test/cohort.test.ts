import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { sim, type Patient, type Resource } from '../sim.js'
import { loadCohort, getFeaturedPatientIds, preparePatientRun } from '../preop/cohort.js'
const now = Date.UTC(2026, 8, 12)
const person = (id: string, conditions = ['Arthritis'], needs: string[] = []): Patient => ({ id, name: `Patient ${id}`, conditions, needs, goals: [], birthDate: '1960-01-01', localIds: {} })
function fixture(t: TestContext, patients: Patient[], events: Record<string, Partial<Resource>[]>) {
  const queries: string[] = []
  t.mock.method(sim, 'patients', async (q: string) => { queries.push(q); return { total: patients.length, items: patients.filter(p => !q.startsWith('id-') || p.id === q) } })
  t.mock.method(sim, 'view', async (site: string, patientId: string) => ({ now, resources: site === 'hospital' ? (events[patientId] ?? []).map((e, i) => ({ id: `${patientId}-${i}`, title: 'Recorded surgery', status: 'booked', kind: 'surgery', createdAt: now, patientId, ...e })) : [] }))
  t.mock.method(sim, 'clock', async () => ({ now, paused: true }))
  return queries
}
test('live search merges, filters pathways, fills featured preferences without duplicates, and derives record fields', async t => {
  const patients = [person('id-plain'), person('id-blocked'), person('id-need', ['Hip arthritis'], ['Transport']), person('id-diabetes', ['Knee arthritis', 'Diabetes']), person('id-no-event'), person('id-awaiting', ['Awaiting elective surgery']), person('id-unrelated', ['Asthma'])]
  const queries = fixture(t, patients, { 'id-plain': [{ kind: 'referral' }], 'id-blocked': [{ kind: 'theatre-slot', status: 'waiting' }], 'id-need': [{ dueAt: now + 10 * 86400000 }], 'id-diabetes': [{}], 'id-unrelated': [{}] })
  const cohort = await loadCohort()
  assert.deepEqual(queries.slice(0, 7), ['elective', 'surgery', 'arthritis', 'knee', 'hip', 'MSK', 'orthopaedic'])
  assert.deepEqual(cohort.map(p => p.patientId), ['id-plain', 'id-blocked', 'id-need', 'id-diabetes', 'id-awaiting'])
  assert.deepEqual(getFeaturedPatientIds(), ['id-blocked', 'id-need', 'id-diabetes', 'id-plain'])
  assert.equal(cohort.find(p => p.patientId === 'id-need')!.surgeryDate, '2026-09-22')
  assert.equal(cohort.find(p => p.patientId === 'id-awaiting')!.surgeryDate, '2026-10-10')
  assert.ok(cohort.every(p => p.checklist.length === 5 && p.transcript.length === 0 && p.status === 'not_contacted' && !p.phone && !p.sessionId))
  patients[2].needs.push('Interpreter')
  const refreshed = await preparePatientRun('id-need')
  assert.deepEqual(refreshed.modifiers, ['transport_flag', 'interpreter_flag'])
  assert.equal(refreshed.checklist[4].state, 'pending')
  assert.equal(refreshed.checklist[4].detail, 'transport need on record')
})
test('every modifier fires only on its own record trigger; fallback features all available', async t => {
  const p = person('id-all', ['Awaiting elective surgery', 'Diabetes', 'CKD'], ['Transport', 'Carer involvement', 'Interpreter', 'Shift work'])
  const plain = person('id-plain', ['Awaiting elective surgery'], ['Offline contact', 'SMS preferred'])
  fixture(t, [p, plain], { 'id-all': [{ status: 'waiting' }] })
  const cohort = await loadCohort()
  assert.deepEqual(cohort[0].modifiers, ['add_hba1c', 'renal_caution', 'transport_flag', 'carer_flag', 'interpreter_flag', 'slots_late', 'theatre_blocked'])
  assert.deepEqual(cohort[1].modifiers, [])
  assert.deepEqual(getFeaturedPatientIds(), ['id-all', 'id-plain'])
  const triggers: Array<[string[], string[], string]> = [[['Diabetes', 'Arthritis'], [], 'add_hba1c'], [['Kidney disease', 'Arthritis'], [], 'renal_caution'], [['Arthritis'], ['Transport'], 'transport_flag'], [['Arthritis'], ['Carer involvement'], 'carer_flag'], [['Arthritis'], ['Interpreter'], 'interpreter_flag'], [['Arthritis'], ['Shift work'], 'slots_late']]
  for (const [conditions, needs, modifier] of triggers) {
    plain.conditions = conditions; plain.needs = needs
    assert.deepEqual((await preparePatientRun('id-plain')).modifiers, [modifier])
  }
})
test('search pagination fills forty unique eligible candidates and stops at the cap', async t => {
  const patients = Array.from({ length: 45 }, (_, i) => person(`id-${i}`, ['Arthritis', 'Awaiting elective surgery']))
  fixture(t, patients, {})
  t.mock.method(sim, 'patients', async (q: string) => q.startsWith('id-') ? { total: 1, items: patients.filter(p => p.id === q) } : { total: q === 'arthritis' ? 86 : 0, items: q === 'arthritis' ? patients.slice(0, 30) : [] })
  const pages: string[] = []
  t.mock.method(sim, 'get', async (path: string) => { pages.push(path); return { total: 86, items: [patients[29], ...patients.slice(30)] } })
  const cohort = await loadCohort()
  assert.equal(cohort.length, 40)
  assert.deepEqual(cohort.map(p => p.patientId), patients.slice(0, 40).map(p => p.id))
  assert.deepEqual(pages, ['/api/sites/gp/patients?q=arthritis&offset=30'])
})
