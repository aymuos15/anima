import type { ChecklistItem, PatientRun } from './store.js'

// Clinical wording and thresholds await the clinician's sign-off.
export const LOW_HB_MEN = 130
export const LOW_HB_WOMEN = 120
export const HIGH_POTASSIUM = 5.5
export type OutcomeCode = 'bloods_normal' | 'bloods_low_hb' | 'bloods_high_k' | 'ecg_normal' | 'ecg_new_af' | 'physio_done' | 'physio_not_started' | 'anaesthetic_clear' | 'red_flag_raised'
export type ActionName = 'order_test' | 'create_task' | 'book_appointment' | 'save_problem' | 'update_checklist' | 'escalate'
export interface Classification {
  code: OutcomeCode
  severity: 'normal' | 'action' | 'urgent'
  itemState: ChecklistItem['state']
  allowedActions: ActionName[]
  patientExplanation: string
  staffAction?: { title: string; priority: 'routine' | 'urgent'; owner: 'gp' | 'preop_nurse' | 'anaesthetist' }
}
const table: Record<OutcomeCode, Omit<Classification, 'code'>> = {
  bloods_normal: { severity: 'normal', itemState: 'done', allowedActions: [], patientExplanation: 'Your blood tests are back and everything is in the normal range. Nothing more to do on this one.' },
  bloods_low_hb: { severity: 'action', itemState: 'review', allowedActions: ['order_test', 'create_task'], patientExplanation: 'Your blood count is a little lower than we would like before an operation. This is common and usually treatable. We will repeat the test with an iron check and your GP will look at the result. Your operation date has not changed.', staffAction: { title: 'Repeat FBC with ferritin and iron studies; GP to review and consider iron.', priority: 'routine', owner: 'gp' } },
  bloods_high_k: { severity: 'urgent', itemState: 'review', allowedActions: ['create_task'], patientExplanation: 'One of your blood salts, potassium, is higher than expected. A pre-op nurse will call you today to talk it through. Please do not change any medicines until then.', staffAction: { title: 'Potassium 5.9 mmol/L on pre-op bloods; nurse to call patient today and arrange repeat.', priority: 'urgent', owner: 'preop_nurse' } },
  ecg_normal: { severity: 'normal', itemState: 'done', allowedActions: [], patientExplanation: 'Your heart tracing is normal. Nothing more to do on this one.' },
  ecg_new_af: { severity: 'action', itemState: 'review', allowedActions: ['create_task'], patientExplanation: 'Your heart tracing shows an irregular rhythm that was not on your record before. This is common and the anaesthetist needs to look at it before your operation. They will contact you.', staffAction: { title: 'New AF on pre-op ECG; anaesthetic pre-assessment review before listing.', priority: 'routine', owner: 'anaesthetist' } },
  physio_done: { severity: 'normal', itemState: 'done', allowedActions: [], patientExplanation: 'Good, keep going with the exercises until your operation.' },
  physio_not_started: { severity: 'action', itemState: 'pending', allowedActions: ['create_task'], patientExplanation: 'The exercises make a real difference to how quickly you recover. What is getting in the way?' },
  anaesthetic_clear: { severity: 'normal', itemState: 'done', allowedActions: [], patientExplanation: '' },
  red_flag_raised: { severity: 'urgent', itemState: 'review', allowedActions: ['create_task'], patientExplanation: 'Thank you for telling me. I am not going to ask you anything else. A pre-op nurse will call you today. If it gets worse, or you have chest pain now, call 999.', staffAction: { title: 'Patient reports [symptom] during pre-op contact; clinical review today.', priority: 'urgent', owner: 'preop_nurse' } },
}
export function classify(outcome: OutcomeCode, patient: PatientRun): Classification {
  if (!table[outcome]) throw new Error(`Unknown outcome: ${outcome}`)
  const result: Classification = { code: outcome, ...structuredClone(table[outcome]) }
  if (outcome === 'bloods_high_k' && patient.modifiers.includes('renal_caution')) result.staffAction = {
    title: 'Potassium 5.9 mmol/L on pre-op bloods with kidney condition; urgent anaesthetist review; nurse to call patient today and arrange repeat.', priority: 'urgent', owner: 'anaesthetist',
  }
  return result
}
const phrases = ['chest pain', 'chest tightness', 'short of breath', 'breathless', "can't breathe", 'cannot breathe', 'fever', 'temperature', 'bleeding', 'black stools', 'confused', 'confusion', 'collapsed', 'fainted', 'swollen leg', 'calf pain']
export function detectRedFlag(text: string, pendingQuestion?: 'anaesthetic_red_flag'): string | null {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'")
  for (const clause of normalized.split(/[.!?;]|,(?=\s*(?:i|my|have|am|feel)\b)|\b(?:but|however|although)\b|\band\s+(?=(?:i\s+)?(?:have|am|feel|developed)\b)/)) {
    for (const phrase of phrases) {
      const index = clause.indexOf(phrase)
      if (index < 0) continue
      let before = clause.slice(0, index)
      for (const other of phrases) before = before.replaceAll(other, '')
      before = before.replace(/,/g, ' ').replace(/\b(?:or|and|any|new|a|the|signs|of)\b/g, '').replace(/\s+/g, ' ').trim()
      if (/(?:\b(?:no|never|without|denies|deny)|\b(?:not|don't|doesn't|haven't|hasn't)(?: (?:have|had|having|been|feeling|experiencing|at all|currently))?)$/.test(before)) continue
      return phrase
    }
  }
  const answer = normalized.trim()
  if (pendingQuestion === 'anaesthetic_red_flag' && /^(?:yes|yeah|yep|i do|a bit|sometimes)(?:\b|[,.!?])/.test(answer) && !/^(?:i do not|yes to\b)|\bno symptoms\b/.test(answer)) return 'symptom affirmed in anaesthetic red-flag question'
  return null
}
