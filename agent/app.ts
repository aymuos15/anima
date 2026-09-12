import { z } from 'zod'
import { adk } from '@animahealth/adk'
import { sqliteStore } from '@animahealth/adk/stores/sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export const schema = {
  session: {
    patientId: z.string().default(''),
    patientName: z.string().default(''),
    stage: z.string().default(''),
    blockers: z.array(z.string()).default([]),
    needs: z.array(z.string()).default([]),
    goals: z.array(z.string()).default([]),
    procedureLabel: z.string().default('elective surgery'),
    modifiers: z.array(z.string()).default([]),
    conditions: z.array(z.string()).default([]),
    surgeryDate: z.string().default(''),
    daysToSurgery: z.number().default(28),
    checklist: z.array(z.any()).default([]),
    pendingEvent: z.any().optional(),
    escalated: z.boolean().default(false),
    wordingOnly: z.boolean().default(false),
  },
}

export const app = adk({
  name: 'pathway',
  schema,
  store: process.env.ADK_STORE === 'memory' ? undefined : sqliteStore(join(here, 'sessions.db')),
})
