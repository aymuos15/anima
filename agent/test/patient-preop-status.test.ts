import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const html=readFileSync(new URL('../../pathway.html',import.meta.url),'utf8')
const tag=html.match(/  function tagFor\(\) \{[\s\S]*?\n  \}/)![0]
for(const [status,text,cls] of [['ready','Ready for theatre','green'],['clinical_review','Clinical review needed','red'],['in_progress','In progress','blue']]) {
 test(`pre-op ${status} takes priority over unrelated waiting pathway`,()=>{
  const result=runInNewContext(`${tag};tagFor()`,{preopRun:()=>({status}),pathway:{currentStage:'waiting',blockers:[]}})
  assert.equal(result.text,text);assert.equal(result.cls,cls)
 })
}
test('countdown uses the actual operation date and simulation clock for late starters',()=>{
 const source=html.match(/  function surgeryCountdown\(run, now\) \{[\s\S]*?\n  \}/)?.[0] || ''
 const context={run:{surgeryDate:'2026-10-17T00:00:00Z'},now:Date.parse('2026-09-19T00:00:00Z')}
 assert.equal(runInNewContext(`${source};surgeryCountdown(run, now)`,context),' · 28 days to go')
 assert.equal(runInNewContext(`${source};surgeryCountdown(run, undefined)`,context),'')
})
test('unconfirmed fallback dates and waiting theatre slots never become operation promises',()=>{
 const source=html.match(/  function confirmedSurgeryDate\(run, record\) \{[\s\S]*?\n  \}/)?.[0] || ''
 const run={surgeryDate:'2026-10-17',modifiers:[]}
 const value=(record:unknown)=>runInNewContext(`${source};confirmedSurgeryDate(run,record)`,{run,record})
 assert.equal(value({events:[]}),null)
 assert.equal(value({events:[{kind:'theatre-slot',status:'waiting',dueAt:123}]}),null)
 assert.equal(value({events:[{kind:'surgery',status:'booked',dueAt:123}]}),123)
 run.modifiers.push('theatre_blocked' as never)
 assert.equal(value({events:[{kind:'surgery',status:'booked',dueAt:123}]}),null)
})
