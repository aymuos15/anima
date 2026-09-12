import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearSymptomDenial, supportAgreement } from '../preop/answers.js'
import type { Conversation } from '../preop/agent.js'
import type { PatientRun } from '../preop/store.js'
test('detailed symptom denials are accepted without accepting uncertain or unrelated no answers', () => {
  for (const answer of ['No, I have not had any of those symptoms', "No, I haven't had any chest pain or fever", 'No, none of those']) assert.ok(clearSymptomDenial(answer), answer)
  for (const answer of ['No, maybe sometimes', 'No, I think not', 'No to the appointment', 'No, not anymore', 'No, I do not want to answer', 'No, I had those last week', 'No, I have symptoms']) assert.equal(clearSymptomDenial(answer), false, answer)
})
test('natural support agreement requires affirmative consent for the actual requested help', () => {
  const c = { stage: 'transport' } as Conversation, patient = { modifiers: ['carer_flag'] } as PatientRun
  assert.ok(supportAgreement('Yes, please include my carer', c, patient))
  for (const answer of ['No, please do not include my carer', 'Yes, but not my carer', 'Yes, if my carer agrees', 'Yes, maybe include my carer', 'Can you include my carer?']) assert.equal(supportAgreement(answer, c, patient), false, answer)
  assert.equal(supportAgreement('Yes, please include my carer', c, { modifiers: ['carer_flag', 'transport_flag'] } as PatientRun), false)
})
