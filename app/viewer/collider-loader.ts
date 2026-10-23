import type {Collider} from '@dimforge/rapier3d-compat';
import {RapierWalkWorld,initializePhysics} from './rapier-walk';
import type {ColliderManifest,ColliderTile} from './types-v2';
type Decoded={positions:Float32Array;support:Uint32Array;blockers:Uint32Array;id:string};

function loadTile(asset:ColliderTile,signal:AbortSignal):Promise<Decoded>{
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./collider-worker.ts',import.meta.url),{type:'module'});
    const finish=(error?:Error,data?:Decoded)=>{worker.terminate();clearTimeout(timeout);signal.removeEventListener('abort',cancel);error?reject(error):resolve(data!);};
    const cancel=()=>finish(new DOMException('Aborted','AbortError'));
    const timeout=setTimeout(()=>finish(new Error('Collider download timed out')),45_000);
    if(signal.aborted){cancel();return;}signal.addEventListener('abort',cancel,{once:true});
    worker.onerror=()=>finish(new Error('Collider decoding failed'));
    worker.onmessage=e=>e.data.error?finish(new Error(e.data.error)):finish(undefined,e.data);
    worker.postMessage(asset);
  });
}

/** Only the local neighbourhood is resident. A missing tile never becomes passable. */
export class ColliderNavigation extends RapierWalkWorld {
  readonly spec={policy:'authored-surfaces-v1'};
  private tiles:Map<string,ColliderTile>;
  private loaded=new Map<string,{colliders:Collider[];lastUsed:number;decodedBytes:number}>();
  private pending=new Map<string,Promise<void>>();
  private errors=new Set<string>();
  private disposed=false;
  private queue:Promise<void>=Promise.resolve();
  downloadedBytes=0;
  private cancellation=new AbortController();
  private signal:AbortSignal;
  constructor(readonly manifest:ColliderManifest,signal:AbortSignal,private decode:typeof loadTile=loadTile){
    super();this.signal=AbortSignal.any([signal,this.cancellation.signal]);this.tiles=new Map(manifest.tiles.map(t=>[t.id,t]));
  }
  static async create(manifest:ColliderManifest,modelHash:string,signal:AbortSignal){
    if(manifest.schema!=='tempaku-colliders-1'||manifest.policy!=='authored-surfaces-v1'||manifest.sourceModelSha256!==modelHash)
      throw new Error('Collider/model mismatch');
    await initializePhysics();signal.throwIfAborted();return new ColliderNavigation(manifest,signal);
  }
  private cell(x:number,z:number){return [Math.floor(x/this.manifest.tileSize),Math.floor(z/this.manifest.tileSize)];}
  private ensureTile(tile:ColliderTile):Promise<void>{
    const resident=this.loaded.get(tile.id);if(resident){resident.lastUsed=performance.now();return Promise.resolve();}
    const existing=this.pending.get(tile.id);if(existing)return existing;
    // One decoder/BVH build at a time avoids burst pauses while walking.
    const request=this.queue.catch(()=>{}).then(async()=>{
      this.signal.throwIfAborted();
      const data=await this.decode(tile,this.signal);
      this.signal.throwIfAborted();
      if(data.id!==tile.id)throw new Error('Collider cell mismatch');
      this.loaded.set(tile.id,{colliders:this.addGeometry(data.positions,data.support,data.blockers),lastUsed:performance.now(),
        decodedBytes:data.positions.byteLength+data.support.byteLength+data.blockers.byteLength});
      this.downloadedBytes+=tile.bytes;this.errors.delete(tile.id);
    }).catch(error=>{if(!this.signal.aborted)this.errors.add(tile.id);throw error;}).finally(()=>this.pending.delete(tile.id));
    this.pending.set(tile.id,request);this.queue=request;return request;
  }
  async ensureAround(x:number,z:number){
    this.signal.throwIfAborted();
    const [cx,cz]=this.cell(x,z),required:ColliderTile[]=[],ahead:ColliderTile[]=[];
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
      const tile=this.tiles.get(`${cx+dx}_${cz+dz}`);if(tile)(dx===0&&dz===0?required:ahead).push(tile);
    }
    if(!required.length)throw new Error('No authored collider at this location');
    // Current cell first, then boundary neighbours; all nine are ready before teleport.
    await Promise.all([...required,...ahead].map(t=>this.ensureTile(t)));
  }
  canTraverse=(x:number,z:number,radius:number)=>{
    const [x0,z0]=this.cell(x-radius,z-radius),[x1,z1]=this.cell(x+radius,z+radius);
    for(let cx=x0;cx<=x1;cx++)for(let cz=z0;cz<=z1;cz++)if(!this.loaded.has(`${cx}_${cz}`))return false;
    return true;
  };
  prefetch(x:number,z:number){
    if(this.disposed||this.signal.aborted)return;
    const [cx,cz]=this.cell(x,z);
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
      const tile=this.tiles.get(`${cx+dx}_${cz+dz}`);
      if(tile&&!this.errors.has(tile.id))void this.ensureTile(tile).catch(()=>{});
    }
    const now=performance.now();
    for(const [id,item] of this.loaded){
      const [x,z]=id.split('_').map(Number);
      if(Math.max(Math.abs(cx-x),Math.abs(cz-z))>2&&now-item.lastUsed>10_000){this.removeGeometry(item.colliders);this.loaded.delete(id);}
    }
  }
  retry(){this.errors.clear();if(this.active){const p=this.feet();this.prefetch(p.x,p.z);}}
  get loadedTileCount(){return this.loaded.size;}
  get pendingTileCount(){return this.pending.size;}
  get failedTileCount(){return this.errors.size;}
  get residentMiB(){return [...this.loaded.values()].reduce((n,t)=>n+t.decodedBytes,0)/1048576;}
  override dispose(){if(this.disposed)return;this.disposed=true;this.cancellation.abort();super.dispose();this.loaded.clear();}
}
