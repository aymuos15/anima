import { z } from 'zod'
import { adk } from '@animahealth/adk'
import { sqliteStore } from '@animahealth/adk/stores/sqlite'
import { postgresStore } from '@animahealth/adk/stores/postgres'
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
  },
}

export const app = adk({
  name: 'pathway',
  schema,
  store: process.env.ADK_STORE === 'memory' ? undefined
    : process.env.DATABASE_URL ? postgresStore({ connectionString: process.env.DATABASE_URL })
    : sqliteStore(join(here, 'sessions.db')),
})
