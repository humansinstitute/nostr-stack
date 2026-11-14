/** Retry only an explicit broker rate-limit response; never repeat publication/network writes. */
export async function boundedBrokerRetry<T>(operation:()=>Promise<T>, options:{sleep?:(ms:number)=>Promise<void>;maxAttempts?:number;maxWaitMs?:number}={}):Promise<T>{
 const attempts=options.maxAttempts??3,budget=options.maxWaitMs??60000;
 let waited=0;
 for(let attempt=1;;attempt++){
  try{return await operation();}catch(error){
   const e=error as {name?:string;retryAfterMs?:number;metadata?:{code?:string}};
   if((e.name!=='CapabilityRateLimitError'&&e.metadata?.code!=='capability_rate_limited')||attempt>=attempts)throw error;
   const delay=Math.max(100,Math.ceil(Number(e.retryAfterMs))+100);
   if(!Number.isFinite(delay)||delay>30000||waited+delay>budget)throw error;
   waited+=delay;await (options.sleep??(ms=>new Promise(r=>setTimeout(r,ms))))(delay);
  }
 }
}
