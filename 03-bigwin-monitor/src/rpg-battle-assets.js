import fs from 'node:fs';
import path from 'node:path';
const manifest=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'../art-runtime/rpg-party/characters/manifest.json'),'utf8'));
const dungeons=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'../art-runtime/rpg-party/dungeons/manifest.json'),'utf8'));
export function battleHeroAsset(actor){
 const base=['sword','archer','mage'].includes(actor.base)?actor.base:'sword';
 const gender=actor.gender==='f'?'f':'m';
 const branch=/^[AB][12]{0,3}$/.test(actor.classPath||'')?actor.classPath:'';
 for(let tier=branch.length;tier>0;tier--){const key=`adv${tier}_${base}_${branch.slice(0,tier)}_${gender}`;if(manifest.heroes[key])return {...manifest.heroes[key],key};}
 const key=`${base}_${gender}`;return {...manifest.heroes[key],key};
}
export function battleBossAsset(map){const artMap=manifest.bosses[map]?Number(map):2;return {...manifest.bosses[artMap],artMap};}
export function battleTheme(p){
 const id=p.kind==='tower'?(p.floor>20?'stars':p.floor>10?'river':'pillar'):p.dungeonId;
 if(dungeons[id])return {id,name:dungeons[id].name,accent:dungeons[id].accent,boss:dungeons[id].bossPng,background:dungeons[id].backgroundPng};
 const map=id==='pillar'?2:id==='aegean'?4:p.map;
 return {id,name:p.enemy?.name||'首領',accent:'#efbf88',boss:battleBossAsset(map).file,background:`map${String(map||2).padStart(2,'0')}.png`};
}
