import { app } from '../app.js'
import { pathwayAgent } from '../agents.js'

const stream = app.run(pathwayAgent, {
  input: { message: 'start', initialState: { session: { patientId: 'SIM-000007', patientName: 'Mohammed Ali' } } },
} as any)
for await (const e of stream as any) {
  const t = e.type as string
  if (t === 'assistant_delta' || t === 'thought_delta') continue
  const brief = JSON.stringify(e).slice(0, 300)
  console.log(t, brief)
}
const r = await (stream as any)
console.log('RESULT status', r?.status, 'text:', r?.output?.text)
