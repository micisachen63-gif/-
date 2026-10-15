import {isLocalMaintenanceRequest} from './local-maintenance.js';

export function maintenanceRoute({text,userId,ownerId,provider,current,hasAttachments=false}){
  if(String(userId)!==String(ownerId)||hasAttachments||/^\/chat\b/.test(text))return 'chat';
  if(provider)return 'start';
  if(current?.status==='running')return 'status';
  const newTask=/(新任務|另一個任務|另外.{0,8}(新增|建立|創建))/.test(text);
  if(current&&['failed','rollback_failed'].includes(current.status)&&!newTask)return 'resume';
  return isLocalMaintenanceRequest(text)||newTask?'choose':'chat';
}
