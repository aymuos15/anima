import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, detectRedFlag, type OutcomeCode } from '../preop/rules.js'
import type { PatientRun } from '../preop/store.js'

const patient = { modifiers: [] } as unknown as PatientRun
const rows = [
  ['bloods_normal', 'normal', 'done', []],
  ['bloods_low_hb', 'action', 'review', ['order_test', 'create_task']],
  ['bloods_high_k', 'urgent', 'review', ['create_task']],
  ['ecg_normal', 'normal', 'done', []],
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
  assert.equal(classify('bloods_low_hb', patient).patientExplanation, 'Your blood count is a little lower than we would like before an operation. This is common and usually treatable. We will repeat the test with an iron check and your GP will look at the result. Your operation date has not changed.')
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
