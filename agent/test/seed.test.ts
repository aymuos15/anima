import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sim, type Patient, type Resource } from '../sim.js'
import { seedStallWorld } from '../preop/seed.js'

const person = (id: string, conditions: string[], needs: string[] = []): Patient => ({ id, name: id, conditions, needs, goals: [], localIds: {}, birthDate: '1960-01-01' })
test('prepares three real patient referrals with record preferences and does not duplicate them on startup', async t => {
  const patients = [person('plain', ['Arthritis']), person('need', ['Arthritis', 'Diabetes'], ['Carer involvement']), person('renal', ['Arthritis', 'CKD']), person('spare', ['Arthritis']), person('blocked', ['Awaiting elective surgery'], ['Transport'])]
  const resources: Resource[] = []
  t.mock.method(sim, 'patients', async (q: string) => ({ total: patients.length, items: patients.filter(p => q === 'elective' ? p.id === 'blocked' : p.id !== 'blocked') }))
  t.mock.method(sim, 'view', async () => ({ now: 1, resources, resourceTotal: resources.length }))
  t.mock.method(sim, 'action', async (site: string, action: Record<string, unknown>) => {
    assert.equal(site, 'gp'); assert.equal(action.type, 'create_referral'); assert.equal(action.target, 'hospital')
    const resource = { id: `ref-${resources.length}`, patientId: action.patientId as string, kind: 'referral', title: action.title as string, status: 'open', createdAt: 1 }
    resources.push(resource); return resource
  })
  await seedStallWorld()
  assert.deepEqual(resources.map(r => r.patientId), ['need', 'renal', 'plain'])
  assert.ok(resources.every(r => r.title.startsWith('Demo scenario:')))
  await seedStallWorld()
  assert.equal(resources.length, 3)
  assert.deepEqual(patients[0].conditions, ['Arthritis'])
})

test('finishes a partially seeded world without duplicating the existing preferred patient', async t => {
  const patients = [person('need', ['Arthritis', 'Diabetes'], ['Carer involvement']), person('renal', ['Arthritis', 'CKD']), person('plain', ['Arthritis']), person('blocked', ['Awaiting elective surgery'])]
  const resources: Resource[] = [{ id: 'existing', patientId: 'need', kind: 'referral', title: 'Existing referral', status: 'open', createdAt: 1 }]
  t.mock.method(sim, 'patients', async (q: string) => ({ total: 4, items: patients.filter(p => q === 'elective' ? p.id === 'blocked' : p.id !== 'blocked') }))
  t.mock.method(sim, 'view', async () => ({ now: 1, resources, resourceTotal: resources.length }))
  t.mock.method(sim, 'action', async (_site: string, action: Record<string, unknown>) => { resources.push({ id: 'new', patientId: action.patientId as string, kind: 'referral', title: action.title as string, status: 'open', createdAt: 1 }); return resources.at(-1) })
  await seedStallWorld()
  assert.deepEqual(resources.map(r => r.patientId), ['need', 'renal', 'plain'])
})

test('does not seed from an incomplete referral inventory', async t => {
  t.mock.method(sim, 'patients', async () => ({ total: 1, items: [person('plain', ['Arthritis'])] }))
  t.mock.method(sim, 'view', async () => ({ now: 1, resources: [], resourceTotal: 501 }))
  t.mock.method(sim, 'action', async () => { assert.fail('No writes permitted from incomplete inventory') })
  await assert.rejects(seedStallWorld(), /incomplete referral inventory/i)
})

const demoReferral = (patientId: string): Resource => ({
  id: `demo-${patientId}`, patientId, kind: 'referral', owner: 'hospital',
  title: 'Demo scenario: elective orthopaedic pre-operative assessment', status: 'open', createdAt: 1,
  ...{ provenance: { created: { source: 'gp', action: 'create_referral', actor: { kind: 'team', name: 'owned-demo-world' } } } },
})
const seedPatients = () => [person('plain', ['Arthritis']), person('need', ['Arthritis', 'Diabetes'], ['Carer involvement']), person('renal', ['Arthritis', 'CKD']), person('spare', ['Arthritis']), person('blocked', ['Awaiting elective surgery'])]

for (const interrupted of [false, true]) {
  test(`recognizes GP-only demo referrals on rerun${interrupted ? ' after a committed action times out' : ''}`, async t => {
    const patients = seedPatients()
    const gp: Resource[] = []
    const writes: string[] = []
    t.mock.method(sim, 'patients', async (q: string) => ({ total: patients.length, items: patients.filter(p => q === 'elective' ? p.id === 'blocked' : p.id !== 'blocked') }))
    t.mock.method(sim, 'view', async (site: string, patient?: string) => {
      const resources = site === 'gp' ? gp.filter(r => r.patientId === patient) : []
      return { now: 1, resources, resourceTotal: resources.length }
    })
    t.mock.method(sim, 'action', async (_site: string, action: Record<string, unknown>) => {
      writes.push(action.patientId as string)
      const resource = demoReferral(action.patientId as string)
      gp.push(resource)
      if (interrupted && writes.length === 1) throw new Error('request timed out after commit')
      return resource
    })
    if (interrupted) await assert.rejects(seedStallWorld(), /timed out/)
    await seedStallWorld()
    assert.deepEqual(writes, ['need', 'renal', 'plain'])
    await seedStallWorld()
    assert.deepEqual(writes, ['need', 'renal', 'plain'], 'rerun must perform zero writes')
    assert.deepEqual(patients[0].conditions, ['Arthritis'])
  })
}

for (const failure of ['incomplete', 'unavailable']) {
  test(`performs no writes when one candidate GP inventory is ${failure}`, async t => {
    const patients = seedPatients()
    t.mock.method(sim, 'patients', async (q: string) => ({ total: patients.length, items: patients.filter(p => q === 'elective' ? p.id === 'blocked' : p.id !== 'blocked') }))
    t.mock.method(sim, 'view', async (site: string, patient?: string) => {
      if (site === 'gp' && patient === 'spare') {
        if (failure === 'unavailable') throw new Error('GP unavailable')
        return { now: 1, resources: [], resourceTotal: 501 }
      }
      return { now: 1, resources: [], resourceTotal: 0 }
    })
    let writes = 0
    t.mock.method(sim, 'action', async () => { writes++; return demoReferral('need') })
    await assert.rejects(seedStallWorld(), /incomplete|unavailable/i)
    assert.equal(writes, 0)
  })
}

test('GP notes and unrelated referrals do not fabricate elective eligibility', async t => {
  const patients = seedPatients()
  const writes: string[] = []
  t.mock.method(sim, 'patients', async (q: string) => ({ total: patients.length, items: patients.filter(p => q === 'elective' ? p.id === 'blocked' : p.id !== 'blocked') }))
  t.mock.method(sim, 'view', async (site: string, patient?: string) => {
    const resources = site === 'gp' ? [
      { ...demoReferral(patient!), kind: 'note' },
      { ...demoReferral(patient!), title: 'Dermatology review' },
      { ...demoReferral('other-patient') },
    ] : []
    return { now: 1, resources, resourceTotal: resources.length }
  })
  t.mock.method(sim, 'action', async (_site: string, action: Record<string, unknown>) => { writes.push(action.patientId as string); return demoReferral(action.patientId as string) })
  await seedStallWorld()
  assert.deepEqual(writes, ['need', 'renal', 'plain'])
})

test('retains a relevant existing hospital referral found only in the GP record', async t => {
  const patients = seedPatients()
  const writes: string[] = []
  t.mock.method(sim, 'patients', async (q: string) => ({ total: patients.length, items: patients.filter(p => q === 'elective' ? p.id === 'blocked' : p.id !== 'blocked') }))
  t.mock.method(sim, 'view', async (site: string, patient?: string) => {
    const resources = site === 'gp' && patient === 'need' ? [{ ...demoReferral('need'), title: 'Orthopaedic assessment' }] : []
    return { now: 1, resources, resourceTotal: resources.length }
  })
  t.mock.method(sim, 'action', async (_site: string, action: Record<string, unknown>) => { writes.push(action.patientId as string); return demoReferral(action.patientId as string) })
  await seedStallWorld()
  assert.deepEqual(writes, ['renal', 'plain'])
})
