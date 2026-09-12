import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretPhysioTopic, physioTopicReply } from '../preop/physio-dialogue.js'
import type { Conversation } from '../preop/agent.js'
import type { PatientRun } from '../preop/store.js'
const patient = { transcript: [], modifiers: [] } as unknown as PatientRun
const context = () => ({stage:'slot',slots:[{startsAt:1},{startsAt:2}],turns:3,lastText:'Which visit suits you: 1, morning, or 2, afternoon?'} as Conversation)
test('mixed questions and topic corrections preserve care state', async () => {
 for(const text of ['No, where can I find these', 'We were talking about physio', 'I meant the exercises', "I haven't finished asking about physio", 'No, can you explain where I get the plan']) {
  const c=context(), before=structuredClone(c)
  const intent=await interpretPhysioTopic(patient,c,text,async()=>text.includes('where')?'find_plan':'physio')
  assert.notEqual(intent,'none');const answer=physioTopicReply(intent)
  assert.match(answer,/physio|therapy/);assert.doesNotMatch(answer,/Which.*(?:visit|times)|showed you/)
  assert.deepEqual(c,before)
 }
})
test('unknown model output cannot authorize or move the protocol',async()=>{
 assert.equal(await interpretPhysioTopic(patient,context(),'Something else',async()=>'book_appointment'),'none')
})
test('definition never assumes teaching; finding a plan provides NHS guide',()=>{
 assert.doesNotMatch(physioTopicReply('physio'),/showed you|you were shown/)
 assert.match(physioTopicReply('find_plan'),/https:\/\/www.medway.nhs.uk/)
})

import { interpretDialogue } from '../preop/physio-dialogue.js'
test('grounded information receives real record and recent dialogue without mutating care state', async()=>{
 const c=context(), before=structuredClone(c)
 const p={...patient,conditions:['Arthritis','CKD'],needs:['Transport'],modifiers:['renal_caution'],checklist:[],results:[],transcript:[{at:0,from:'patient',text:'I meant my exercises'}]} as PatientRun
 const result=await interpretDialogue(p,c,'Please use my record',async input=>{
  const data=JSON.parse(input);assert.deepEqual(data.patient.conditions,['Arthritis','CKD']);assert.equal(data.pendingQuestion,c.lastText);assert.equal(data.recent[0].text,'I meant my exercises')
  return JSON.stringify({intent:'information',topic:'physio',text:'Your record includes arthritis and CKD. Your hospital physiotherapy team can provide a personal exercise plan.',report:'yes'})
 })
 assert.equal(result.report,'none');assert.deepEqual(c,before)
})
test('invalid generated commitments and unsupplied links fall back without approving actions',async()=>{
 for(const text of ['I have booked your tests.','Take 20 mg daily.','See https://invented.example/plan']) {
  const result=await interpretDialogue(patient,context(),'Tell me about the visit',async()=>JSON.stringify({intent:'information',topic:'bloods',text,report:'yes'}))
  assert.equal(result.intent,'answer');assert.equal(result.report,'none')
 }
})
