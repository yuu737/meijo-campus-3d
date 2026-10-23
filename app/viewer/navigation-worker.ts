import {WalkMesh, type WalkMeshData, type GroundData} from './navigation';
type Request={url:string;sha256:string;modelHash:string;policy?:string};
const scope=globalThis as unknown as {onmessage:((e:MessageEvent<Request>)=>void)|null;postMessage:(data:unknown,transfer?:Transferable[])=>void;location:Location};
scope.onmessage=async ({data:request})=>{
  try {
    const url=new URL(request.url,scope.location.href);
    if(url.origin!==scope.location.origin||!url.pathname.startsWith('/viewer/assets/'))throw new Error('Invalid navigation URL');
    const response=await fetch(url);
    if(!response.ok)throw new Error(`Navigation HTTP ${response.status}`);
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength>256*1024*1024)throw new Error('Navigation is too large');
    const digest=await crypto.subtle.digest('SHA-256',buffer);
    const hex=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(hex!==request.sha256)throw new Error('Navigation integrity failure');
    const bytes=new Uint8Array(buffer);
    const text=bytes[0]===31&&bytes[1]===139
      ?await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      :new TextDecoder().decode(buffer);
    const data:WalkMeshData|GroundData=JSON.parse(text);
    if(data.schema==='tempaku-walk-2'){
      if(request.policy==='authored-surfaces-v1'&&(data.policy!==request.policy||data.capturedCollisionObjects!==0||data.sourceModelSha256!==request.modelHash))throw new Error('Navigation/model mismatch');
      const prepared=new WalkMesh(data).prepare();
      scope.postMessage({kind:'mesh',prepared},[prepared.vertices.buffer,prepared.support.buffer,prepared.blockers.buffer]);
    } else if(data.schema==='tempaku-ground-1')scope.postMessage({kind:'legacy',data});
    else throw new Error('Unsupported navigation schema');
  } catch(error){scope.postMessage({kind:'error',message:error instanceof Error?error.message:'Navigation failed'});}
};
