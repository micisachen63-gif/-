import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryStartupFailure,failedPlatformKeys} from './auto-retry.mjs';

const platforms=[{key:'win',name:'贏麻了'},{key:'song',name:'爽爆'},{key:'qz',name:'茄子'}];
const result=(platform,state,warnings=[])=>({platform,state,warnings});

test('只選失敗平台，不重跑已核對的平台',()=>{
 const status={completed:false,platforms:[result('贏麻了','failed'),result('爽爆','verified'),result('茄子','verified')]};
 assert.deepEqual(failedPlatformKeys(status,platforms),['win']);
});
test('紀錄不完整或有警告時不自動續跑',()=>{
 assert.equal(failedPlatformKeys({completed:false,platforms:[result('贏麻了','failed')]},platforms),null);
 assert.equal(failedPlatformKeys({completed:false,platforms:[result('贏麻了','failed'),result('爽爆','verified',['需人工核對']),result('茄子','verified')]},platforms),null);
 assert.equal(failedPlatformKeys({completed:true,platforms:platforms.map(p=>result(p.name,'verified'))},platforms),null);
});
test('三平台尚未開始的整體失敗可安全重試',()=>{
 assert.equal(canRetryStartupFailure({mode:'apply',completed:false,platforms:[],error:'Chrome 控制連線逾時'}),true);
 assert.equal(canRetryStartupFailure({mode:'apply',completed:false,platforms:[result('贏麻了','failed')],error:'中途失敗'}),false);
 assert.equal(canRetryStartupFailure({mode:'apply',completed:true,platforms:[],error:'異常狀態'}),false);
});
