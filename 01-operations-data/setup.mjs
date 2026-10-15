import {browser} from './runtime.mjs';
const c=await browser(false);
for(const url of ['https://admin.winmalo.com:9955/','https://admin.song-yy.com:9955/','https://admin.qzplays.com:9955/','https://docs.google.com/spreadsheets/d/1I9qDQZC4NYZDJN5f_Qil6zf9B9YXlQ7mLRUeVTg7dYo/edit']){
 const p=await c.newPage();await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(e=>console.log('頁面需要人工檢查：'+url+' '+e.message.split('\n')[0]));
}
console.log('專用瀏覽器已開啟。請登入三個後台和 Google；完成後關閉整個專用視窗。');
await new Promise(resolve=>c.on('close',resolve));
