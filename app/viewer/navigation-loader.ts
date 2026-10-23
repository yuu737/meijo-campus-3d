import {GroundField,WalkMesh,type PreparedWalkMesh,type GroundData} from './navigation';
export function loadNavigation(asset:{url:string;sha256:string;policy?:string},modelHash:string,signal:AbortSignal):Promise<WalkMesh|GroundField>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}
    const worker=new Worker(new URL('./navigation-worker.ts',import.meta.url),{type:'module'});
    let settled=false;
    const cleanup=()=>{worker.terminate();clearTimeout(timer);signal.removeEventListener('abort',cancel);};
    const fail=(error:Error)=>{if(settled)return;settled=true;cleanup();reject(error);};
    const cancel=()=>fail(new DOMException('Aborted','AbortError'));
    const timer=window.setTimeout(()=>fail(new Error('Navigation worker timed out')),120_000);
    signal.addEventListener('abort',cancel,{once:true});
    worker.onerror=()=>fail(new Error('Navigation worker failed'));
    worker.onmessage=(event:MessageEvent<{kind:string;prepared?:PreparedWalkMesh;data?:GroundData;message?:string}>)=>{
      if(settled)return;
      try{
        const data=event.data;
        if(data.kind==='error')throw new Error(data.message);
        const ground=data.kind==='mesh'&&data.prepared?new WalkMesh(data.prepared.spec,data.prepared):data.kind==='legacy'&&data.data?new GroundField(data.data):null;
        if(!ground)throw new Error('Invalid worker result');
        settled=true;cleanup();resolve(ground);
      }catch(error){fail(error instanceof Error?error:new Error('Navigation failed'));}
    };
    worker.postMessage({...asset,modelHash});
  });
}
