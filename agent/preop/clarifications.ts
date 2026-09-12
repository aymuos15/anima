import type { PatientRun } from './store.js'
import type { Conversation } from './agent.js'

// Explanations use the existing preparation plan; questions never authorize actions.
export function preparationClarification(patient: PatientRun, c: Conversation, text: string): string | undefined {
  const input = text.trim().replace(/[’‘]/g, "'").toLowerCase()
  const asks = /\?|\bexplain\b|\b(?:i'm|i am) confused\b/.test(input) || /^(?:what|why|how|when|where|which|who|can|could|should|would|will|can (?:i|you|we)|could (?:i|you|we)|should (?:i|we)|would (?:i|you|it)|will (?:i|you|it|this|that|they)|do (?:i|we|you)|does (?:it|that|this)|is (?:it|that|this|there)|are (?:these|those|you|we)|tell me|explain|help me understand|huh)\b/.test(input) || /\b(?:can you explain|don't understand|do not understand|not sure what|what (?:is|are|does|happens)|what's|why (?:is|are|do)|i(?:'d| would) like to know|i wonder)\b/.test(input)
  if (!asks) return undefined

  const bloods = `A full blood count checks your blood; U&E checks salts and kidney function.${patient.modifiers.includes('add_hba1c') ? ' HbA1c checks longer-term blood sugar.' : ''}`
  const visit = `The proposed pre-op visit is for blood tests and an ECG heart tracing. ${bloods}`
  const physio = "Physiotherapy can help you prepare for surgery. A physiotherapist can teach exercises suitable for you; I do not know whether you have already had that teaching."
  const nutrition = patient.modifiers.includes('renal_caution')
    ? 'Only take preparation drinks recommended by your surgical team. Your kidney team or dietitian should check which drinks suit you; follow your personal drinks and fasting instructions.'
    : 'Preparation drinks may contain carbohydrate or protein. Only use the drinks your surgical team recommended, following your personal drinks and fasting instructions.'
  const transport = 'We are checking your journey home and support for the first night. The practice can help request support with your agreement; that does not confirm a transport booking.'
  const arrival = 'Your admission letter should give your arrival time and location. The practice can help check missing details with your agreement.'
  const contextual = /\b(?:why|explain|understand|confused|meaning|more|what(?:'s| is| are| happens| do| does| did))\b/.test(input)
  let explanation: string
  // NHS fever glossary: https://www.nhs.uk/symptoms/fever-in-adults/
  if (/\bfever\b/.test(input) && /mean|define|explain|what is/.test(input)) {
    explanation = 'Fever means a high temperature. This question asks whether you have had that symptom since your operation was booked.'
  } else if (/\b(?:fast|fasting|eat|eating|food|beforehand|stop drinking)\b/.test(input)) {
    explanation = 'Follow the instructions for your blood-test visit and your hospital’s personal fasting plan for surgery. If these are missing or unclear, check with the practice or pre-assessment team before changing eating or drinking.'
  } else if (/\b(?:stop|change|skip|dose|take)\b.*\b(?:medicine|medicines|medication|tablets|insulin|blood thinner)|\b(?:medicine|medicines|medication|tablets|insulin)\b.*\b(?:stop|change|skip|dose)\b/.test(input)) {
    explanation = 'Your pre-assessment team must confirm your personal medicine instructions. Please check with them before changing any medicines.'
  } else if (/\b(?:results?|normal|abnormal|safe|fit)\b/.test(input) && /\b(?:mean|means|explain|normal|abnormal|safe|fit|worry)\b/.test(input)) {
    explanation = 'Your clinical team needs to explain what your results mean for you and confirm the next steps. Preparation checks do not provide clinical clearance for surgery.'
  } else if (/link|leaflet|nhs/.test(input) && /drink|shake|protein|carb/.test(input)) {
    explanation = 'This NHS leaflet explains carbohydrate pre-op drinks: https://www.royalfree.nhs.uk/patients-and-visitors/patient-information-leaflets/drinking-preop-r-surgery Follow your own team’s drink and fasting instructions.'
  } else if (/link|leaflet|nhs/.test(input) && /physio|exercise/.test(input)) {
    explanation = 'The NHS joint surgery preparation information is here: https://www.medway.nhs.uk/patients-and-visitors/having-surgery/hip-or-knee/ Follow your own physiotherapist’s exercise plan.'
  } else if (/\b(?:physio|physiotherapy|exercises?)\b/.test(input)) {
    explanation = physio
  } else if (/\b(?:drinks?|shakes?|protein|carbohydrate|carb|nutrition)\b/.test(input)) {
    explanation = nutrition
  } else if (/\b(?:daughter|son|partner|companion|accompany|family)\b/.test(input)) {
    explanation = c.stage === 'transport' || /collect|home|first night|pick up|take me/.test(input) ? transport : 'The practice or hospital needs to confirm whether someone can accompany you at that visit. Check the arrangements with them before bringing someone.'
  } else if (/\b(?:transport|carer|lift|home|first night)\b/.test(input)) {
    explanation = transport
  } else if (/\b(?:arrival|ward|entrance|address|hospital location)\b/.test(input)) {
    explanation = arrival
  } else if (/\b(?:kidneys?|renal)\b/.test(input)) {
    explanation = c.stage.startsWith('nutrition') ? nutrition : 'The U&E blood test in your preparation plan checks salts and kidney function. Your clinical team will explain what the results mean for you.'
  } else if (/\b(?:bloods?|tests?|appointment|visit|ecg|tracing|kidneys?|renal|u&e|fbc|hba1c)\b/.test(input)) {
    explanation = /\b(?:ecg|tracing)\b/.test(input) && !/\b(?:bloods?|appointment|visit)\b/.test(input)
      ? 'ECG means heart tracing. We arrange it alongside the blood-test visit where possible and check whether you have had it. Your clinical team explains the tracing.'
      : c.stage === 'slot' ? visit : bloods + ' The preparation plan also includes an ECG heart tracing.'
  } else if (!contextual) explanation = 'I do not have confirmed guidance for that detail. Your practice or pre-assessment team can check it for you.'
  else if (['physio', 'physio_progress', 'physio_help', 'barrier'].includes(c.stage)) explanation = physio
  else if (c.stage === 'slot') explanation = visit
  else if (c.stage === 'ecg_completion') explanation = 'ECG means heart tracing. I am checking whether you have had it; your clinical team explains the tracing and any next steps.'
  else if (c.stage.startsWith('nutrition')) explanation = nutrition
  else if (c.stage === 'transport') explanation = transport
  else if (c.stage.startsWith('arrival')) explanation = arrival
  else if (c.stage === 'medicines') explanation = 'Please include prescribed medicines, medicines you buy and blood thinners. Your pre-assessment team reviews your medicine instructions; this question does not ask you to change them.'
  else if (c.stage === 'allergies') explanation = 'We need to record any allergies and any problems you had with an earlier anaesthetic for your pre-assessment team to review.'
  else if (c.stage === 'red_flag') explanation = 'This checks for new symptoms since your operation was booked, so the pre-op team can arrange clinical review when needed.'
  else if (c.stage === 'blood_followup' || c.stage === 'waiting_results') explanation = 'We are checking whether your clinical team has discussed your blood results with you. They will explain the results and any next steps.'
  else explanation = 'I can help with your preparation appointments, exercises, drinks instructions and support arrangements. Your pre-assessment team can answer individual clinical questions.'

  const pending = c.stage === 'slot'
    ? c.slots.length >= 2 ? 'Which of the two offered times would you prefer?' : ''
    : c.lastText.split(/(?<=[.!])\s+/).reverse().find(sentence => sentence.includes('?')) ?? ''
  const answer = `${explanation}${pending ? ' ' + pending : ''}`
  return answer.split(/\s+/).length < 80 ? answer : explanation
}
