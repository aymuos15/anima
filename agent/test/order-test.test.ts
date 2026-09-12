import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeTools } from '../tools/write.js'

// Catches omission of the top-level title required by the live clinical-records API.
test('approved blood orders serialize a title and preserve the selected panel; declined orders never send', async t => {
  const requests: Record<string, any>[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests.push(body)
    if (typeof body.title !== 'string' || !body.title.trim()) return new Response(JSON.stringify({ error: 'Internal simulation error' }), { status: 500 })
    return new Response(JSON.stringify({ id: `test-${body.bloodTestOrder.panelId}`, kind: 'test', title: body.title, patientId: body.patientId, data: { bloodTestOrder: body.bloodTestOrder } }), { status: 200 })
  })
  const order = (writeTools({ tool: (definition: any) => definition } as any) as any[]).find(tool => tool.name === 'order_test')
  for (const panelId of ['fbc', 'ue', 'hba1c']) {
    const args = order.schema.parse({ patientId: 'fixture-patient', panelId, clinicalDetails: 'Pre-operative assessment' })
    const before = requests.length
    assert.equal((await order.finalize({ args, input: { approved: false } })).status, 'declined')
    assert.equal(requests.length, before)
    const result = await order.finalize({ args, input: { approved: true } })
    assert.equal(result.status, 'done', `The ${panelId} request must contain a non-empty title`)
    assert.equal(requests.length, before + 1)
    assert.equal(result.result.patientId, 'fixture-patient')
    assert.deepEqual(result.result.data.bloodTestOrder, { panel: panelId.toUpperCase(), panelId, specimen: 'Blood', priority: 'routine', collection: 'next-round', clinicalDetails: 'Pre-operative assessment' })
    assert.match(requests.at(-1)!.clientRequestId, /^[0-9a-f-]{36}$/)
  }
})
