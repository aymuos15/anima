import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { deriveStatus, readiness, resetState, saveState, savePatient, getState, type PatientRun } from '../preop/store.js'

const makePatient = (): PatientRun => ({ patientId: 'fixture', name: 'Fixture Patient', procedureLabel: 'Hip surgery', surgeryDate: '2026-10-10', modifiers: [], needs: [], conditions: [], status: 'not_contacted', checklist: ['physio', 'bloods', 'ecg', 'anaesthetic_questions', 'transport'].map(id => ({ id: id as PatientRun['checklist'][number]['id'], label: id, state: 'not_started', simRefs: [], updatedAtStep: 0 })), results: [], transcript: [] })

test('readiness is done / five and status follows every specified precedence', () => {
  const p = makePatient()
  assert.equal(deriveStatus(p, 0), 'not_contacted')
  for (let i = 0; i <= 5; i++) {
    assert.equal(readiness(p), i / 5)
    if (i < 5) p.checklist[i].state = 'done'
  }
  assert.equal(deriveStatus(p, 3), 'ready')
  assert.equal(deriveStatus(p, 4), 'done')
  p.checklist[0].state = 'review'
  assert.equal(deriveStatus(p, 4), 'clinical_review')
  p.checklist[0].state = 'pending'
  p.transcript.push({ at: 1, from: 'agent', text: 'Hello' })
  assert.equal(deriveStatus(p, 0), 'in_progress')
  p.checklist[1].state = 'review'
  assert.equal(deriveStatus(p, 0), 'clinical_review')
})
test('store returns detached snapshots, derives saved patient status, and restores state exactly', t => {
  t.mock.method(fs, 'writeFileSync', () => {})
  const original = resetState('fixture-world', [makePatient()])
  assert.equal(original.step, 0)
  assert.deepEqual(original.snapshots, [])
  const detached = getState()
  detached.patients.fixture.name = 'Mutated'
  assert.equal(getState().patients.fixture.name, 'Fixture Patient')
  const p = getState().patients.fixture
  p.transcript.push({ at: 2, from: 'patient', text: 'Yes' })
  assert.equal(savePatient(p).status, 'in_progress')
  assert.equal(getState().patients.fixture.status, 'in_progress')
  saveState(original)
  assert.deepEqual(getState(), original)
  assert.notEqual(resetState('new-world', []).runId, original.runId)
})
