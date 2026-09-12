import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preparationClarification } from '../preop/clarifications.js'
import type { PatientRun } from '../preop/store.js'
import type { Conversation } from '../preop/agent.js'
const patient = { modifiers: [], checklist: [] } as unknown as PatientRun
const context = (stage: Conversation['stage'] = 'slot') => ({ stage, slots: [{ startsAt: 1 }, { startsAt: 2 }], lastText: 'Please choose option 1 or option 2, or say no to both. Which would you prefer?' } as Conversation)
for (const question of ["What's it for?", 'What’s this appointment for', 'Why?', 'what happens there?', 'Can you explain the visit', 'I do not understand what the appointment is for', "1, but what's it for?", "I'm confused—why do I need this visit?"]) {
  test(`explains pending appointment without treating ${JSON.stringify(question)} as consent`, () => {
    const c = context(), before = structuredClone(c)
    const answer = preparationClarification(patient, c, question)
    assert.match(answer ?? '', /full blood count/i)
    assert.match(answer ?? '', /kidney|salts/i)
    assert.match(answer ?? '', /ECG|heart tracing/i)
    assert.doesNotMatch(answer ?? '', /(?:I have|I've|is|are) booked|have ordered/i)
    assert.deepEqual(c, before)
  })
}
test('kidney question gets a direct explanation of the relevant test', () => {
  assert.match(preparationClarification({ ...patient, modifiers: ['renal_caution'] }, context(), 'Will it check my kidneys?')!, /U&E blood test.*checks salts and kidney function/)
})
test('blood explanation respects actual diabetes modifier', () => {
  assert.doesNotMatch(preparationClarification(patient, context(), 'Which bloods?')!, /HbA1c/)
  assert.match(preparationClarification({ ...patient, modifiers: ['add_hba1c', 'renal_caution'] }, context(), 'Which tests are these?')!, /HbA1c.*longer-term blood sugar/)
})
for (const question of ['Do I need to fast?', 'Can I eat beforehand', 'Should I stop my tablets?', 'When should I take the shakes?']) {
  test(`individual instructions remain with the team: ${question}`, () => {
    const text = preparationClarification(patient, context(), question) ?? ''
    assert.match(text, /instructions|team/)
    assert.doesNotMatch(text, /stop eating|stop drinking|skip|stop your|\d+ hours|midnight/)
  })
}
for (const [stage, pattern] of [['physio', /physiotherapist/], ['ecg_completion', /ECG|heart tracing/], ['nutrition', /surgical team/], ['transport', /home|first night/], ['arrival', /admission letter/]] as const) {
  test(`pronouns resolve to pending ${stage} topic`, () => assert.match(preparationClarification(patient, context(stage), 'Why are you asking?') ?? '', pattern))
}
for (const answer of ['1', 'option two', 'yes', 'no', 'No allergies', 'No, nobody has spoken to me', 'My team did not recommend any drinks', 'Going well every day', 'I do not have chest pain']) {
  test(`ordinary answer remains an answer: ${answer}`, () => assert.equal(preparationClarification(patient, context(), answer), undefined))
}
test('each clarification keeps one question and stays under the wording limit', () => {
  for (const stage of ['slot', 'physio', 'nutrition', 'transport', 'red_flag'] as const) {
    const text = preparationClarification({ ...patient, modifiers: ['add_hba1c', 'renal_caution'] }, context(stage), 'Can you explain?')!
    assert.ok(text.split(/\s+/).length < 80)
    assert.ok((text.match(/\?/g) ?? []).length <= 1)
  }
})

test('uncovered question receives an honest limitation without advancing approval', () => {
  const c = context(), before = structuredClone(c)
  assert.match(preparationClarification(patient, c, 'Can I bring my dog')!, /do not have confirmed guidance/)
  assert.deepEqual(c, before)
})

for (const question of ['Before I choose, explain the appointment please', 'I’m confused about this appointment', 'What do you mean by shown me']) {
  test(`clarification request does not require question punctuation: ${question}`, () => {
    assert.match(preparationClarification(patient, context(question.includes('shown') ? 'physio' : 'slot'), question) ?? '', /physiotherapist|full blood count/)
  })
}
test('attendance questions do not invent visitor arrangements', () => {
  assert.match(preparationClarification(patient, context(), 'Can my daughter sit with me') ?? '', /confirm.*accompany/)
})
test('nutrition questions remain about drinks when kidneys or substitutions are mentioned', () => {
  const renal = { ...patient, modifiers: ['renal_caution'] } as PatientRun
  assert.match(preparationClarification(renal, context('nutrition'), 'Is this right for my kidneys') ?? '', /kidney team or dietitian/)
  assert.match(preparationClarification(renal, context('nutrition'), 'Would supermarket shakes be the same') ?? '', /surgical team/)
  assert.doesNotMatch(preparationClarification(renal, context('nutrition'), 'Is this right for my kidneys') ?? '', /U&E|blood test/)
})

test('a family member collecting the patient is a transport question, not a visitor question', () => {
  const answer = preparationClarification(patient, context('transport'), 'What happens if my daughter cannot collect me') ?? ''
  assert.match(answer, /journey home|first night/)
  assert.doesNotMatch(answer, /accompany you at that visit/)
})
