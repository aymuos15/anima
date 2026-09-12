import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const script=readFileSync(new URL('../../handset.html',import.meta.url),'utf8').split('<script>')[1].split('</script>')[0].split('(async () => {')[0]
function harness(){
 let plays=0,requests=0,release!:()=>void
 const pending=new Promise<void>(r=>{release=r})
 const state={runId:'test',patients:{p:{name:'Test',transcript:[{from:'agent',text:'Approved greeting'}]}}}
 const elements=new Map<string,any>()
 const el=(id:string)=>{if(!elements.has(id))elements.set(id,{value:id==='patient'?'p':'',hidden:id==='begin',textContent:'',replaceChildren(){},append(){},pause(){},play(){plays++;queueMicrotask(()=>el(id).onended?.({}));return Promise.resolve()},setSinkId:async()=>{}});return elements.get(id)}
 const track={enabled:false,stop(){}};const channel:any={close(){}}
 class Peer{createDataChannel(){return channel}addTrack(){}async createOffer(){return{sdp:'offer'}}async setLocalDescription(){}async setRemoteDescription(){}close(){}}
 const context:any={document:{getElementById:el,createElement:()=>({append(){}}),createTextNode:(x:unknown)=>x},location:{search:'?relay=phone'},URLSearchParams,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},AbortSignal,console:{info(){},error(){}},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]}),enumerateDevices:async()=>[{kind:'audioinput',label:'MacBook Pro Microphone',deviceId:'in'},{kind:'audiooutput',label:'BlackHole 2ch',deviceId:'out'}]}},RTCPeerConnection:Peer,fetch:async(path:string)=>{if(path.endsWith('/speak')){requests++;await pending;return{ok:true,blob:async()=>({})}}return{ok:true,status:200,text:async()=> 'answer',json:async()=>structuredClone(state)}}}
 runInNewContext(script,context);runInNewContext(`state=${JSON.stringify(state)}`,context)
 return{el,state,release,channel,plays:()=>plays,requests:()=>requests}
}
test('phone relay buffers approved greeting before ready and never speaks before operator starts',async()=>{
 const h=harness();await h.el('answer').onclick();const opening=h.channel.onopen();await new Promise(r=>setImmediate(r))
 assert.equal(h.requests(),1,'greeting must preload before call');assert.equal(h.el('begin').hidden,true);assert.equal(h.plays(),0)
 h.release();await opening;assert.equal(h.el('begin').hidden,false);await h.el('begin').onclick();assert.equal(h.plays(),1);assert.equal(h.requests(),1)
})
test('changed approved transcript never reuses stale buffered speech',async()=>{
 const h=harness();await h.el('answer').onclick();const opening=h.channel.onopen();h.release();await opening
 h.state.patients.p.transcript[0].text='Updated approved greeting';await h.el('begin').onclick();assert.equal(h.requests(),2)
})
test('ending during preload cannot re-arm the relay or play audio',async()=>{
 const h=harness();await h.el('answer').onclick();const opening=h.channel.onopen();h.el('end').onclick();h.release();await opening
 assert.equal(h.el('begin').hidden,true);assert.equal(h.plays(),0)
})
