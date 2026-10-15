// Wrap a borrowed browser context: closing this facade must not close user tabs.
export function borrowedContext(connection,context){
 const owned=new Set();let disconnected=false;
 return new Proxy(context,{get(target,key){
  if(key==='newPage')return async(...args)=>{const page=await target.newPage(...args);owned.add(page);return page;};
  if(key==='close')return async()=>{if(disconnected)return;disconnected=true;for(const p of owned)if(!p.isClosed())await p.close().catch(()=>{});await connection.close();};
  const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
 }});
}
