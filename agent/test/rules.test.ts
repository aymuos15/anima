import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, detectRedFlag, type OutcomeCode } from '../preop/rules.js'
import type { PatientRun } from '../preop/store.js'

const patient = { modifiers: [] } as unknown as PatientRun
const rows = [
  ['bloods_normal', 'normal', 'done', []],
  ['bloods_low_hb', 'action', 'review', ['create_task']],
  ['bloods_high_k', 'urgent', 'review', ['create_task']],
  ['ecg_normal', 'normal', 'pending', []],
  ['ecg_new_af', 'action', 'review', ['create_task']],
  ['physio_done', 'normal', 'done', []],
  ['physio_not_started', 'action', 'pending', ['create_task']],
  ['anaesthetic_clear', 'normal', 'done', []],
  ['red_flag_raised', 'urgent', 'review', ['create_task']],
] as const
for (const [code, severity, itemState, actions] of rows) {
  test(`${code} has deterministic classification and allowed writes`, () => {
    const result = classify(code, patient)
    assert.equal(result.code, code)
    assert.equal(result.severity, severity)
    assert.equal(result.itemState, itemState)
    assert.deepEqual(result.allowedActions, actions)
    assert.ok(result.patientExplanation.split(/\s+/).length < 80)
  })
}
test('wording and conditional staff actions remain exact', () => {
  assert.equal(classify('bloods_low_hb', patient).patientExplanation, 'Has anyone spoken to you about your blood results yet?')
  assert.equal(classify('red_flag_raised', patient).patientExplanation, 'Thank you for telling me. I am not going to ask you anything else. A pre-op nurse will call you today. If it gets worse, or you have chest pain now, call 999.')
  assert.equal(classify('anaesthetic_clear', patient).patientExplanation, '')
  assert.equal(classify('physio_not_started', patient).staffAction, undefined)
  const renal = classify('bloods_high_k', { modifiers: ['renal_caution'] } as PatientRun)
  assert.equal(renal.staffAction?.owner, 'anaesthetist')
  assert.equal(renal.staffAction?.priority, 'urgent')
  assert.match(renal.staffAction!.title, /nurse.*today/)
  assert.equal(classify('bloods_high_k', patient).staffAction?.owner, 'preop_nurse')
  const changed = classify('bloods_high_k', patient)
  changed.allowedActions.push('order_test')
  assert.deepEqual(classify('bloods_high_k', patient).allowedActions, ['create_task'])
})
const phrases = ['chest pain', 'chest tightness', 'short of breath', 'breathless', "can't breathe", 'fever', 'temperature', 'bleeding', 'black stools', 'confused', 'confusion', 'collapsed', 'fainted', 'swollen leg', 'calf pain']
for (const phrase of phrases) test(`red flag: ${phrase}`, () => assert.ok(detectRedFlag(`I have ${phrase}`)))
test('negations do not flag; a positive symptom in the same reply still does', () => {
  for (const text of ['no chest pain', 'I have no chest pain or breathlessness', 'I am not breathless', 'I do not have fever', 'No, none of those', "I don't have chest pain", 'No chest pain or fever']) assert.equal(detectRedFlag(text), null, text)
  assert.ok(detectRedFlag('No chest pain but I have a fever'))
  assert.ok(detectRedFlag('No fever, but chest pain'))
})
test('affirmative is a red flag only in the pending anaesthetic question', () => {
  for (const text of ['yes', 'yeah', 'I do', 'a bit', 'sometimes', 'Yes, a little']) {
    assert.ok(detectRedFlag(text, 'anaesthetic_red_flag'), text)
    assert.equal(detectRedFlag(text), null)
  }
  for (const text of ['no', 'not at all', 'I do not', 'maybe', 'which appointment?', 'yes to the appointment, no symptoms']) assert.equal(detectRedFlag(text, 'anaesthetic_red_flag'), null, text)
})

test('negation stays scoped to the symptom and affirmative qualifiers remain positive', () => {
  for (const text of ['No fever, I have chest pain', 'I do not take medicines and have chest pain', 'No chest pain, I feel breathless', 'No fever and I have chest tightness']) assert.ok(detectRedFlag(text, 'anaesthetic_red_flag'), text)
  for (const text of ['Yes, not all the time', 'Yeah, sometimes', 'I do, but not every day']) assert.ok(detectRedFlag(text, 'anaesthetic_red_flag'), text)
  for (const text of ['No fever, no chest pain', 'I do not have chest pain', 'No chest pain or breathlessness', 'I am not feeling breathless', 'I have never fainted', 'I am not at all breathless', 'I have no chest pain, fever or breathlessness']) assert.equal(detectRedFlag(text, 'anaesthetic_red_flag'), null, text)
})

test('doctor-approved results check ECG completion without interpreting either tracing', () => {
  assert.equal(classify('bloods_normal', patient).patientExplanation, 'The results from your blood tests were all within the normal limits so nothing for us to do here.')
  for (const code of ['ecg_normal', 'ecg_new_af'] as const) {
    assert.equal(classify(code, patient).patientExplanation, 'Have you had your ECG?')
    assert.notEqual(classify(code, patient).itemState, 'done')
  }
  assert.ok(classify('ecg_new_af', patient).staffAction, 'flagged ECG still has clinician-only review')
  assert.doesNotMatch(classify('bloods_high_k', patient).patientExplanation, /24 hours/)
})

test('being confused about an instruction is a clarification, while clinical confusion remains urgent', () => {
  for (const text of ["I'm confused—why do I need this visit?", 'I am confused about this appointment', "I'm confused, what are these blood tests for?"]) assert.equal(detectRedFlag(text), null, text)
  for (const text of ['I am confused', 'I feel confused', 'I am suddenly confused about this appointment', 'I feel confused, why do I need this visit?', "I'm confused—why do I need this visit? I have chest pain", "I'm confused about this appointment but I have a fever"]) assert.ok(detectRedFlag(text), text)
})

test('explicit symptom definitions are informational while surrounding reports still escalate', () => {
  for (const text of ['What do you mean by fever?', 'What does breathlessness mean?', 'Can you define chest pain?', 'What is confusion?', 'What is "fever"?']) assert.equal(detectRedFlag(text), null, text)
  for (const text of ['What is fever? I have chest pain now', 'I have chest pain. What do you mean by fever?', 'Why do you ask? I have chest pain right now', 'Do I have a fever?', 'What is fever? I have it now', 'What does fever mean? I have a fever']) assert.ok(detectRedFlag(text), text)
  assert.ok(detectRedFlag('yes', 'anaesthetic_red_flag'))
})
