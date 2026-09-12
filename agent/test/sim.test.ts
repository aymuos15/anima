import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { sim } from '../sim.js'

test('slow actions can finish after the read deadline; all requests still abort without retries', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms / 100))
  let calls = 0, duration = 350
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    calls++
    await delay(duration, undefined, { signal: init.signal! })
    return new Response(JSON.stringify({ id: 'confirmed-action' }), { status: 200 })
  })
  assert.deepEqual(await sim.action('gp', { type: 'create_task', patientId: 'fixture-patient' }), { id: 'confirmed-action' })
  assert.equal(calls, 1)
  await assert.rejects(sim.clock(), { name: 'AbortError' })
  assert.equal(calls, 2, 'read abort does not retry')
  duration = 800
  await assert.rejects(sim.action('gp', { type: 'create_task', patientId: 'fixture-patient' }), { name: 'AbortError' })
  assert.equal(calls, 3, 'uncertain action abort does not replay the write')
})
