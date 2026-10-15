import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sendDailyTelegram} from '../daily_fortune/telegram.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const jobs={
  fortune:{label:'07:00 澄的運勢通知',log:'daily_fortune/logs'},
  digest:{label:'10:00／15:00 小精靈八卦通知',log:'daily_digest/logs'},
};

export function failureText(job,date){
  const item=jobs[job];
  if(!item||!/^\d{4}-\d{2}-\d{2}$/u.test(date||''))throw new Error('通知工作或日期無效。');
  return `🧚 小精靈卡關回報 ⚠️\n${date} 的${item.label}執行失敗，這次通知沒有確認送達。請查看電腦上的 ${item.log}/${date}.log；核對 TG 群組與執行紀錄後再處理，避免重複發送。小精靈會守住已完成的紀錄。`;
}

export async function alertFailure(job,date){
  const text=failureText(job,date);
  return sendDailyTelegram({date,text,sentStatePath:path.join(root,'state',`alert-${job}.json`)});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  alertFailure(process.argv[2],process.argv[3]).then(result=>{
    console.log(result.status==='already-sent'?'小精靈卡關通知已發過，略過。':'小精靈卡關通知已送達。');
  }).catch(error=>{console.error(`小精靈卡關通知失敗：${error.message}`);process.exitCode=1;});
}
