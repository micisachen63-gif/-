const test=require('node:test');
const assert=require('node:assert/strict');
const {priorRunDecision,lockIsActive,prepRerunBrands}=require('./runner-policy.cjs');

test('finished gifts and gifts waiting for LINE activation are never rerun',()=>{
  assert.equal(priorRunDecision({status:'completed'}),'skip');
  assert.equal(priorRunDecision({status:'awaiting_audience',actions:{lineAudience:{}}}),'skip');
});

test('uncertain external actions stop automatic retries',()=>{
  assert.equal(priorRunDecision({status:'in_progress'}),'stop');
  assert.equal(priorRunDecision({status:'needs_review'}),'stop');
  assert.equal(priorRunDecision({status:'failed_preparation',actions:{'gameMail/below150':{}}}),'stop');
});

test('preparation without external actions can be retried',()=>{
  assert.equal(priorRunDecision(undefined),'run');
  assert.equal(priorRunDecision({status:'failed_preparation',actions:{}}),'run');
});

test('runner lock is honoured only while the owner is alive and recent',()=>{
  const now=Date.parse('2026-09-25T01:00:00Z');
  const info={pid:123,startedAt:'2026-09-25T00:30:00Z'};
  assert.equal(lockIsActive(info,now,()=>true),true);
  assert.equal(lockIsActive(info,now,()=>false),false);
  assert.equal(lockIsActive({pid:123,startedAt:'2026-09-24T20:00:00Z'},now,()=>true),false);
  assert.equal(lockIsActive(null,now,()=>true),false);
});

test('failed morning preparation is re-run automatically, but never after external actions',()=>{
  const date='2026-09-24',now=new Date('2026-09-25T02:00:00Z');
  const old='2026-09-24T23:05:00Z';
  const runs={
    [`${date}/qiezi`]:{status:'failed_preparation',actions:{},updatedAt:old},
    [`${date}/songyy`]:{status:'needs_review',actions:{'gameMail/below150':{}},updatedAt:old},
    [`${date}/winmalo`]:{status:'awaiting_audience',actions:{lineAudience:{}},updatedAt:old},
  };
  assert.deepEqual(prepRerunBrands(runs,date,'10:00',{},now),['qiezi']);
  assert.deepEqual(prepRerunBrands({},date,'10:00',{},now),['qiezi','songyy','winmalo']);
  assert.deepEqual(prepRerunBrands(runs,date,'07:10',{},now),[]);
  assert.deepEqual(prepRerunBrands(runs,date,'16:30',{},now),[]);
  assert.deepEqual(prepRerunBrands(runs,date,'10:00',{[date]:{count:3}},now),[]);
  assert.deepEqual(prepRerunBrands(runs,date,'10:00',{[date]:{count:1,lastAt:'2026-09-25T01:50:00Z'}},now),[]);
  const fresh={[`${date}/qiezi`]:{status:'failed_preparation',actions:{},updatedAt:'2026-09-25T01:55:00Z'}};
  assert.deepEqual(prepRerunBrands(fresh,date,'10:00',{},now).includes('qiezi'),false);
});
