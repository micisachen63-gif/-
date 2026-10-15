import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDailySource} from './source-validation.mjs';

const base={approvedMonth:'2026-10',daily:[['2026-09-01'],['2026-10-01']],monthClose:null};
const ordinary={from:'2026-09-01',to:'2026-10-01',previousMonthKey:'2026-09',rollover:false};
test('2 日一般日更不要求上月結算資料',()=>assert.doesNotThrow(()=>validateDailySource(base,ordinary,'2026-10',2)));
test('一般日更仍核對核准月份與完整期間',()=>{
 assert.throws(()=>validateDailySource({...base,approvedMonth:'2026-09'},ordinary,'2026-10',2));
 assert.throws(()=>validateDailySource({...base,daily:[['2026-09-01']]},ordinary,'2026-10',2));
});
test('1 日跨月仍嚴格檢查會員月份與幣商數量',()=>{
 const rollover={...ordinary,to:'2026-09-30',rollover:true};
 const source={...base,approvedMonth:'2026-09',daily:[['2026-09-01'],['2026-09-30']],monthClose:{members:{month:'2026-09'},merchants:[{},{}]}};
 assert.doesNotThrow(()=>validateDailySource(source,rollover,'2026-09',2));
 assert.throws(()=>validateDailySource({...source,monthClose:null},rollover,'2026-09',2));
 assert.throws(()=>validateDailySource({...source,monthClose:{...source.monthClose,merchants:[{}]}},rollover,'2026-09',2));
});
