import { z } from 'zod'
import { adk } from '@animahealth/adk'
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

// Session store: ADK_STORE=memory (in-process), DATABASE_URL (Postgres, used on Netlify + Supabase),
// otherwise a local sqlite file. Each store is imported only when selected so the serverless bundle
// never needs the native sqlite module.
async function pickStore() {
  if (process.env.ADK_STORE === 'memory') return undefined
  if (process.env.DATABASE_URL) {
    // Create the pool here (rather than letting the store require 'pg' by name at runtime) so the
    // serverless bundle includes pg.
    const [{ postgresStore }, pg] = await Promise.all([import('@animahealth/adk/stores/postgres'), import('pg')])
    return postgresStore({ pool: new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) })
  }
  const { sqliteStore } = await import('@animahealth/adk/stores/sqlite')
  return sqliteStore(join(here, 'sessions.db'))
}

export const app = adk({ name: 'pathway', schema, store: await pickStore() })
