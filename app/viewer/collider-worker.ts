type TileRequest={url:string;sha256:string;id:string;bytes:number};
const scope=globalThis as unknown as {onmessage:((e:MessageEvent<TileRequest>)=>void)|null;postMessage:(data:unknown,transfer?:Transferable[])=>void};
scope.onmessage=async({data:asset})=>{
  try{
    const response=await fetch(asset.url);
    if(!response.ok)throw new Error(`Collider HTTP ${response.status}`);
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength!==asset.bytes||buffer.byteLength>32*1024*1024)throw new Error('Collider size mismatch');
    const digest=await crypto.subtle.digest('SHA-256',buffer);
    if([...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')!==asset.sha256)throw new Error('Collider integrity failure');
    const text=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const data=JSON.parse(text);
    if(data.schema!=='tempaku-collider-tile-1'||data.policy!=='authored-surfaces-v1'||data.id!==asset.id)throw new Error('Invalid collider tile');
    const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0)).buffer;
    const positions=new Float32Array(decode(data.positions)),support=new Uint32Array(decode(data.support)),blockers=new Uint32Array(decode(data.blockers));
    if(positions.length!==data.vertexCount*3||support.length!==data.supportCount*3||blockers.length!==data.blockerCount*3)throw new Error('Invalid collider arrays');
    if(!positions.every(Number.isFinite)||!support.every(i=>i<data.vertexCount)||!blockers.every(i=>i<data.vertexCount))throw new Error('Invalid collider geometry');
    scope.postMessage({id:data.id,positions,support,blockers},[positions.buffer,support.buffer,blockers.buffer]);
  }catch(error){scope.postMessage({error:error instanceof Error?error.message:String(error)});}
};
export {};
