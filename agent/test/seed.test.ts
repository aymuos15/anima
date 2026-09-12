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
