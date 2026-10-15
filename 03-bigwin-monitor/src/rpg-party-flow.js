import {renderPartyCard,partyCaption} from './rpg-party-card.js';
import {renderBattleAnimation,battleKey} from './rpg-battle-animation.js';
const codes=new Set(['pj','py','pg','pl','ps','pt','px','pz','pv','pr','bt']);
const btn=(text,data)=>({text,callback_data:`rpg:${data}`});
export function createPartyFlow({api,client,send,popup,st,save,chatId,deepLink,appBtn,now,warn,animationRenderer=renderBattleAnimation}){
 const dirty=new Map(),inflight=new Map();
 function keyboard(p){let rows=[];if(p.status==='lobby')rows=[[btn('加入隊伍',`pj:${p.id}`),btn('我已準備',`py:${p.id}`)],[btn('隊長出發',`pg:${p.id}`),btn('離隊',`pl:${p.id}`)]];
 else if(p.status==='combat'&&(p.kind!=='tower'||p.floor%5===0))rows=[[btn('普通攻擊',`px:${p.id}.${p.round}`),btn('我的技能／隊友目標',`ps:${p.id}`)]];
 else if(p.status==='won')rows=[[btn('領取戰利品',`pr:${p.id}`)]];
 if(p.status==='combat')rows.push([btn('離隊並中止挑戰',`pl:${p.id}`)]);
 const url=deepLink(`party_${p.id}`);rows.push([btn('更新進度',`pv:${p.id}`),...(url?[{text:'打開隊伍畫面',url}]:[])]);return rows;
 }
 async function render(p,force=false){
  if(inflight.has(p.id)){const old=dirty.get(p.id);if(!old||old.rev<p.rev)dirty.set(p.id,p);return;}
  const task=renderNow(p,force);inflight.set(p.id,task);try{await task;}finally{inflight.delete(p.id);}
 }
 async function renderNow(p,force=false){
  const cards=st().partyCards??={};let c=cards[p.id];if(!c&&p.messageId)c=cards[p.id]={chatId:p.chatId||chatId,messageId:p.messageId,photo:true,lastRev:-1,lastEdit:0};
  if(c&&c.lastRev>p.rev)return;
  const animated=typeof api.sendAnimation==='function'&&typeof api.editMessageMedia==='function'&&p.enemy&&['combat','won','lost'].includes(p.status);
  const key=animated?battleKey('party',p):null,needsAnimation=animated&&c?.lastAnimationKey!==key;
  if(c&&c.lastRev>=p.rev&&!needsAnimation)return;
  if(c&&!force&&now()-(c.lastEdit||0)<5000){dirty.set(p.id,p);return;}
  const caption=partyCaption(p),markup={inline_keyboard:keyboard(p)};
  const defer=needsAnimation&&c&&p.status==='combat'&&now()-(c.lastAnimationAt||0)<10000;
  let animation;if(needsAnimation&&!defer){try{animation=await animationRenderer('party',p);}catch(e){warn('party animation',e);}}
  if(!c){let m,photo=false;if(animation){try{m=await api.sendAnimation({chatId,buffer:animation,mimeType:'image/gif',fileName:`${p.id}.gif`,caption,replyMarkup:markup});photo=true;}catch(e){animation=null;warn('party animation upload',e);}}
   if(!m&&typeof api.sendPhoto==='function'){try{m=await api.sendPhoto({chatId,buffer:renderPartyCard(p),mimeType:'image/png',fileName:`${p.id}.png`,caption,replyMarkup:markup});photo=true;}catch(e){warn('party art',e);}}
   if(!m)m=await send(caption,{reply_markup:markup},chatId);const mid=m?.message_id??m?.result?.message_id;if(!mid)throw Error('Telegram did not confirm party message');
   c=cards[p.id]={chatId,messageId:mid,photo,animation:!!animation,lastRev:p.rev,lastEdit:now(),...(animation?{lastAnimationKey:key,lastAnimationAt:now()}:{})};save();await client.call('/rpg/party/message',{partyId:p.id,chatId,messageId:mid});
  }else{
   try{if(animation){try{await api.editMessageMedia({chatId:c.chatId,messageId:c.messageId,buffer:animation,mimeType:'image/gif',fileName:`${p.id}.gif`,mediaType:'animation',caption,replyMarkup:markup});c.photo=true;c.animation=true;c.lastAnimationKey=key;c.lastAnimationAt=now();}catch(e){warn('party animation upload',e);animation=null;if(c.photo||c.animation)await api.call('editMessageCaption',{chat_id:c.chatId,message_id:c.messageId,caption,reply_markup:markup});else await api.call('editMessageText',{chat_id:c.chatId,message_id:c.messageId,text:caption,reply_markup:markup});}}
    else if(c.animation)await api.call('editMessageCaption',{chat_id:c.chatId,message_id:c.messageId,caption,reply_markup:markup});
    else if(c.photo&&typeof api.editMessageMedia==='function')await api.editMessageMedia({chatId:c.chatId,messageId:c.messageId,buffer:renderPartyCard(p),mimeType:'image/png',fileName:`${p.id}.png`,caption,replyMarkup:markup});
    else await api.call(c.photo?'editMessageCaption':'editMessageText',{chat_id:c.chatId,message_id:c.messageId,...(c.photo?{caption}:{text:caption}),reply_markup:markup});
   }catch(e){if(!/not modified/i.test(String(e.message||e.description)))throw e;}
   c.lastRev=p.rev;c.lastEdit=now();save();
  }if(defer)dirty.set(p.id,p);else if(!dirty.has(p.id)||dirty.get(p.id).rev<=p.rev)dirty.delete(p.id);
 }
 async function handle(cq,action,arg){if(!codes.has(action))return null;const tg=String(cq.from.id),requestId=`party-cq-${cq.id}`;try{
  if(action==='bt'){const [ownerId,skillId]=arg.split('.');const r=await client.call('/rpg/expedition/trade',{tgId:tg,ownerId,skillId,requestId});const a=appBtn('確認技能寶物交易',`trade_${r.tradeId}`);await send('交易視窗已開啟。物品不會自動轉移，請雙方放入、鎖定並確認。',a?{reply_markup:{inline_keyboard:[[a]]}}:{},tg);await popup(cq,'交易視窗已私訊，請雙方確認',false);return {rpg:'book-trade'};}
  const [id,round,skillId,targetIndex]=String(arg).split('.');let p=(await client.call('/rpg/party/get',{partyId:id,tgId:tg})).party;
  if(action==='pv'){await popup(cq,'進度已更新',false);await render(p,true);return {rpg:'party-refresh'};}
  if(action==='ps'||action==='pt'){
   if(!p.me?.actor||p.me.actor.hp<=0)throw Error('你目前不能施放隊伍技能');const me=p.me.actor;
   if(action==='pt'){
    const buttons=p.members.map((m,i)=>[btn(`${m.name}${m.hp===0?'（倒地）':''}`,`pz:${id}.${round}.${skillId}.${i}`)]);
    await api.call('editMessageText',{chat_id:cq.message.chat.id,message_id:cq.message.message_id,text:'選擇施放的隊友目標（隊伍技能會對全隊生效）：',reply_markup:{inline_keyboard:buttons}});
   }else{
    const skills=(await client.call('/rpg/expedition/me',{tgId:tg})).skills;const buttons=me.special.loadout.map(id=>{const s=skills.find(s=>s.id===id);return [btn(`${s.name}｜MP ${s.mp}`,`pt:${p.id}.${p.round}.${s.id}`)];});buttons.push([btn('防禦 · 不耗魔',`pz:${p.id}.${p.round}.defend.0`)]);
    await send(`第 ${p.round} 回合｜${me.name} MP ${me.mp}/${me.maxMp}\n選技能，再選擇隊友；結算前可改選。`,{reply_markup:{inline_keyboard:buttons}},tg);
   }await popup(cq,action==='ps'?'技能選單已私訊，選完後返回群組':'請選隊友',false);return {rpg:'party-skill-menu'};
  }
  let r;if(action==='pr')r=await client.call('/rpg/party/reward',{tgId:tg,partyId:id,requestId});
  else{const op={pj:'join',py:'ready',pg:'start',pl:'leave',px:'submit',pz:'submit'}[action];if(!op)throw Error('操作無效');r=await client.call('/rpg/party/action',{tgId:tg,partyId:id,op,requestId,round:Number(round),skillId:action==='px'?'attack':skillId,targetId:targetIndex!=null?p.members[Number(targetIndex)]?.id:undefined});}
  await popup(cq,{pj:'已加入隊伍',py:'已準備',pg:'隊伍出發',pl:'已離隊',px:'普通攻擊已選擇',pz:'技能／戰術已選擇',pr:'戰利品已領入正式背包'}[action],false);if(r.party)await render(r.party);return {rpg:'party-action',action};
 }catch(e){await popup(cq,e.message);return {rpg:'party-failed',error:e.code};}}
 async function deliver(item){if(item.kind==='party_card'&&item.payload?.party){await render(item.payload.party);return true;}if(item.kind==='skill_book'){
  const p=item.payload,s=p.skill;const callback=`bt:${p.ownerId}.${s.id}`;await send(`📖 ${p.name}分享「${s.bookType} · ${s.name}」\n${s.eligibleJob} Lv.${s.level}\n${s.damage}｜${s.effect}\nMP ${s.mp}｜冷卻 ${s.cooldownSeconds} 秒\n未使用，可以交易；需雙方鎖定與確認。`,{reply_markup:{inline_keyboard:[[btn('我要交易',callback)]]}},chatId);return true;}return false;
 }
 async function flush(){for(const [id,p] of dirty){if(now()-(st().partyCards?.[id]?.lastEdit||0)<5000)continue;await render(p,true).catch(e=>warn('party refresh',e));}}
 return {handle,deliver,flush};
}
