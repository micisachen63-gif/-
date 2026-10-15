import fs from 'node:fs';
import path from 'node:path';
import {Resvg} from '@resvg/resvg-js';
import {battleHeroAsset,battleBossAsset,battleTheme} from './rpg-battle-assets.js';
const artRoot=path.resolve(import.meta.dirname,'../art-runtime/rpg-party');
const cache=new Map();
const xml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function art(file){file=file.replace(".webp",".png");if(!cache.has(file)){const mime=file.endsWith('.png')?'image/png':'image/webp';cache.set(file,`data:${mime};base64,${fs.readFileSync(path.join(artRoot,file)).toString('base64')}`);}return cache.get(file);}
const img=(file,x,y,w,h)=>`<image href="${art(file)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMax meet"/>`;
const text=(value,x,y,size=26,color='#efdfbd')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${xml(value)}</text>`;
const meter=(x,y,width,pct,color)=>`<rect x="${x}" y="${y}" width="${width}" height="12" fill="#233c50"/><rect x="${x}" y="${y}" width="${width*Math.max(0,Math.min(1,pct))}" height="12" fill="${color}"/>`;
export function partyCaption(p){return `${p.kind==='tower'?'♜':'⚔️'} ${p.name}\n${p.kind==='tower'?`第 ${p.floor} 層｜`:''}第 ${p.round} 回合｜${{lobby:'招募中',combat:'冒險中',won:'通關成功',lost:'挑戰失敗',ended:'已結束'}[p.status]}\n${p.members.map(m=>`${m.ready?'✅':'○'} ${m.name} Lv.${m.level}${m.hp!=null?`｜HP ${m.hp}/${m.maxHp}`:''}${m.submitted?'｜已選戰術':''}`).join('\n')}\n${p.enemy&&p.status==='combat'?`首領 HP ${Math.max(0,p.enemy.hp)}/${p.enemy.maxHp}\n`:''}${p.log.slice(0,3).join('\n')}\n${p.status==='combat'?'未選戰術預設防禦；選技能可在此群組操作。':p.status==='lobby'?'三個不同 Telegram 帳號，全員準備後出發。':p.status==='won'?'各人按領取戰利品，技能寶物未使用可交易。':''}`.slice(0,1024);}
export function renderPartyCard(p){
 const theme=battleTheme(p),map=theme.background;
 let body=img(map,0,0,1600,900)+'<rect width="1600" height="900" fill="url(#shade)"/>';
 body+=text('小精靈 RPG · 群組冒險',65,65,30,'#d6b97b')+text(p.name,65,143,52)+text(`${p.kind==='tower'?`第 ${p.floor} 層 · `:''}第 ${p.round} 回合 · 隊伍 ${p.members.length}／3`,65,194,28,'#c2d8e5');
 body+=text({lobby:'等待英雄加入',combat:'隊伍正在冒險',won:'討伐成功 · 戰利品解鎖',lost:'挑戰失敗 · 再接再厲',ended:'冒險已結束'}[p.status],930,84,28,'#d6b97b');
 for(const [i,m] of p.members.entries()){body+=img(battleHeroAsset(m).file,75+i*265,270,270,350);body+=text(`${m.name} · Lv.${m.level}`,85+i*265,672,24);body+=meter(85+i*265,695,220,m.hp==null?1:m.hp/m.maxHp,'#88c6ab');body+=text(p.status==='lobby'?m.ready?'已準備':'等待準備':m.submitted?'已選戰術':m.hp===0?'倒地':'同行中',85+i*265,731,20,'#b6c9d6');}
 if(p.status!=='lobby'){body+=img(theme.boss,1040,235,430,420);if(p.enemy)body+=meter(930,118,570,p.enemy.hp/p.enemy.maxHp,'#d88f78')+text(`首領 HP ${Math.max(0,Math.round(p.enemy.hp/p.enemy.maxHp*100))}%`,930,176,28);}
 body+='<rect x="65" y="760" width="1470" height="104" rx="8" fill="#172a3cf0"/>'+text(p.log[0]?.slice(0,50)||'三人共同冒險',90,802,25)+text('正式角色 · 伺服器同步 · 每回合選擇一次行動',90,842,20,'#a9bfcd');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="shade" x2="0" y2="1"><stop stop-color="#061420" stop-opacity=".85"/><stop offset=".4" stop-color="#061420" stop-opacity=".2"/><stop offset="1" stop-color="#071420" stop-opacity=".96"/></linearGradient></defs><g font-family="Microsoft JhengHei,Arial">${body}</g></svg>`;
 return Buffer.from(new Resvg(svg,{font:{loadSystemFonts:false,fontFiles:['C:/Windows/Fonts/msjh.ttc','C:/Windows/Fonts/arial.ttf'],defaultFontFamily:'Microsoft JhengHei'}}).render().asPng());
}

