import type { Conversation } from './agent.js'
import type { PatientRun } from './store.js'

export function clearSymptomDenial(text: string): boolean {
  const answer = text.trim().toLowerCase().replace(/[’‘]/g, "'")
  return /^(?:no|nope)\b/.test(answer) && !/\bi (?:have|had|have had|am having|experienced|felt) (?:it|that|this|those|these|them|symptoms)\b/.test(answer) && !/\?|\b(?:but|maybe|perhaps|sometimes|occasionally|unsure|think|except|however|anymore|currently|today|yesterday|appointment|booking|transport|carer|answer|tell|prefer|want)\b|not sure|a bit|used to/.test(answer)
}
export function supportAgreement(text: string, c: Conversation, patient: PatientRun): boolean {
  const answer = text.trim().toLowerCase().replace(/[’‘]/g, "'")
  if (!/^yes\b/.test(answer) || /\?|\b(?:but|maybe|perhaps|if|unless|not|don't|cannot|can't|unsure|only|no)\b/.test(answer)) return false
  if (c.stage === 'transport') {
    const requested = patient.modifiers.filter(m => ['transport_flag', 'carer_flag', 'interpreter_flag'].includes(m))
    if (requested.length && !requested.every(m => m === 'carer_flag' ? /carer/.test(answer) : m === 'interpreter_flag' ? /interpreter/.test(answer) : /transport|journey|lift/.test(answer))) return false
    return /please|agreed|help|carer|interpreter|transport|daughter|son|partner|friend|family|take me|stay|home/.test(answer)
  }
  if (c.stage === 'physio_help' || c.stage === 'barrier') return /please|physio|leaflet|contact/.test(answer)
  if (c.stage === 'arrival_help') return /please|help|check|contact/.test(answer)
  return false
}
