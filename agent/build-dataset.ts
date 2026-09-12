// Builds agent/data/cohort.json: stage timings and blockers for a sample of patients, grouped by condition.
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sim, type Patient } from './sim.js'
import { buildPathway, type Stage } from './pathway.js'

const here = dirname(fileURLToPath(import.meta.url))
const QUERIES = ['SIM-0000', 'arthritis', 'back', 'elective', 'referral', 'heart', 'diabetes', 'asthma', 'frailty', 'hypertension', 'CKD']
const MAX = Number(process.env.COHORT_MAX ?? 60)
const ORDER: Stage[] = ['referred', 'assessed', 'waiting', 'treated', 'discharged']
const DAY = 86_400_000

async function main() {
  const seen = new Map<string, Patient>()
  for (const q of QUERIES) {
    const r = await sim.patients(q).catch(() => null)
    for (const p of r?.items ?? []) if (!seen.has(p.id) && seen.size < MAX) seen.set(p.id, p)
  }
  const ids = [...seen.keys()]
  console.log(`cohort: ${ids.length} patients`)

  const rows: any[] = []
  let i = 0
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++]
      try {
        const p = await buildPathway(id)
        const first: Partial<Record<Stage, number>> = {}
        for (const e of p.events) if (first[e.stage] === undefined) first[e.stage] = e.createdAt
        const transitions: Record<string, number> = {}
        for (let k = 0; k < ORDER.length - 1; k++) {
          const a = first[ORDER[k]], b = first[ORDER[k + 1]]
          if (a !== undefined && b !== undefined && b >= a) transitions[`${ORDER[k]}->${ORDER[k + 1]}`] = Math.round((b - a) / DAY)
        }
        const waitingSince = p.events.filter((e) => e.status === 'waiting').map((e) => Math.round((p.now - e.createdAt) / DAY))
        rows.push({
          id, conditions: seen.get(id)!.conditions, needs: seen.get(id)!.needs, currentStage: p.currentStage, stagesReached: p.stagesReached,
          transitionsDays: transitions, blockers: p.blockers, waitingDays: waitingSince.length ? Math.max(...waitingSince) : null,
          spanDays: p.events.length ? Math.round((p.events[p.events.length - 1].createdAt - p.events[0].createdAt) / DAY) : 0,
          eventCount: p.events.length,
          kinds: [...new Set(p.events.map((e) => e.kind))],
        })
        console.log(`${id} ${p.currentStage} ${JSON.stringify(transitions)}`)
      } catch (e) { console.log(`${id} failed: ${String(e).slice(0, 80)}`) }
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker))

  const byCondition: Record<string, any> = {}
  const allConds = new Set(rows.flatMap((r) => r.conditions))
  for (const c of [...allConds, 'all']) {
    const g = c === 'all' ? rows : rows.filter((r) => r.conditions.includes(c))
    const trans: Record<string, number[]> = {}
    for (const r of g) for (const [k, v] of Object.entries(r.transitionsDays)) (trans[k] ??= []).push(v as number)
    const stat = (xs: number[]) => xs.length ? { n: xs.length, median: median(xs), min: Math.min(...xs), max: Math.max(...xs) } : undefined
    byCondition[c] = {
      patients: g.length,
      stageNow: count(g.map((r) => r.currentStage)),
      transitionsDays: Object.fromEntries(Object.entries(trans).map(([k, v]) => [k, stat(v)])),
      waitingDays: stat(g.map((r) => r.waitingDays).filter((x) => x != null)),
      withBlockers: g.filter((r) => r.blockers.length).length,
      commonBlockers: top(g.flatMap((r) => r.blockers.map((b: string) => b.replace(/\s*\(.*\)$/, ''))), 5),
      commonNeeds: top(g.flatMap((r) => r.needs), 5),
    }
  }

  mkdirSync(join(here, 'data'), { recursive: true })
  const out = { builtAt: new Date().toISOString(), source: 'sim.animahacks.com synthetic world', patients: rows, byCondition }
  writeFileSync(join(here, 'data', 'cohort.json'), JSON.stringify(out, null, 1))
  console.log(`wrote data/cohort.json (${rows.length} patients, ${Object.keys(byCondition).length} groups)`)
}

function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2) }
function count(xs: string[]) { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return c }
function top(xs: string[], n: number) { return Object.entries(count(xs)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ item: k, count: v })) }

main()
