// Short GIF replays from server outcomes. Rendering runs off the Telegram event loop.
import fs from 'node:fs';
import path from 'node:path';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {Resvg} from '@resvg/resvg-js';
import gifenc from 'gifenc';
import {battleHeroAsset,battleBossAsset,battleTheme} from './rpg-battle-assets.js';
const {GIFEncoder,quantize,applyPalette}=gifenc;
export const WIDTH=720,HEIGHT=405;
const ROOT=path.resolve(import.meta.dirname,'../art-runtime/rpg-party');
const FONT={loadSystemFonts:false,fontFiles:['C:/Windows/Fonts/msjh.ttc','C:/Windows/Fonts/arial.ttf'],defaultFontFamily:'Microsoft JhengHei'};
const xml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const sprites=new Map();
function svgPixels(body,w=WIDTH,h=HEIGHT){return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g font-family="Microsoft JhengHei,Arial">${body}</g></svg>`,{font:FONT}).render().pixels;}
function sprite(file,w,h,mirror=false){const key=`${file}:${w}:${h}:${mirror}`;if(!sprites.has(key)){const bytes=fs.readFileSync(path.join(ROOT,file));const body=`<image href="data:image/png;base64,${bytes.toString('base64')}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMax meet" ${mirror?`transform="translate(${w},0) scale(-1,1)"`:''}/>`;sprites.set(key,{data:svgPixels(body,w,h),w,h});}return sprites.get(key);}
function blit(dst,src,x=0,y=0,opacity=1){x=Math.round(x);y=Math.round(y);for(let sy=0;sy<src.h;sy++){const yy=sy+y;if(yy<0||yy>=HEIGHT)continue;for(let sx=0;sx<src.w;sx++){const xx=sx+x;if(xx<0||xx>=WIDTH)continue;const i=(sy*src.w+sx)*4,j=(yy*WIDTH+xx)*4,a=src.data[i+3]/255*opacity;if(!a)continue;for(let c=0;c<3;c++)dst[j+c]=Math.round(src.data[i+c]*a+dst[j+c]*(1-a));dst[j+3]=255;}}}
function dot(dst,x,y,r,color,opacity=.8){for(let yy=Math.max(0,Math.floor(y-r));yy<Math.min(HEIGHT,Math.ceil(y+r));yy++)for(let xx=Math.max(0,Math.floor(x-r));xx<Math.min(WIDTH,Math.ceil(x+r));xx++){const distance=Math.hypot(xx-x,yy-y);if(distance>r)continue;const a=opacity*(1-distance/r);const i=(yy*WIDTH+xx)*4;for(let c=0;c<3;c++)dst[i+c]=Math.round(dst[i+c]*(1-a)+color[c]*a);}}
function stroke(dst,x1,y1,x2,y2,color,width=3,opacity=.9){const n=Math.max(1,Math.ceil(Math.hypot(x2-x1,y2-y1)));for(let i=0;i<=n;i++){const t=i/n;dot(dst,x1+(x2-x1)*t,y1+(y2-y1)*t,width,color,opacity);}}
function ring(dst,x,y,r,color){for(let a=0;a<Math.PI*2;a+=.045)dot(dst,x+Math.cos(a)*r,y+Math.sin(a)*r,3,color,.7);}
function text(s,x,y,size=16,color='#efe2bc',anchor='start'){return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${xml(s)}</text>`;}
function meter(x,y,w,hp,max){const pct=Math.max(0,Math.min(1,hp/Math.max(1,max)));return `<rect x="${x}" y="${y}" width="${w}" height="7" rx="2" fill="#172c3e"/><rect x="${x}" y="${y}" width="${w*pct}" height="7" rx="2" fill="${pct<.25?'#ef8174':'#80d4b1'}"/>`;}
export function battleKey(kind,p){return kind==='pk'?`pk:${p.id}:${p.decidedAt||p.status}`:`party:${p.id}:${p.battleTurn?.id||'entry'}:${p.status}`;}
const actualHpChanges=(before,after)=>(after?.members||[]).flatMap(a=>{const old=before?.members?.find(m=>String(m.id)===String(a.id));return old&&Number.isFinite(old.hp)&&Number.isFinite(a.hp)?[{id:a.id,delta:a.hp-old.hp}]:[];});
function resolvedPartyEvent(e,before){
 const changes=actualHpChanges(before,e.after),healing=changes.filter(a=>a.delta>0).map(a=>({id:a.id,healed:a.delta}));
 const damage=Number.isFinite(before?.enemyHp)&&Number.isFinite(e.after?.enemyHp)?Math.max(0,before.enemyHp-e.after.enemyHp):0;
 return {...e,before,damage,healed:healing.reduce((sum,a)=>sum+a.healed,0),healing,...(healing.length?{targets:healing.map(a=>a.id)}:{}),...(e.actorId==='boss'?{hits:changes.map(a=>({id:a.id,damage:Math.max(0,-a.delta)}))}:{})};
}
export function buildBattleScene(kind,p){
 if(kind==='pk'){
  if(p.status!=='done'||!p.log?.steps?.length)throw new Error('PK animation requires a resolved server replay');
  const actors=['a','b'].map((id,i)=>({id,name:p[id].name,base:p[id].baseClass,gender:p[id].gender,classPath:p[id].classPath,maxHp:p.log.max[id],x:i?490:105,w:135,h:205,mirror:!!i}));
  let hp={...p.log.max,...p.log.initial?.hp},mp={...p.log.initial?.mp};
  const snapshot=()=>({members:actors.map(a=>({id:a.id,hp:hp[a.id],maxHp:a.maxHp,...(Number.isFinite(mp[a.id])?{mp:mp[a.id],maxMp:p.log.maxMp?.[a.id]}:{})}))});
  const initial=snapshot();
  const all=p.log.steps.map((e,i)=>{
   for(const id of ['a','b']){if(Number.isFinite(e.before?.hp?.[id]))hp[id]=e.before.hp[id];if(Number.isFinite(e.before?.mp?.[id]))mp[id]=e.before.mp[id];}
   const before=snapshot(),target=e.by==='a'?'b':'a';
   if(Number.isFinite(e.hp))hp[target]=e.hp;if(Number.isFinite(e.self))hp[e.by]=e.self;
   for(const id of ['a','b']){if(Number.isFinite(e.after?.hp?.[id]))hp[id]=e.after.hp[id];if(Number.isFinite(e.after?.mp?.[id]))mp[id]=e.after.mp[id];}
   const after=snapshot(),healing=actualHpChanges(before,after).filter(a=>a.delta>0).map(a=>({id:a.id,healed:a.delta}));
   return {actorId:e.by,targetId:target,base:p[e.by].baseClass,label:e.skill?'職業技能':'普通攻擊',damage:Math.max(0,before.members.find(a=>a.id===target).hp-hp[target]),healed:healing.reduce((sum,a)=>sum+a.healed,0),healing,targets:healing.map(a=>a.id),crit:e.crit,turn:i+1,before,after};
  });
  const events=all.length>6?[...all.slice(0,2),...all.slice(-4)]:all;
  return {kind,title:'群組 PK · 真實戰況回放',subtitle:`${p.a.name} VS ${p.b.name}`,map:2,actors,events,before:initial,after:{members:actors.map(a=>({id:a.id,hp:p.log.hp[a.id],maxHp:a.maxHp}))},result:`${p[p.winner].name} 勝利 · ${p.rounds} 回合${all.length>6?'（關鍵交鋒）':''}`,status:'won'};
 }
 // A floor-clear replay belongs to the defeated enemy, never the newly spawned floor.
 const candidate=p.battleTurn,legacyFloorChange=candidate&&candidate.floor!==p.floor&&!Number.isFinite(candidate.before?.enemyMaxHp);
 const turn=legacyFloorChange?null:candidate,theme=battleTheme({...p,floor:turn?.floor||p.floor,enemy:{...p.enemy,name:turn?.before?.enemyName||p.enemy?.name}});
 const actors=p.members.map((m,i)=>({id:m.id,name:m.name,base:m.base,gender:m.gender,classPath:m.classPath,maxHp:m.maxHp||1,x:22+i*136,w:140,h:205}));
 if(!actors.length)throw new Error('Party animation requires members');
 const before=turn?.before||{enemyHp:p.enemy?.hp||0,members:p.members.map(m=>({id:m.id,hp:m.hp??m.maxHp??1,maxHp:m.maxHp||1}))};
 let previous=before;
 const events=(turn?.events||[]).slice(0,6).map(e=>{const step=resolvedPartyEvent(e,previous);previous=e.after||previous;return step;});
 return {kind:'party',title:p.name,subtitle:p.kind==='tower'?`第 ${turn?.floor||p.floor} 層 · 第 ${turn?.round||p.round} 回合`:`第 ${turn?.round||p.round} 回合 · 三人合作`,map:Math.max(1,Math.min(12,Number(p.map)||2)),actors,events,before,background:theme.background,themeId:theme.id,accent:theme.accent,after:turn?.after||before,boss:{x:492,w:190,h:230,maxHp:before.enemyMaxHp||p.enemy?.maxHp||1,name:before.enemyName||p.enemy?.name||theme.name,file:theme.boss},result:p.status==='won'?'討伐成功 · 戰利品解鎖':p.status==='lost'?'挑戰失敗 · 再接再厲':turn?.after.enemyHp===0?'擊敗守衛 · 繼續攀登':turn?'回合結算完成 · 選擇下一次戰術':legacyFloorChange?'已同步最新戰況':'三位英雄集結 · 首領戰開始',status:p.status};
}
export function battleReplayLabel(scene,event,hit,terminal=false){
 if(terminal)return scene.result;
 if(!event)return '戰鬥開始 · 英雄集結';
 const actor=scene.actors.find(a=>a.id===event.actorId);
 return `${event.actorId==='boss'?'首領':actor?.name||'持續效果'} · ${event.label||'回合結算'}${hit&&event.healed?` · 治療 +${event.healed}`:''}${hit&&event.shielded?` · 護盾 +${event.shielded}`:''}`;
}
function prepare(scene){
 const background=sprite(scene.background||`map${String(scene.map).padStart(2,'0')}.png`,WIDTH,HEIGHT);const base=Uint8Array.from(background.data);
 const shade={data:svgPixels('<rect width="720" height="405" fill="#061420" fill-opacity=".33"/><rect width="720" height="84" fill="#071727" fill-opacity=".86"/><rect y="306" width="720" height="99" fill="#071727" fill-opacity=".91"/>'+text('星穹旅誌 · 群組戰況',22,22,12,'#d7b777')+text(scene.title,22,49,24)+text(scene.subtitle,22,73,15,'#b8d8e4')),w:WIDTH,h:HEIGHT};blit(base,shade);
 const images=new Map(scene.actors.map(a=>[a.id,sprite(battleHeroAsset(a).file,a.w,a.h,a.mirror)]));if(scene.boss)images.set('boss',sprite(scene.boss.file,scene.boss.w,scene.boss.h));return {base,images,stamps:new Map()};
}
function hud(scene,ctx,snapshot,label,key){if(!ctx.stamps.has(key)){let body='';for(const a of scene.actors){const s=snapshot.members?.find(x=>x.id===a.id)||{hp:a.maxHp,maxHp:a.maxHp};body+=text(a.name.slice(0,9),a.x+4,326,14)+meter(a.x+4,335,a.w-10,s.hp,s.maxHp)+text(`${Math.max(0,s.hp)} / ${s.maxHp}`,a.x+4,358,12,'#b5d7d2');}if(scene.boss)body+=text(scene.boss.name||'首領',scene.boss.x+4,326,14,'#f0b18e')+meter(scene.boss.x+4,335,scene.boss.w-12,snapshot.enemyHp??0,scene.boss.maxHp)+text(`${Math.max(0,snapshot.enemyHp??0)} / ${scene.boss.maxHp}`,scene.boss.x+4,358,12,'#eec2b2');body+=text(label.slice(0,42),WIDTH/2,390,17,'#f5df9a','middle');ctx.stamps.set(key,{data:svgPixels(body),w:WIDTH,h:HEIGHT});}return ctx.stamps.get(key);}
function draw(scene,ctx,event,t,index,terminal=false){
 const out=Uint8Array.from(ctx.base),hit=t>=.5;const active=scene.actors.find(a=>a.id===event?.actorId);const enemy=scene.boss||scene.actors.find(a=>a.id===event?.targetId);const support=event&&!event.damage&&(event.healed||event.shielded||event.skillId==='defend'||event.revived);
 for(const a of scene.actors){let dx=0,dy=0;if(active?.id===a.id&&!support)dx=(a.mirror?-1:1)*Math.sin(t*Math.PI)*28;if(event?.actorId==='boss'&&hit&&!event.interrupted||a.id===event?.targetId&&hit&&event.damage)dx+=Math.sin(t*30)*5;const state=(terminal?scene.after:hit?event?.after:event?.before)||scene.before;const fallen=state.members?.find(m=>m.id===a.id)?.hp===0;if(fallen)dy=20;blit(out,ctx.images.get(a.id),a.x+dx,306-a.h+dy,fallen?.45:1);}
 if(scene.boss)blit(out,ctx.images.get('boss'),scene.boss.x+(event?.actorId==='boss'?Math.sin(t*Math.PI)*-25:hit&&event?.damage?Math.sin(t*30)*5:0),306-scene.boss.h,terminal&&scene.after.enemyHp===0?.3:1);
 if(event){const color=active?.base==='mage'?[184,113,255]:active?.base==='archer'?[114,235,182]:[255,205,112];const ax=active?active.x+active.w/2:scene.boss?scene.boss.x+95:350,ay=208;
  if(event.interrupted){ring(out,scene.boss.x+95,210,35+12*Math.sin(t*Math.PI),[130,214,255]);stroke(out,scene.boss.x+65,180,scene.boss.x+125,240,[255,140,130],4);}
  else if(event.actorId==='boss'){const bossX=scene.boss.x+95;const hue=scene.accent?scene.accent.slice(1).match(/../g).map(x=>parseInt(x,16)):[245,108,95];ring(out,bossX,220,35+45*t,event.windup?[255,105,83]:[255,189,94]);for(const a of scene.actors.filter(a=>!event.hits||event.hits.some(h=>h.id===a.id))){const x=a.x+a.w/2,y=245;
   if(scene.themeId==='forge'||scene.themeId==='titan'){stroke(out,bossX,220,x,270,hue,4,.6);if(hit){ring(out,x,273,18+35*t,hue);for(let i=0;i<7;i++)stroke(out,x,270,x+Math.cos(i)*40*t,270-Math.abs(Math.sin(i))*55*t,hue,3,.8);}}
   else if(scene.themeId==='river'){for(let i=0;i<3;i++)ring(out,x,y-10+i*13,16+28*t,hue);stroke(out,bossX,215,x,y,hue,5,.6);}
   else if(scene.themeId==='oracle'){const q=Math.min(1,t*1.7),px=bossX+(x-bossX)*q;dot(out,px,210,19,hue,.8);ring(out,px,210,20+8*Math.sin(t*Math.PI),hue);}
   else if(scene.themeId==='trial3'||scene.themeId==='trial4'){for(let i=0;i<5;i++){const q=Math.min(1,t*1.6),px=bossX+(x-bossX)*q;stroke(out,px+25,160+i*20,px,180+i*20,hue,3,.8);}}
   else stroke(out,bossX,205,x,240,hue,4,.7);
   if(hit){dot(out,x,230,35,hue,.8);const value=event.hits?.find(h=>h.id===a.id)?.damage;if(value!=null){const k='bossDamage:'+index+':'+a.id;if(!ctx.stamps.has(k))ctx.stamps.set(k,{data:svgPixels(text('−'+value,90,30,22,'#fff2df','middle'),180,45),w:180,h:45});blit(out,ctx.stamps.get(k),x-90,150-20*t);}}
  }}
  else if(support){for(const id of event.targets||[event.targetId||event.actorId]){const a=scene.actors.find(x=>x.id===id);if(!a)continue;const color=event.healed||event.revived?[116,255,177]:[115,205,255];ring(out,a.x+70,213,32+12*Math.sin(t*Math.PI),color);dot(out,a.x+70,222,45,color,.5);if(event.healed)stroke(out,a.x+70,196,a.x+70,231,color,4);}}
  else if(!event.damage&&active){ring(out,ax,215,30+15*Math.sin(t*Math.PI),color);dot(out,ax,225,35,color,.4);}
  else if(enemy&&event.damage){const ex=enemy.x+enemy.w/2,ey=210,q=Math.min(1,t*1.7);if(active?.base==='sword'){stroke(out,ex-24,ey+35*(1-t),ex+24,ey-35*(1-t),color,5,.9);}else{const px=ax+(ex-ax)*q;stroke(out,px-26,ay,px,ey,color,active?.base==='archer'?3:8,.9);dot(out,px,ey,active?.base==='mage'?22:8,color,.9);}if(hit){dot(out,ex,ey,44*(1-t)+20,color,.85);ring(out,ex,ey,22+45*(t-.5),color);}}
  if(event.damage&&hit){const x=enemy?enemy.x+enemy.w/2:scene.boss?.x+90||500;const key=`damage:${index}`;if(!ctx.stamps.has(key))ctx.stamps.set(key,{data:svgPixels(text(`${event.crit?'爆擊 ':''}−${event.damage}`,100,35,25,event.crit?'#ffe389':'#fff2df','middle'),200,50),w:200,h:50});blit(out,ctx.stamps.get(key),x-100,130-25*t);}
 }
 if(!event&&!terminal){for(const a of scene.actors)ring(out,a.x+70,278,26+8*Math.sin(t*Math.PI),[220,184,108]);}
 if(terminal){const col=scene.status==='lost'?[230,110,110]:[255,214,125];for(let i=0;i<20;i++)dot(out,60+(i*37)%620,115+((i*29+Math.floor(t*60))%175),3,col,.85);}
 const snap=terminal?scene.after:(hit?event?.after:event?.before)||scene.before;const label=battleReplayLabel(scene,event,hit,terminal);blit(out,hud(scene,ctx,snap,label,terminal?'end':event?`${index}:${hit}`:'intro'));return out;
}
export function renderBattlePreview(kind,p,eventIndex=0,t=.7){const scene=buildBattleScene(kind,p),ctx=prepare(scene);return {data:draw(scene,ctx,scene.events[eventIndex],t,eventIndex),width:WIDTH,height:HEIGHT};}
export function encodeBattleAnimation(kind,p){const scene=buildBattleScene(kind,p),ctx=prepare(scene);const timeline=[...Array.from({length:4},(_,i)=>({t:i/3})),...scene.events.flatMap((e,index)=>Array.from({length:4},(_,i)=>({event:e,index,t:i/3}))),...Array.from({length:6},(_,i)=>({t:i/5,terminal:true}))];const gif=GIFEncoder();let palette,previous;
 for(const [i,frame]of timeline.entries()){const rgba=draw(scene,ctx,frame.event,frame.t,frame.index,frame.terminal);if(!palette){palette=[...quantize(rgba,240),[255,230,120],[255,120,100],[110,230,255],[125,255,180],[185,115,255],[255,245,225]];while(palette.length<255)palette.push([0,0,0]);palette.push([0,0,0]);}const full=applyPalette(rgba,palette.slice(0,255));const indexed=Uint8Array.from(full);if(previous)for(let j=0;j<indexed.length;j++)if(indexed[j]===previous[j])indexed[j]=255;gif.writeFrame(indexed,WIDTH,HEIGHT,{...(i===0?{palette}:{}),delay:120,repeat:0,dispose:1,transparent:i>0,transparentIndex:255});previous=full;}gif.finish();const buffer=gif.bytes();if(buffer.length>8*1024*1024)throw new Error('Battle animation exceeds upload budget');return buffer;
}
const pending=new Map(),cache=new Map();let queue=Promise.resolve();
export function renderBattleAnimation(kind,p){const key=battleKey(kind,p);if(cache.has(key))return Promise.resolve(cache.get(key));if(pending.has(key))return pending.get(key);if(pending.size>=6)return Promise.reject(new Error('Battle renderer queue is full'));const job=queue.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{const worker=new Worker(new URL(import.meta.url),{workerData:{kind,p},resourceLimits:{maxOldGenerationSizeMb:256}});const timer=setTimeout(()=>{worker.terminate();reject(new Error('Battle animation render timed out'));},60000);worker.once('message',bytes=>{clearTimeout(timer);const buffer=Buffer.from(bytes);cache.set(key,buffer);while(cache.size>8)cache.delete(cache.keys().next().value);resolve(buffer);});worker.once('error',e=>{clearTimeout(timer);reject(e);});worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`Battle renderer exited ${code}`));});}));pending.set(key,job);queue=job;job.finally(()=>pending.delete(key)).catch(()=>{});return job;}
if(!isMainThread&&workerData?.kind){try{const bytes=encodeBattleAnimation(workerData.kind,workerData.p);parentPort.postMessage(bytes,[bytes.buffer]);}catch(e){throw e;}}
