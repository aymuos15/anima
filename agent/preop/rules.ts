import type { ChecklistItem, PatientRun } from './store.js'

// Revised patient guidance supplied via founder, clinician AG, 12 September 2026.
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
  bloods_normal: { severity: 'normal', itemState: 'done', allowedActions: [], patientExplanation: 'The results from your blood tests were all within the normal limits so nothing for us to do here.' },
  bloods_low_hb: { severity: 'action', itemState: 'review', allowedActions: ['create_task'], patientExplanation: 'Has anyone spoken to you about your blood results yet?', staffAction: { title: 'Review abnormal pre-operative blood results and contact the patient about next steps.', priority: 'routine', owner: 'gp' } },
  bloods_high_k: { severity: 'urgent', itemState: 'review', allowedActions: ['create_task'], patientExplanation: 'Your blood results need urgent clinical review today. Please contact your pre-op team today. Please do not change any medicines while waiting.', staffAction: { title: 'Potassium 5.9 mmol/L on pre-op bloods; nurse to call patient today and arrange repeat.', priority: 'urgent', owner: 'preop_nurse' } },
  ecg_normal: { severity: 'normal', itemState: 'pending', allowedActions: [], patientExplanation: 'Have you had your ECG?' },
  ecg_new_af: { severity: 'action', itemState: 'review', allowedActions: ['create_task'], patientExplanation: 'Have you had your ECG?', staffAction: { title: 'New AF on pre-op ECG; anaesthetic pre-assessment review before listing.', priority: 'routine', owner: 'anaesthetist' } },
  physio_done: { severity: 'normal', itemState: 'done', allowedActions: [], patientExplanation: 'How are you getting on with the exercises you were shown?' },
  physio_not_started: { severity: 'action', itemState: 'pending', allowedActions: ['create_task'], patientExplanation: 'Would you like help contacting your physiotherapy team about preparing for your operation?' },
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
export const BLOODS_FOLLOWUP = 'If not, someone should reach out to you shortly to discuss next steps but if you don’t hear from us in the next 24 hours, please call your surgeon to discuss.'

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
