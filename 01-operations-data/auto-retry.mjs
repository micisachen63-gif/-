export const MAX_AUTO_RETRIES=2;
export const AUTO_RETRY_DELAY_MS=2*60*1000;

// A startup failure before the first platform cannot have written any report data.
export function canRetryStartupFailure(status){
 return status?.mode==='apply'&&status.completed===false&&Array.isArray(status.platforms)
  &&status.platforms.length===0&&Boolean(status.error);
}

// Retry only a complete same-day run with failed platforms. The existing resume
// path re-reads live sheets and verifies cells before writing any missing values.
export function failedPlatformKeys(status,configuredPlatforms){
 if(status?.completed||!Array.isArray(status?.platforms)||!Array.isArray(configuredPlatforms))return null;
 if(status.platforms.length!==configuredPlatforms.length)return null;
 const failed=[];
 for(const platform of configuredPlatforms){
  const matches=status.platforms.filter(result=>result.platform===platform.name);
  if(matches.length!==1)return null;
  const result=matches[0];
  if(result.state==='failed')failed.push(platform.key);
  else if(result.state!=='verified'||result.warnings?.length)return null;
 }
 return failed.length?failed:null;
}
