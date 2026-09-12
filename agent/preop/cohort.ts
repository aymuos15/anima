import { sim, type Patient } from '../sim.js'
import { buildPathway, type Pathway } from '../pathway.js'
import type { ChecklistItem, Modifier, PatientRun } from './store.js'
import { readInBatches } from './batch-read.js'

const queries = ['elective', 'surgery', 'arthritis', 'knee', 'hip', 'MSK', 'orthopaedic']
const eligibleCondition = /awaiting elective surgery|\b(?:joints?|knees?|hips?|msk|arthritis|osteoarthritis)\b/i
let featuredPatientIds: string[] = []

function makeRun(patient: Patient, pathway: Pathway, now: number): PatientRun {
  const conditions = patient.conditions ?? []
  const needs = patient.needs ?? []
  const modifiers: Modifier[] = []
  if (conditions.some(c => /diabetes/i.test(c))) modifiers.push('add_hba1c')
  if (conditions.some(c => /\bckd\b|kidney/i.test(c))) modifiers.push('renal_caution')
  if (needs.includes('Transport')) modifiers.push('transport_flag')
  if (needs.includes('Carer involvement')) modifiers.push('carer_flag')
  if (needs.includes('Interpreter')) modifiers.push('interpreter_flag')
  if (needs.includes('Shift work')) modifiers.push('slots_late')
  const blocked = pathway.events.some(e => ['surgery', 'theatre-slot'].includes(e.kind) && e.status === 'waiting' && e.stage === 'waiting')
  if (blocked) modifiers.push('theatre_blocked')
  const surgery = pathway.events.find(e => e.kind === 'surgery') ?? pathway.events.find(e => e.kind === 'theatre-slot')
  const labels: Array<[ChecklistItem['id'], string]> = [['physio', 'Physio exercises'], ['bloods', 'Blood tests'], ['ecg', 'ECG'], ['anaesthetic_questions', 'Anaesthetic questions'], ['transport', 'Transport and support']]
  const checklist: ChecklistItem[] = labels.map(([id, label]) => ({ id, label, state: 'not_started', simRefs: [], updatedAtStep: 0 }))
  if (modifiers.includes('transport_flag')) {
    checklist[4].state = 'pending'
    checklist[4].detail = 'transport need on record'
  }
  if (modifiers.includes('carer_flag')) checklist[4].detail = [checklist[4].detail, 'carer involvement on record'].filter(Boolean).join('; ')
  if (blocked) checklist[3].detail = 'Hospital is confirming the surgery date; theatre pathway is waiting'
  return {
    patientId: patient.id, name: patient.name,
    procedureLabel: surgery?.title || conditions.find(c => eligibleCondition.test(c)) || 'elective surgery',
    surgeryDate: new Date(surgery?.dueAt ?? now + 28 * 86400000).toISOString().slice(0, 10),
    modifiers, needs: [...needs], conditions: [...conditions], status: 'not_contacted', checklist, results: [], transcript: [],
  }
}
export async function loadCohort(): Promise<PatientRun[]> {
  const searches = await Promise.all(queries.map(q => sim.patients(q)))
  const candidatesById = new Map(searches.flatMap(result => result.items)
    .filter(patient => patient.conditions?.some(condition => eligibleCondition.test(condition)))
    .map(patient => [patient.id, patient]))
  for (let index = 0; index < queries.length && candidatesById.size < 40; index++) {
    for (let offset = searches[index].items.length; offset < searches[index].total && candidatesById.size < 40; offset += 30) {
      if (!offset) break
      const page = await sim.get(`/api/sites/gp/patients?q=${encodeURIComponent(queries[index])}&offset=${offset}`) as { total: number; items: Patient[] }
      if (!page.items.length) break
      for (const patient of page.items) {
        if (patient.conditions?.some(condition => eligibleCondition.test(condition))) candidatesById.set(patient.id, patient)
        if (candidatesById.size >= 40) break
      }
    }
  }
  const candidates = [...candidatesById.values()].slice(0, 40)
  const clock = await sim.clock()
  const startedAt = Date.now()
  let completed = 0
  console.info(`[preop cohort] Reading ${candidates.length} patient pathways, up to four concurrently`)
  const pathways = await readInBatches(candidates, async patient => {
    const pathway = await buildPathway(patient.id)
    console.info(`[preop cohort] Read ${++completed}/${candidates.length} in ${Date.now() - startedAt}ms`)
    return pathway
  })
  const cohort = candidates.flatMap((patient, index) => {
    const pathway = pathways[index]
    if (pathway.errors.length) console.error(`Pre-op pathway ${patient.id}: ${pathway.errors.join('; ')}`)
    const currentPatient = pathway.patient ?? patient
    if (!currentPatient.conditions?.some(condition => eligibleCondition.test(condition))) return []
    if (!currentPatient.conditions.some(c => /awaiting elective surgery/i.test(c)) && !pathway.events.some(e => ['surgery', 'theatre-slot', 'referral'].includes(e.kind))) return []
    return [makeRun(currentPatient, pathway, pathway.now || clock.now)]
  })
  featuredPatientIds = []
  const preferred: Array<(patient: PatientRun) => boolean> = [
    patient => patient.modifiers.includes('theatre_blocked'),
    patient => patient.needs.some(need => ['Transport', 'Carer involvement', 'Offline contact', 'Interpreter'].includes(need)),
    patient => patient.conditions.some(condition => /diabetes|\bckd\b/i.test(condition)),
    patient => !patient.modifiers.includes('theatre_blocked') && !patient.needs.some(need => ['Transport', 'Carer involvement', 'Offline contact', 'Interpreter'].includes(need)) && !patient.conditions.some(condition => /diabetes|\bckd\b/i.test(condition)),
  ]
  for (const preference of preferred) {
    const available = cohort.filter(patient => !featuredPatientIds.includes(patient.patientId))
    const chosen = available.find(preference) ?? available[0]
    if (chosen) featuredPatientIds.push(chosen.patientId)
  }
  return cohort
}
export function getFeaturedPatientIds(): string[] { return [...featuredPatientIds] }
export async function preparePatientRun(patientId: string): Promise<PatientRun> {
  const pathway = await buildPathway(patientId)
  if (!pathway.patient) throw new Error(`Patient not found: ${patientId}`)
  const now = pathway.now || (await sim.clock()).now
  return makeRun(pathway.patient, pathway, now)
}
