import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resetState, getState, saveState, type PatientRun } from '../preop/store.js'
import { stepTimeline } from '../preop/timeline.js'
const patient = (): PatientRun => ({ patientId: 'fixture', name: 'Fixture', procedureLabel: 'Surgery', surgeryDate: '2026-10-10', modifiers: [], needs: [], conditions: [], status: 'in_progress', checklist: [
  { id: 'physio', label: 'Physio', state: 'pending', simRefs: [], updatedAtStep: 0 },
  { id: 'bloods', label: 'Bloods', state: 'booked', dueStep: 1, simRefs: [], updatedAtStep: 0 },
  { id: 'ecg', label: 'ECG', state: 'booked', dueStep: 2, simRefs: [], updatedAtStep: 0 },
  { id: 'anaesthetic_questions', label: 'Questions', state: 'not_started', simRefs: [], updatedAtStep: 0 },
  { id: 'transport', label: 'Transport', state: 'done', simRefs: [], updatedAtStep: 0 },
], transcript: [{ at: 1, from: 'agent', text: 'Hello' }], results: [] })

test('forward rolls due items only, snapshots deeply, advances once; rewind restores exactly and can branch', async t => {
  t.mock.method(fs, 'writeFileSync', () => {})
  const initial = resetState('test-world', [patient()])
  const calls: number[] = []
  const advance = async (n: number) => { calls.push(n) }
  const first = await stepTimeline(1, { bloods: 'bloods_normal', physio: 'physio_not_started' }, advance)
  assert.equal(first.state.step, 1)
  assert.equal(first.state.snapshots.length, 1)
  assert.deepEqual(first.state.snapshots[0].patients, initial.patients)
  assert.deepEqual(first.events.map(e => e.classification.code), ['physio_not_started', 'bloods_normal'])
  assert.equal(first.state.patients.fixture.checklist[2].state, 'booked')
  assert.deepEqual(calls, [10080])
  const rewound = await stepTimeline(-1, {}, advance)
  assert.deepEqual(rewound.state, initial)
  assert.deepEqual(rewound.events, [])
  assert.deepEqual(calls, [10080])
  const branch = await stepTimeline(1, { bloods: 'bloods_high_k', physio: 'physio_done' }, advance)
  assert.deepEqual(branch.events.map(e => e.classification.code), ['physio_done', 'bloods_high_k'])
  assert.equal(branch.state.patients.fixture.status, 'clinical_review')
  const second = await stepTimeline(1, { ecg: 'ecg_new_af' }, advance)
  assert.deepEqual(second.events.map(e => e.classification.code), ['ecg_new_af'])
  assert.deepEqual(calls, [10080, 10080, 10080])
})
test('timeline bounds do not mutate or advance; step four sets done', async t => {
  t.mock.method(fs, 'writeFileSync', () => {})
  resetState('test-world', [patient()])
  let calls = 0
  const advance = async () => { calls++ }
  const initial = getState()
  assert.deepEqual((await stepTimeline(-1, {}, advance)).state, initial)
  const state = getState()
  state.step = 3
  state.patients.fixture.checklist.forEach(item => { item.state = 'done' })
  saveState(state)
  const fourth = await stepTimeline(1, {}, advance)
  assert.equal(fourth.state.patients.fixture.status, 'done')
  assert.deepEqual((await stepTimeline(1, {}, advance)).state, fourth.state)
  assert.equal(calls, 1)
})
test('weighted rolls cover specified intervals and invalid picks never become another item result', async t => {
  t.mock.method(fs, 'writeFileSync', () => {})
  let random = 0
  t.mock.method(Math, 'random', () => random)
  for (const [value, bloods, physio] of [[0, 'bloods_normal', 'physio_done'], [0.55, 'bloods_low_hb', 'physio_done'], [0.9, 'bloods_high_k', 'physio_not_started']] as const) {
    random = value
    resetState('test-world', [patient()])
    const result = await stepTimeline(1, {}, async () => {})
    assert.deepEqual(result.events.map(e => e.classification.code), [physio, bloods])
  }
  resetState('test-world', [patient()])
  await assert.rejects(stepTimeline(1, { bloods: 'ecg_normal' }, async () => {}), /outcome/i)
})
test('clock failure leaves state unchanged and uncontacted cohort members are not rolled', async t => {
  t.mock.method(fs, 'writeFileSync', () => {})
  const p = patient()
  const untouched = { ...patient(), patientId: 'untouched', status: 'not_contacted' as const, transcript: [] }
  const initial = resetState('test-world', [p, untouched])
  await assert.rejects(stepTimeline(1, {}, async () => { throw new Error('offline') }), /offline/)
  assert.deepEqual(getState(), initial)
  const advanced = await stepTimeline(1, { physio: 'physio_done', bloods: 'bloods_normal' }, async () => {})
  assert.ok(advanced.events.every(event => event.patientId === 'fixture'))
  assert.deepEqual(advanced.state.patients.untouched, untouched)
})
