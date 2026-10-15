const test=require('node:test');
const assert=require('node:assert/strict');
const {verifySheetCoverage}=require('./sheet-policy.cjs');

const header=['AID','總儲值','Line ID','最後登入IP'];

test('the existing Apps Script excludes every unpaid member on a duplicate IP',()=>{
  const rows=[
    ['101','0','U1','1.2.3.4'],
    ['102','0','U2','1.2.3.4 (shared)'],
    ['103','0','U3','5.6.7.8'],
  ];
  assert.deepEqual(verifySheetCoverage(header,rows,{below150:['103']},['U3']),{
    eligibleCount:1,excludedDuplicateIpZeroDeposit:2,
  });
});

test('a paid member on a duplicate IP remains eligible',()=>{
  const rows=[['101','0','U1','1.2.3.4'],['102','200','U2','1.2.3.4']];
  assert.deepEqual(verifySheetCoverage(header,rows,{atLeast150:['102'],below150:[]},['U2']),{
    eligibleCount:1,excludedDuplicateIpZeroDeposit:1,
  });
});

test('a missing eligible gift or LINE UID stops processing',()=>{
  const rows=[['101','0','U1','1.2.3.4'],['102','0','U2','5.6.7.8']];
  assert.throws(()=>verifySheetCoverage(header,rows,{below150:['101']},['U1','U2']),/派送名單與來源不一致/);
  assert.throws(()=>verifySheetCoverage(header,rows,{below150:['101','102']},['U1']),/LINE UID 名單與來源不一致/);
});

test('duplicate LINE IDs in otherwise eligible source rows stop processing',()=>{
  const rows=[['101','0','U1','1.2.3.4'],['102','0','U1','5.6.7.8']];
  assert.throws(()=>verifySheetCoverage(header,rows,{below150:['101','102']},['U1']),/LINE UID 名單與來源不一致/);
});
