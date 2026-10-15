import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireRunLock,processExists} from './run-lock.mjs';

test('PID 存活判定只接受有效 PID',()=>{assert.equal(processExists(12,()=>{}),true);assert.equal(processExists(0,()=>{}),false);assert.equal(processExists(12,()=>{const e=Error();e.code='ESRCH';throw e;}),false);});
test('自動清除無程序占用的失效鎖',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-lock-'));await fs.mkdir(path.join(dir,'private'));await fs.writeFile(path.join(dir,'private','run.lock'),JSON.stringify({pid:999999}));const handle=await acquireRunLock(dir,{}, {signal(){const e=Error();e.code='ESRCH';throw e;}});await handle.close();await fs.rm(dir,{recursive:true});});
test('真正執行中的鎖不會被清除',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-lock-'));await fs.mkdir(path.join(dir,'private'));await fs.writeFile(path.join(dir,'private','run.lock'),JSON.stringify({pid:123}));await assert.rejects(acquireRunLock(dir,{}, {signal(){}}),/已有更新程序/);await fs.rm(dir,{recursive:true});});
