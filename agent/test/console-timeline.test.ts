import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const script = readFileSync(new URL('../../console.html', import.meta.url), 'utf8').split('<script>')[1].split('</script>')[0]
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(booked = false) {
  const patient = { patientId: 'p', name: 'Test Patient', procedureLabel: 'Surgery', conditions: [], needs: [], modifiers: [], sessionId: 'session', status: 'in_progress', transcript: [{at: 1, from: 'agent', text: 'Waiting for your tests.'}], results: [], checklist: ['physio','bloods','ecg','anaesthetic_questions','transport'].map(id => ({ id, state: id === 'physio' ? 'pending' : booked && id === 'bloods' ? 'booked' : 'not_started', ...(booked && id === 'bloods' ? {dueStep: 1} : {}), simRefs: [] })) }
  let stepError = '', holdReads = false; const held: Array<()=>void> = []
  let state: any = { runId: 'fixture', world: 'fixture', step: 0, snapshots: [], patients: {p: patient} }
  const elements = new Map<string,any>(), requests: any[] = []
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, {textContent:'',innerHTML:'',value:'',disabled:false,addEventListener(){},scrollIntoView(){}}); return elements.get(id) }
  let poll: ()=>Promise<void>
  const ctx: any = {URLSearchParams, location:{search:''}, history:{replaceState(){}}, document:{getElementById:el,querySelector:el,addEventListener(){}},setInterval(fn:()=>Promise<void>){poll=fn},console:{error(){}},fetch:async(path:string,options:any)=>{
    if(options && stepError)return {ok:false,json:async()=>({error:stepError})}
    if(options){ const body=JSON.parse(options.body); requests.push({path,method:options.method,contentType:options.headers['Content-Type'],body}); assert.equal(path,'/api/demo/step'); if(body.direction===1){state.snapshots.push(structuredClone(state));state.step++;if(booked){state.patients.p.checklist[1].state='done';state.patients.p.results.push({itemId:'bloods',step:state.step});state.patients.p.transcript.push({at:2,from:'agent',text:'Your blood results are normal.'})}}else state=state.snapshots.pop() }
    const data=path==='/api/board'?{step:state.step,rows:Object.values(state.patients),featuredPatientIds:['p'],cohortCount:1,notReadyCount:1}:state
    const captured=structuredClone(data);if(!options && holdReads)await new Promise<void>(resolve=>held.push(resolve));return {ok:true,json:async()=>captured}
  }}
  ctx.window=ctx
  runInNewContext(readFileSync(new URL('../../preop-progress.js', import.meta.url),'utf8'),ctx)
  runInNewContext(script,ctx)
  return {el,requests,failStep:(message:string)=>{stepError=message},holdReads:()=>{holdReads=true},allowNewReads:()=>{holdReads=false},releaseReads:()=>{holdReads=false;held.splice(0).forEach(resolve=>resolve())},poll:async()=>{poll!();await tick()},ready:tick,click:async(id:string)=>{el(id).onclick();await tick();await tick()},state:()=>state}
}
test('unbooked +7 is visible, keeps honest no-results guidance across polling, never offers synthetic physio',async()=>{
  const h=harness();await h.ready();assert.doesNotMatch(h.el('outcomes').innerHTML,/outcome-physio/)
  await h.click('advance');assert.deepEqual(h.requests,[{path:'/api/demo/step',method:'POST',contentType:'application/json',body:{direction:1,outcomes:{}}}]);assert.match(h.el('days-label').textContent,/Week 1/)
  assert.match(h.el('timeline-feedback').textContent,/No test results were due/i);assert.match(h.el('timeline-feedback').textContent,/conversation|book/i)
  const notice=h.el('notice').textContent;await h.poll();assert.equal(h.el('notice').textContent,notice);assert.match(h.el('timeline-feedback').textContent,/No test results were due/i);assert.equal(h.state().patients.p.results.length,0)
})
test('due results visibly update checklist, readiness and thread; rewind restores prior view',async()=>{
  const h=harness(true);await h.ready();assert.match(h.el('outcomes').innerHTML,/outcome-bloods/);assert.match(h.el('featured').innerHTML,/0 of 5/)
  await h.click('advance');assert.match(h.el('timeline-feedback').textContent,/1 test result/);assert.match(h.el('featured').innerHTML,/1 of 5/);assert.match(h.el('featured').innerHTML,/width:20%/);assert.match(h.el('featured').innerHTML,/✓ Bloods/);assert.match(h.el('conversations').innerHTML,/blood results are normal/)
  await h.click('rewind');assert.equal(h.requests[1].body.direction,-1);assert.match(h.el('days-label').textContent,/Week 0/);assert.match(h.el('timeline-feedback').textContent,/restored/i);assert.match(h.el('timeline-feedback').textContent,/simulation date and existing bookings stay advanced/);assert.match(h.el('timeline-feedback').textContent,/Reset demo/);assert.match(h.el('featured').innerHTML,/0 of 5/);assert.doesNotMatch(h.el('conversations').innerHTML,/blood results are normal/)
})

test('an in-flight old poll cannot replace the successful timeline result',async()=>{
  const h=harness();await h.ready();h.holdReads();await h.poll();h.allowNewReads();await h.click('advance');h.releaseReads();await h.poll();assert.match(h.el('days-label').textContent,/Week 1/);assert.match(h.el('timeline-feedback').textContent,/Advanced to week 1/)
})
test('failed rewind preserves the current state and actionable error across polling',async()=>{
  const h=harness();await h.ready();await h.click('advance');h.failStep('Rewind needs the original conversation snapshot; reset after restarting the server');await h.click('rewind');assert.match(h.el('notice').textContent,/original conversation snapshot/);await h.poll();assert.match(h.el('notice').textContent,/original conversation snapshot/);assert.match(h.el('days-label').textContent,/Week 1/)
})
