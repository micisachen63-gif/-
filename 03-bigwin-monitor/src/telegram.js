import { sleep } from './util.js';

export class TelegramError extends Error {
  constructor(method, status, result) {
    super(`Telegram ${method} 失敗：HTTP ${status} ${result?.error_code ?? ''} ${result?.description ?? ''}`.trim());
    this.name = 'TelegramError';
    this.method = method;
    this.httpStatus = status;
    this.errorCode = result?.error_code;
    this.description = String(result?.description ?? '');
    this.parameters = result?.parameters;
    /** Telegram answered ok:false: the request definitely did NOT take effect. */
    this.definite = true;
  }
}

export class TelegramNetworkError extends Error {
  constructor(method, cause) {
    super(`Telegram ${method} 連線失敗或逾時：${cause?.name === 'TimeoutError' ? 'timeout' : (cause?.message || cause)}`);
    this.name = 'TelegramNetworkError';
    this.method = method;
    /** We cannot know whether the request took effect. */
    this.definite = false;
  }
}

/** Thin Bot API client. The token only lives inside the closure; errors never contain it. */
export function createTelegramApi(token, { fetchImpl = fetch, defaultTimeoutMs = 20000 } = {}) {
  async function call(method, body = {}, { timeoutMs = defaultTimeoutMs, retries429 = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new TelegramNetworkError(method, error);
      }
      let result;
      try { result = await response.json(); } catch { result = { ok: false, description: 'invalid JSON response' }; }
      if (result.ok === true) return result.result;
      if (result.error_code === 429 && attempt < retries429) {
        await sleep(Math.min(60, Number(result.parameters?.retry_after) || 5) * 1000 + 250);
        continue;
      }
      throw new TelegramError(method, response.status, result);
    }
  }
  async function downloadFile(fileId,{maxBytes=20*1024*1024,fileName,mimeType}={}){
    const file=await call('getFile',{file_id:fileId});const filePath=String(file?.file_path||'');
    if(!filePath||filePath.includes('..'))throw new Error('Telegram 檔案路徑無效');
    let response;try{response=await fetchImpl(`https://api.telegram.org/file/bot${token}/${filePath}`,{signal:AbortSignal.timeout(30000)});}catch(error){throw new TelegramNetworkError('downloadFile',error);}
    if(!response.ok)throw new Error(`Telegram 檔案下載失敗：HTTP ${response.status}`);
    const size=Number(response.headers?.get?.('content-length')||0);if(size>maxBytes)throw new Error('Telegram 檔案超過 20MB');
    const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>maxBytes)throw new Error('Telegram 檔案超過 20MB');
    const ext=(String(fileName||filePath).match(/\.([a-z0-9]{1,10})$/i)?.[1]||'bin').toLowerCase();
    const known={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',csv:'text/csv',txt:'text/plain',json:'application/json',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',zip:'application/zip'};
    return{buffer,mimeType:mimeType||known[ext]||'application/octet-stream',fileName:fileName||`telegram.${ext}`};
  }
  async function sendPhoto({chatId,buffer,photoUrl,mimeType='image/png',fileName='gpt-image.png',caption,parseMode,replyToMessageId,replyMarkup}){
    for (let attempt = 0; attempt < 3; attempt++) {
      const form=new FormData();form.set('chat_id',String(chatId));if(photoUrl)form.set('photo',String(photoUrl));else if(buffer)form.set('photo',new Blob([buffer],{type:mimeType}),fileName);else throw new TypeError('sendPhoto requires buffer or photoUrl');if(caption)form.set('caption',String(caption).slice(0,1024));if(parseMode)form.set('parse_mode',parseMode);if(replyToMessageId){form.set('reply_to_message_id',String(replyToMessageId));form.set('allow_sending_without_reply','true');}if(replyMarkup)form.set('reply_markup',JSON.stringify(replyMarkup));
      let response;
      try {
        response=await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});
      } catch(error) {
        if (attempt < 2) { await sleep(1500); continue; }
        throw new TelegramNetworkError('sendPhoto',error);
      }
      let result;try{result=await response.json();}catch{result={ok:false,description:'invalid JSON response'};}
      if(result.ok===true) return result.result;
      if(result.error_code === 429 && attempt < 2) { await sleep(3000); continue; }
      throw new TelegramError('sendPhoto',response.status,result);
    }
  }
  async function sendDocument({chatId,buffer,mimeType='application/octet-stream',fileName='gpt-file',caption,replyToMessageId}){
    const form=new FormData();form.set('chat_id',String(chatId));form.set('document',new Blob([buffer],{type:mimeType}),fileName);if(caption)form.set('caption',String(caption).slice(0,1024));if(replyToMessageId){form.set('reply_to_message_id',String(replyToMessageId));form.set('allow_sending_without_reply','true');}
    let response;try{response=await fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:form,signal:AbortSignal.timeout(120000)});}catch(error){throw new TelegramNetworkError('sendDocument',error);}
    let result;try{result=await response.json();}catch{result={ok:false,description:'invalid JSON response'};}if(result.ok!==true)throw new TelegramError('sendDocument',response.status,result);return result.result;
  }
  async function sendVideo({chatId,buffer,mimeType='video/mp4',fileName='grok-video.mp4',caption,replyToMessageId,replyMarkup}){
    const form=new FormData();form.set('chat_id',String(chatId));form.set('video',new Blob([buffer],{type:mimeType}),fileName);form.set('supports_streaming','true');if(caption)form.set('caption',String(caption).slice(0,1024));if(replyToMessageId){form.set('reply_to_message_id',String(replyToMessageId));form.set('allow_sending_without_reply','true');}if(replyMarkup)form.set('reply_markup',JSON.stringify(replyMarkup));
    let response;try{response=await fetchImpl(`https://api.telegram.org/bot${token}/sendVideo`,{method:'POST',body:form,signal:AbortSignal.timeout(180000)});}catch(error){throw new TelegramNetworkError('sendVideo',error);}
    let result;try{result=await response.json();}catch{result={ok:false,description:'invalid JSON response'};}if(result.ok!==true)throw new TelegramError('sendVideo',response.status,result);return result.result;
  }
  async function sendAnimation({chatId,buffer,mimeType='image/gif',fileName='animation.gif',caption,replyToMessageId,replyMarkup}){
    const form=new FormData();form.set('chat_id',String(chatId));form.set('animation',new Blob([buffer],{type:mimeType}),fileName);if(caption)form.set('caption',String(caption).slice(0,1024));if(replyToMessageId){form.set('reply_to_message_id',String(replyToMessageId));form.set('allow_sending_without_reply','true');}if(replyMarkup)form.set('reply_markup',JSON.stringify(replyMarkup));
    let response;try{response=await fetchImpl(`https://api.telegram.org/bot${token}/sendAnimation`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});}catch(error){throw new TelegramNetworkError('sendAnimation',error);}
    let result;try{result=await response.json();}catch{result={ok:false,description:'invalid JSON response'};}if(result.ok!==true)throw new TelegramError('sendAnimation',response.status,result);return result.result;
  }
  /** Replace a photo message's image (+ caption / buttons) in place, uploading the new image bytes. */
  async function editMessageMedia({chatId,messageId,buffer,mimeType='image/jpeg',fileName='photo.jpg',caption,replyMarkup,mediaType='photo'}){
    if(!['photo','animation','video'].includes(mediaType))throw new TypeError('Unsupported Telegram media type');
    const form=new FormData();form.set('chat_id',String(chatId));form.set('message_id',String(messageId));form.set('media',JSON.stringify({type:mediaType,media:'attach://upload',...(caption?{caption:String(caption).slice(0,1024)}:{}),...(mediaType==='video'?{supports_streaming:true}:{})}));form.set('upload',new Blob([buffer],{type:mimeType}),fileName);if(replyMarkup)form.set('reply_markup',JSON.stringify(replyMarkup));
    let response;try{response=await fetchImpl(`https://api.telegram.org/bot${token}/editMessageMedia`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});}catch(error){throw new TelegramNetworkError('editMessageMedia',error);}
    let result;try{result=await response.json();}catch{result={ok:false,description:'invalid JSON response'};}if(result.ok!==true)throw new TelegramError('editMessageMedia',response.status,result);return result.result;
  }
  return { call,downloadFile,sendPhoto,sendDocument,sendVideo,sendAnimation,editMessageMedia };
}

/** Send and verify the message really landed in the expected chat. */
export async function sendVerified(api, chatId, payload) {
  const msg = await api.call('sendMessage', { chat_id: chatId, ...payload });
  if (String(msg?.chat?.id) !== String(chatId)) {
    const err = new Error(`Telegram 回傳的 chat id 與設定不符（預期 ${chatId}，實際 ${msg?.chat?.id}）`);
    err.chatMismatch = true;
    err.messageId = msg?.message_id;
    throw err;
  }
  return msg;
}

export function isNotModified(error) {
  return error instanceof TelegramError && /message is not modified/i.test(error.description);
}
