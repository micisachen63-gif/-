import test from 'node:test';import assert from 'node:assert/strict';import {borrowedContext} from './attached-browser.mjs';
test('斷線只關程式建立的分頁，保留使用者頁面及原工作階段',async()=>{
 let ownClosed=0,userClosed=0,contextClosed=0,disconnects=0;
 const userPage={close(){userClosed++;}};
 const context={pages(){return[userPage];},async newPage(){let closed=false;return{isClosed:()=>closed,async close(){closed=true;ownClosed++;}};},async close(){contextClosed++;}};
 const wrapped=borrowedContext({async close(){disconnects++;}},context);assert.equal(wrapped.pages()[0],userPage);await wrapped.newPage();const p=await wrapped.newPage();await p.close();await wrapped.close();await wrapped.close();assert.equal(ownClosed,2);assert.equal(userClosed,0);assert.equal(contextClosed,0);assert.equal(disconnects,1);
});
