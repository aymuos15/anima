import { sim, type Patient, type Resource } from '../sim.js'
import { readInBatches } from './batch-read.js'

const title = 'Demo scenario: elective orthopaedic pre-operative assessment'
const support = (patient: Patient) => patient.needs.some(need => ['Transport', 'Carer involvement', 'Offline contact', 'Interpreter'].includes(need))
const diabetes = (patient: Patient) => patient.conditions.some(condition => /diabetes/i.test(condition))
const renal = (patient: Patient) => patient.conditions.some(condition => /\bckd\b|kidney/i.test(condition))

// Call only while preparing an owned 13health-stall world, before cohort loading.
// These are openly labelled authored demo referrals for existing sim patients.
export async function seedStallWorld(): Promise<void> {
  const [arthritis, elective, referrals] = await Promise.all([
    sim.patients('arthritis'), sim.patients('elective'), sim.view('referrals'),
  ])
  if ((referrals.resourceTotal ?? referrals.resources.length) > referrals.resources.length) {
    throw new Error('Cannot prepare stall world from an incomplete referral inventory')
  }
  const candidates = arthritis.items.filter(patient => patient.conditions.some(condition => /\b(?:arthritis|osteoarthritis)\b/i.test(condition)))
  const referred = new Set(referrals.resources.filter(resource => resource.kind === 'referral').map(resource => resource.patientId))
  // GP-created referrals can be absent from the referrals site's inventory,
  // including when the action committed but its response timed out. Read every
  // candidate before writing so an uncertain inventory cannot cause a replay.
  const records = await readInBatches(candidates, async patient => {
    const view = await sim.view('gp', patient.id)
    if ((view.resourceTotal ?? view.resources.length) > view.resources.length) {
      throw new Error(`Cannot prepare stall world from an incomplete GP inventory for ${patient.id}`)
    }
    return view.resources.filter(resource => resource.patientId === patient.id
      && resource.kind === 'referral' && resource.owner === 'hospital'
      && (resource.title === title || /\b(?:orthopaedic|orthopedic|elective|knee|hip|msk|joint)\b/i.test(resource.title)))
  })
  for (const resource of records.flat()) referred.add(resource.patientId)
  const eligible = new Set([
    ...elective.items.filter(patient => patient.conditions.some(condition => /awaiting elective surgery/i.test(condition))).map(patient => patient.id),
    ...candidates.filter(patient => referred.has(patient.id)).map(patient => patient.id),
  ])
  if (eligible.size >= 4) return

  const preferences = [
    (patient: Patient) => support(patient) || diabetes(patient),
    renal,
    (patient: Patient) => !support(patient) && !diabetes(patient) && !renal(patient),
  ]
  const represented = new Set<string>()
  for (const preference of preferences) {
    if (eligible.size >= 4) break
    const existing = candidates.find(patient => referred.has(patient.id) && !represented.has(patient.id) && preference(patient))
    if (existing) { represented.add(existing.id); continue }
    const available = candidates.filter(patient => !eligible.has(patient.id))
    const chosen = available.find(preference) ?? available[0]
    if (!chosen) break
    const resource = await sim.action('gp', { type: 'create_referral', patientId: chosen.id, target: 'hospital', title }) as Resource
    if (!resource.id || resource.kind !== 'referral' || resource.patientId !== chosen.id) {
      throw new Error(`Stall referral was not confirmed for ${chosen.id}`)
    }
    console.log(`Stall demo preparation: ${chosen.id} referral ${resource.id}`)
    eligible.add(chosen.id)
    referred.add(chosen.id)
    represented.add(chosen.id)
  }
}
