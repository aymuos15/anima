import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPathway, fmtDate } from '../pathway.js'

const PATIENTS = ['SIM-000007', 'SIM-000504', 'SIM-000023', 'SIM-000002', 'SIM-000070']

for (const id of PATIENTS) {
  test(`pathway for ${id}`, async () => {
    const p = await buildPathway(id)
    assert.equal(p.patient?.id, id, `patient ${id} found`)
    assert.ok(p.events.length > 0, 'has events')
    assert.deepEqual(p.errors, [], 'no site errors')
    console.log(`${id} ${p.patient?.name}: stage=${p.currentStage} reached=[${p.stagesReached}] blockers=${p.blockers.length} events=${p.events.length}`)
    for (const e of p.events.slice(-4)) console.log(`   ${fmtDate(e.createdAt)} ${e.site} ${e.kind} ${e.status} | ${e.title}`)
  })
}
