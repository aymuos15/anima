import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readInBatches } from '../preop/batch-read.js'

test('cohort reads overlap up to four and retain source order', async () => {
  let active = 0, peak = 0
  const input = Array.from({ length: 9 }, (_, index) => index)
  const result = await readInBatches(input, async index => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 10 - index))
    active--; return `patient-${index}`
  })
  assert.equal(peak, 4)
  assert.deepEqual(result, input.map(index => `patient-${index}`))
})

test('cohort read failure rejects and does not start a later batch', async () => {
  const failure = new Error('simulator read failed')
  const calls: number[] = []
  await assert.rejects(readInBatches(Array.from({ length: 12 }, (_, index) => index), async index => {
    calls.push(index)
    if (index === 5) throw failure
    return index
  }), error => error === failure)
  assert.equal(calls.some(index => index >= 8), false)
})
