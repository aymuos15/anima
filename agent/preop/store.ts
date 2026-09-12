import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Classification, OutcomeCode } from './rules.js'

export type Modifier = 'add_hba1c' | 'renal_caution' | 'transport_flag' | 'carer_flag' | 'interpreter_flag' | 'slots_late' | 'theatre_blocked'
export interface ChecklistItem {
  id: 'physio' | 'bloods' | 'ecg' | 'anaesthetic_questions' | 'transport'
  label: string
  state: 'not_started' | 'pending' | 'booked' | 'done' | 'review'
  detail?: string
  simRefs: Array<{ site: string; resourceId: string; kind: string }>
  dueStep?: number
  updatedAtStep: number
}
export interface ResultRecord { itemId: ChecklistItem['id']; outcome: OutcomeCode; step: number; classification: Classification }
export interface PatientRun {
  patientId: string
  name: string
  procedureLabel: string
  modifiers: Modifier[]
  needs: string[]
  conditions: string[]
  surgeryDate: string
  phone?: string
  sessionId?: string
  status: 'not_contacted' | 'in_progress' | 'ready' | 'clinical_review' | 'done'
  checklist: ChecklistItem[]
  results: ResultRecord[]
  transcript: Array<{ at: number; from: 'agent' | 'patient' | 'system'; text: string }>
  lastContactAt?: number
}
export interface DemoSnapshot { step: number; takenAt: number; patients: Record<string, PatientRun> }
export interface DemoState { runId: string; world: string; step: number; patients: Record<string, PatientRun>; snapshots: DemoSnapshot[] }
const file = new URL('../demo-state.json', import.meta.url)
let state: DemoState | undefined

export function getState(): DemoState {
  if (!state) {
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8')) as DemoState
    else state = { runId: randomUUID(), world: '', step: 0, patients: {}, snapshots: [] }
  }
  return structuredClone(state)
}
export function resetState(world: string, patients: PatientRun[]): DemoState {
  return saveState({ runId: randomUUID(), world, step: 0, patients: Object.fromEntries(patients.map(p => [p.patientId, p])), snapshots: [] })
}
export function saveState(next: DemoState): DemoState {
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  state = structuredClone(next)
  return getState()
}
export function savePatient(patient: PatientRun): PatientRun {
  const next = getState()
  const saved = structuredClone(patient)
  saved.status = deriveStatus(saved, next.step)
  next.patients[saved.patientId] = saved
  saveState(next)
  return structuredClone(saved)
}
export function readiness(patient: PatientRun): number { return patient.checklist.filter(item => item.state === 'done').length / 5 }
export function deriveStatus(patient: PatientRun, step: number): PatientRun['status'] {
  if (patient.checklist.some(item => item.state === 'review')) return 'clinical_review'
  if (readiness(patient) === 1) return step === 4 ? 'done' : 'ready'
  return patient.transcript.length ? 'in_progress' : 'not_contacted'
}
