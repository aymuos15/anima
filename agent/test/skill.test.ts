import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const skill = readFileSync(new URL('../preop/skills/elective-preop.md', import.meta.url), 'utf8')
test('whole elective protocol has ten ordered sections, eight branches and seven modifiers', () => {
  assert.deepEqual([...skill.matchAll(/^## (.+)$/gm)].map(m => m[1]), ['Checklist order and what done means', 'Prehab and physio', 'Bloods', 'ECG', 'Anaesthetic questions', 'Transport and support', 'Result explanations and responses', 'Safety net', 'What happens on the day', 'Modifiers'])
  for (const code of ['bloods_normal', 'bloods_low_hb', 'bloods_high_k', 'ecg_normal', 'ecg_new_af', 'physio_done', 'physio_not_started', 'red_flag_raised', 'add_hba1c', 'renal_caution', 'transport_flag', 'carer_flag', 'interpreter_flag', 'slots_late', 'theatre_blocked']) assert.ok(skill.includes('### '+code), code)
  assert.ok(skill.includes('Thank you for telling me. I am not going to ask you anything else. A pre-op nurse will call you today. If it gets worse, or you have chest pain now, call 999.'))
})
