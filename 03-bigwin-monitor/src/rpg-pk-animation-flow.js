import {renderBattleAnimation,battleKey} from './rpg-battle-animation.js';
// A resolved duel replaces its original challenge card; duplicate outbox events never repost it.
export function createPkAnimationFlow({api,client,send,editText,st,save,chatId,now,warn,text,keyboard,animationRenderer=renderBattleAnimation}){
 const running=new Map();
 async function render(p,options={}){const old=running.get(p.id)||Promise.resolve();const task=old.catch(()=>{}).then(()=>update(p,options));running.set(p.id,task);try{return await task;}finally{if(running.get(p.id)===task)running.delete(p.id);}}
 async function update(p,{post=false}={}){
  const cards=st().pcards??={};let c=cards[p.id];if(!c&&p.messageId)c=cards[p.id]={chatId:p.messageChatId||chatId,messageId:p.messageId};
  const caption=text(p),rows=keyboard(p),key=battleKey('pk',p);
  if(c?.status===p.status&&c?.caption===caption)return true;
  if(!c&&!post&&p.status!=='done')return false;
  let animated=false;
  if(p.status==='done'&&p.log?.steps?.length&&c?.animationKey!==key&&typeof api.sendAnimation==='function'&&typeof api.editMessageMedia==='function'){
   try{const buffer=await animationRenderer('pk',p);const args={chatId:c?.chatId||p.messageChatId||chatId,buffer,mimeType:'image/gif',fileName:`${p.id}.gif`,caption:caption.slice(0,1024),replyMarkup:{inline_keyboard:rows}};
    if(c)await api.editMessageMedia({...args,messageId:c.messageId,mediaType:'animation'});
    else{const m=await api.sendAnimation(args);if(!m?.message_id)throw new Error('Telegram did not confirm PK animation');c=cards[p.id]={chatId:args.chatId,messageId:m.message_id,at:now()};}
    animated=true;c.animation=true;c.animationKey=key;
   }catch(e){warn('pk animation',e);}
  }
  if(!animated){if(c){if(c.animation){try{await api.call('editMessageCaption',{chat_id:c.chatId,message_id:c.messageId,caption:caption.slice(0,1024),reply_markup:{inline_keyboard:rows}});}catch(e){if(!/not modified/i.test(String(e.message||e.description)))throw e;}}
    else await editText(c.chatId,c.messageId,caption,rows);
   }else{const cid=p.messageChatId||chatId,m=await send(caption,{reply_markup:{inline_keyboard:rows}},cid);if(!m?.message_id)throw new Error('Telegram did not confirm PK card');c=cards[p.id]={chatId:cid,messageId:m.message_id,at:now()};}
  }
  c.status=p.status;c.caption=caption;if(p.status!=='pending')c.doneAt=now();save();
  if(p.status==='pending'&&!p.messageId)await client.call('/rpg/pk/message',{pkId:p.id,chatId:c.chatId,messageId:c.messageId});
  const completed=Object.entries(cards).filter(([,v])=>v.doneAt!=null).sort(([,a],[,b])=>a.doneAt-b.doneAt);for(const [id]of completed.slice(0,Math.max(0,completed.length-120)))delete cards[id];save();return true;
 }
 return {render};
}
