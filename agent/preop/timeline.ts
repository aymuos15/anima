import { sim } from '../sim.js'
import { classify, type Classification, type OutcomeCode } from './rules.js'
import { getState, saveState, deriveStatus, type ChecklistItem, type DemoState } from './store.js'
export type OutcomePicks = Partial<Record<ChecklistItem['id'], OutcomeCode | 'random'>>
export interface TimelineEvent { patientId: string; classification: Classification }
const outcomesByItem: Partial<Record<ChecklistItem['id'], Array<[OutcomeCode, number]>>> = {
  bloods: [['bloods_normal', 0.5], ['bloods_low_hb', 0.3], ['bloods_high_k', 0.2]],
  ecg: [['ecg_normal', 0.7], ['ecg_new_af', 0.3]],
  physio: [['physio_done', 0.6], ['physio_not_started', 0.4]],
}
export async function stepTimeline(direction: 1 | -1, outcomes: OutcomePicks = {}, advanceClock = (minutes: number) => sim.advance(minutes)): Promise<{ state: DemoState; events: TimelineEvent[] }> {
  const state = getState()
  const events: TimelineEvent[] = []
  if (direction === -1) {
    const snapshot = state.snapshots.pop()
    if (!snapshot) return { state, events }
    state.step = snapshot.step
    state.patients = snapshot.patients
    return { state: saveState(state), events }
  }
  if (direction !== 1) throw new Error('Timeline direction must be 1 or -1')
  if (state.step >= 4) return { state, events }
  for (const [id, pick] of Object.entries(outcomes)) {
    if (pick !== 'random' && !outcomesByItem[id as ChecklistItem['id']]?.some(([code]) => code === pick)) throw new Error(`Invalid outcome ${pick} for ${id}`)
  }
  state.snapshots.push({ step: state.step, takenAt: Date.now(), patients: structuredClone(state.patients) })
  await advanceClock(10080)
  state.step++
  for (const patient of Object.values(state.patients)) {
    if (patient.status === 'not_contacted' && !patient.sessionId && !patient.transcript.length) continue
    for (const item of patient.checklist) {
      // Exercise teaching/progress is patient-reported, never advanced by a synthetic result roll.
      if (item.id === 'physio') continue
      const choices = outcomesByItem[item.id]
      const due = item.dueStep === state.step
      if (!choices || !due || item.state === 'done' || item.state === 'review') continue
      let code = outcomes[item.id]
      if (!code || code === 'random') {
        let roll = Math.random()
        code = choices[choices.length - 1][0]
        for (const [candidate, weight] of choices) { roll -= weight; if (roll < 0) { code = candidate; break } }
      }
      const classification = classify(code, patient)
      item.state = classification.itemState
      item.detail = classification.patientExplanation
      item.updatedAtStep = state.step
      delete item.dueStep
      patient.results.push({ itemId: item.id, outcome: code, step: state.step, classification })
      events.push({ patientId: patient.patientId, classification })
    }
    patient.status = deriveStatus(patient, state.step)
  }
  return { state: saveState(state), events }
}
