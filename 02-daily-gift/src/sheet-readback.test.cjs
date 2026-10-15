const test=require('node:test');
const assert=require('node:assert/strict');
const {waitForStableReadback}=require('./sheet-readback.cjs');

test('waits for a delayed sheet write and requires two matching reads',async()=>{
  const values=['','101,102','101,102'];
  let index=0;
  const result=await waitForStableReadback({
    read:async()=>values[index++],wait:async()=>{},matches:value=>value.split(',').filter(Boolean).length===2,
    verify:value=>value.split(','),formatObserved:value=>String(value.split(',').filter(Boolean).length),
    label:'名單',expectedDescription:'提示 2 位',
  });
  assert.deepEqual(result,['101','102']);
  assert.equal(index,3);
});

test('does not accept an unstable or mismatched readback and reports counts only',async()=>{
  const values=['','101',''];
  let index=0;
  await assert.rejects(waitForStableReadback({
    read:async()=>values[index++],wait:async()=>{},matches:value=>value.split(',').filter(Boolean).length===2,
    formatObserved:value=>String(value.split(',').filter(Boolean).length),label:'150 以上名單',
    expectedDescription:'Apps Script 提示 2 位',attempts:3,
  }),/Apps Script 提示 2 位；重讀筆數：0→1→0/);
});

test('retries validation failures until the same readback is stable and valid',async()=>{
  const values=['999','999','101','101'];
  let index=0;
  const result=await waitForStableReadback({
    read:async()=>values[index++],wait:async()=>{},matches:value=>value.split(',').filter(Boolean).length===1,
    verify:value=>{if(value!=='101')throw new Error('AID 不屬於來源');return value.split(',');},
    formatObserved:value=>String(value.split(',').filter(Boolean).length),label:'派送名單',
    expectedDescription:'提示 1 位',
  });
  assert.deepEqual(result,['101']);
  assert.equal(index,4);
});
