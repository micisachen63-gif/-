import test from 'node:test';import assert from 'node:assert/strict';
import {includeWeekly} from './schedule-policy.mjs';import {dates} from './core.mjs';
test('既有 Windows 排程週一包含上一完整週',()=>{const d=dates(new Date('2026-09-21T00:00:00Z'));assert.equal(includeWeekly(d,{scheduled:true,dailyOnly:true,weeklyEnabled:true}),true);assert.equal(d.weekStart,'2026-09-14');assert.equal(d.weekEnd,'2026-09-20');});
test('同一排程平日只做日更、未驗收時保留日更模式',()=>{assert.equal(includeWeekly(dates(new Date('2026-09-22T00:00:00Z')),{scheduled:true,dailyOnly:true,weeklyEnabled:true}),false);assert.equal(includeWeekly({monday:true},{scheduled:true,dailyOnly:true,weeklyEnabled:false}),false);});
test('手動 daily-only 仍可排除週更',()=>assert.equal(includeWeekly({monday:true},{scheduled:false,dailyOnly:true,weeklyEnabled:true}),false));
