import test from 'node:test';
import assert from 'node:assert/strict';
import {clickTab,storedCredentialsReady,submit} from './backend.mjs';

test('記憶帳密須同時有可見帳號與密碼才可自動按登入',()=>{
 assert.equal(storedCredentialsReady({users:[false,true],passwords:[true]}),true);
 assert.equal(storedCredentialsReady({users:[true],passwords:[false]}),false);
 assert.equal(storedCredentialsReady({users:[],passwords:[true]}),false);
});

function fakePage({box,viewport={width:1440,height:1000},clickError=''}={}){
 let selected=false,domClicks=0,normalClicks=0;
 const tab={
  waitFor:async()=>{},
  getAttribute:async name=>name==='aria-selected'&&selected?'true':'false',
  boundingBox:async()=>box,
  evaluate:async fn=>{
   if(fn.toString().includes('el.click()')){domClicks++;selected=true;}
   return {visible:true};
  },
  click:async()=>{normalClicks++;if(clickError)throw Error(clickError);selected=true;},
 };
 const page={getByRole:(role,options)=>{assert.equal(role,'tab');assert.equal(options.name,'玩家消費');assert.equal(options.exact,true);return tab;},viewportSize:()=>viewport,waitForTimeout:async()=>{}};
 return {page,getState:()=>({selected,domClicks,normalClicks})};
}

test('report tab falls back to a DOM click when the tab remains outside the viewport',async()=>{
 const fake=fakePage({box:{x:1500,y:100,width:120,height:40}});
 await clickTab(fake.page,'玩家消費');
 assert.deepEqual(fake.getState(),{selected:true,domClicks:1,normalClicks:0});
});

test('report tab uses a normal click when it is in the viewport',async()=>{
 const fake=fakePage({box:{x:300,y:100,width:120,height:40}});
 await clickTab(fake.page,'玩家消費');
 assert.deepEqual(fake.getState(),{selected:true,domClicks:0,normalClicks:1});
});

test('report tab falls back when the browser still rejects the click as outside the viewport',async()=>{
 const fake=fakePage({box:{x:300,y:100,width:120,height:40},clickError:'element is outside of the viewport'});
 await clickTab(fake.page,'玩家消費');
 assert.deepEqual(fake.getState(),{selected:true,domClicks:1,normalClicks:1});
});

test('report tab only falls back for viewport click failures',async()=>{
 const fake=fakePage({box:{x:300,y:100,width:120,height:40},clickError:'target closed'});
 await assert.rejects(clickTab(fake.page,'玩家消費'),/target closed/);
 assert.deepEqual(fake.getState(),{selected:false,domClicks:0,normalClicks:1});
});

test('submit falls back once when the visible button remains outside the viewport',async()=>{
 let normalClicks=0,domClicks=0;
 const page={
  getByRole:(role,options)=>{
   assert.equal(role,'button');assert.equal(options.name,'送出');assert.equal(options.exact,true);
   return {click:async()=>{normalClicks++;throw Error('element is outside of the viewport');},evaluate:async()=>{domClicks++;return true;}};
  },
  waitForLoadState:async()=>{},waitForTimeout:async()=>{},
 };
 await submit(page);
 assert.deepEqual({normalClicks,domClicks},{normalClicks:1,domClicks:1});
});
