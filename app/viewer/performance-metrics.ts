/** Resource Timing separates actual network bytes from decoded asset estimates. */
export function transferMetrics(since=0){
  const entries=performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const selected=entries.filter(r=>r.startTime>=since);
  return {requests:selected.length,transferBytes:selected.reduce((n,r)=>n+r.transferSize,0),encodedBytes:selected.reduce((n,r)=>n+r.encodedBodySize,0),
    cachedRequests:selected.filter(r=>r.transferSize===0&&r.encodedBodySize>0).length,
    unavailableRequests:selected.filter(r=>r.transferSize===0&&r.encodedBodySize===0).length};
}

export function observePageExperience(){
  performance.setResourceTimingBufferSize(10000);
  const data={lcpMs:0,cls:0,longTasks:0,maxLongTaskMs:0,maxInteractionMs:0};
  let clusterStart=0,lastShift=0,clusterValue=0;
  const observers:PerformanceObserver[]=[];
  const observe=(type:string,callback:(entries:PerformanceEntry[])=>void)=>{
    if(!PerformanceObserver.supportedEntryTypes.includes(type))return;
    const observer=new PerformanceObserver(list=>{callback(list.getEntries());document.documentElement.dataset.pageExperience=JSON.stringify(data);});
    observer.observe({type,buffered:true,...(type==='event'?{durationThreshold:16}:{})});observers.push(observer);
  };
  observe('largest-contentful-paint',entries=>{data.lcpMs=entries[entries.length-1].startTime;});
  observe('layout-shift',entries=>{for(const e of entries){const shift=e as PerformanceEntry&{hadRecentInput:boolean;value:number};if(shift.hadRecentInput)continue;
    if(e.startTime-lastShift>1000||e.startTime-clusterStart>5000){clusterStart=e.startTime;clusterValue=0;}
    clusterValue+=shift.value;lastShift=e.startTime;data.cls=Math.max(data.cls,clusterValue);}});
  observe('longtask',entries=>{data.longTasks+=entries.length;data.maxLongTaskMs=Math.max(data.maxLongTaskMs,...entries.map(e=>e.duration));});
  observe('event',entries=>{data.maxInteractionMs=Math.max(data.maxInteractionMs,...entries.map(e=>e.duration));});
  // Lab observations only; the interaction maximum is not field INP/p75.
  return ()=>observers.forEach(observer=>observer.disconnect());
}
