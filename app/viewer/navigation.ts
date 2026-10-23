import type { QualityLevel } from './types';
import { capsuleHitsTriangle } from './collision';

export interface GroundData {
  schema: 'tempaku-ground-1'; origin: [number, number]; spacing: number;
  width: number; height: number; layers: number; offset: number; scale: number; missing: number; data: string;
}

export interface WalkMeshData {
  schema: 'tempaku-walk-2'; positions: string; support: string; blockers: string;
  vertexCount: number; supportCount: number; blockerCount: number; cellSize: number;
  stepHeight: number; maximumDrop: number;
  policy?: string; sourceModelSha256?: string; capturedCollisionObjects?: number;
  characterHeight?: number; characterRadius?: number; maximumSlopeDegrees?: number;
}
export interface PreparedWalkMesh {
  spec: WalkMeshData; vertices: Float32Array; support: Uint32Array; blockers: Uint32Array;
  supportGrid: Map<string,number[]>; blockerGrid: Map<string,number[]>;
  broadSupport: number[]; broadBlockers: number[];
}
export interface WalkingPoint { x: number; z: number; height: number }

function unpack(data: string): ArrayBuffer {
  const text=atob(data), buffer=new ArrayBuffer(text.length), bytes=new Uint8Array(buffer);
  for(let i=0;i<bytes.length;i++) bytes[i]=text.charCodeAt(i);
  return buffer;
}

/** Triangle queries retain narrow stair treads and separate overlapping floors. */
export class WalkMesh {
  private vertices: Float32Array;
  private support: Uint32Array;
  private blockers: Uint32Array;
  private supportGrid=new Map<string,number[]>();
  private blockerGrid=new Map<string,number[]>();
  private broadSupport: number[]=[];
  private broadBlockers: number[]=[];
  constructor(readonly spec: WalkMeshData, prepared?: PreparedWalkMesh) {
    if(spec.schema!=='tempaku-walk-2'||spec.cellSize<.5||spec.cellSize>20||spec.stepHeight<=0||spec.stepHeight>.5) throw new Error('Invalid walk mesh');
    if(![spec.cellSize,spec.stepHeight,spec.maximumDrop].every(Number.isFinite) || spec.maximumDrop<0 || spec.maximumDrop>2) throw new Error('Invalid movement limits');
    for(const count of [spec.vertexCount,spec.supportCount,spec.blockerCount]) if(!Number.isSafeInteger(count)||count<0||count>20_000_000) throw new Error('Invalid collision count');
    if(prepared) {
      this.vertices=prepared.vertices;this.support=prepared.support;this.blockers=prepared.blockers;
      this.supportGrid=prepared.supportGrid;this.blockerGrid=prepared.blockerGrid;
      this.broadSupport=prepared.broadSupport;this.broadBlockers=prepared.broadBlockers;return;
    }
    this.vertices=new Float32Array(unpack(spec.positions));
    this.support=new Uint32Array(unpack(spec.support));
    this.blockers=new Uint32Array(unpack(spec.blockers));
    if(this.vertices.length!==spec.vertexCount*3||this.support.length!==spec.supportCount*3||this.blockers.length!==spec.blockerCount*3) throw new Error('Invalid walk mesh size');
    for(const value of this.vertices) if(!Number.isFinite(value)) throw new Error('Nonfinite walking geometry');
    for(const faces of [this.support,this.blockers]) for(const index of faces) if(index>=spec.vertexCount) throw new Error('Invalid walking vertex');
    this.index(this.support,this.supportGrid,this.broadSupport);
    this.index(this.blockers,this.blockerGrid,this.broadBlockers);
  }
  prepare():PreparedWalkMesh {
    return {spec:{...this.spec,positions:'',support:'',blockers:''},vertices:this.vertices,support:this.support,blockers:this.blockers,
      supportGrid:this.supportGrid,blockerGrid:this.blockerGrid,broadSupport:this.broadSupport,broadBlockers:this.broadBlockers};
  }
  get byteLength() { return this.vertices.byteLength+this.support.byteLength+this.blockers.byteLength; }
  canStand(x:number,z:number,height:number):boolean {
    if(![x,z,height].every(Number.isFinite))return false;
    const radius=this.spec.characterRadius??.20, body=this.spec.characterHeight??1.70, size=this.spec.cellSize;
    const candidates=new Set<number>(this.broadBlockers);
    for(let gx=Math.floor((x-radius)/size);gx<=Math.floor((x+radius)/size);gx++)
      for(let gz=Math.floor((z-radius)/size);gz<=Math.floor((z+radius)/size);gz++)
        for(let gy=Math.floor(height/size);gy<=Math.floor((height+body)/size);gy++)
          for(const f of this.blockerGrid.get(`${gx},${gz},${gy}`)??[])candidates.add(f);
    const v=this.vertices,faces=this.blockers;
    for(const f of candidates) {
      const ia=faces[f]*3,ib=faces[f+1]*3,ic=faces[f+2]*3;
      const low=Math.min(v[ia+1],v[ib+1],v[ic+1]),high=Math.max(v[ia+1],v[ib+1],v[ic+1]);
      if(high<=height+this.spec.stepHeight+.001||low>=height+body)continue;
      if(Math.max(v[ia],v[ib],v[ic])<x-radius||Math.min(v[ia],v[ib],v[ic])>x+radius||Math.max(v[ia+2],v[ib+2],v[ic+2])<z-radius||Math.min(v[ia+2],v[ib+2],v[ic+2])>z+radius)continue;
      if(capsuleHitsTriangle([x,height+radius,z],[x,height+body-radius,z],radius-.002,
        [v[ia],v[ia+1],v[ia+2]],[v[ib],v[ib+1],v[ib+2]],[v[ic],v[ic+1],v[ic+2]]))return false;
    }
    return true;
  }
  private index(faces: Uint32Array, grid: Map<string,number[]>, broad: number[]) {
    const v=this.vertices, size=this.spec.cellSize, solid=grid===this.blockerGrid;
    for(let f=0;f<faces.length;f+=3) {
      const a=faces[f]*3,b=faces[f+1]*3,c=faces[f+2]*3;
      const x0=Math.floor(Math.min(v[a],v[b],v[c])/size),x1=Math.floor(Math.max(v[a],v[b],v[c])/size);
      const z0=Math.floor(Math.min(v[a+2],v[b+2],v[c+2])/size),z1=Math.floor(Math.max(v[a+2],v[b+2],v[c+2])/size);
      // A few huge terrain triangles must not fill thousands of hash cells.
      const y0=solid?Math.floor(Math.min(v[a+1],v[b+1],v[c+1])/size):0;
      const y1=solid?Math.floor(Math.max(v[a+1],v[b+1],v[c+1])/size):0;
      if((x1-x0+1)*(z1-z0+1)*(y1-y0+1)>196) { broad.push(f);continue; }
      for(let z=z0;z<=z1;z++) for(let x=x0;x<=x1;x++) {
        for(let y=y0;y<=y1;y++) {
          const key=solid?`${x},${z},${y}`:`${x},${z}`,cell=grid.get(key);
          if(cell) cell.push(f);else grid.set(key,[f]);
        }
      }
    }
  }
  sample(x: number,z: number,reference?: number): number|null {
    if(!Number.isFinite(x)||!Number.isFinite(z)||(reference!==undefined&&!Number.isFinite(reference)))return null;
    const v=this.vertices,faces=this.support,size=this.spec.cellSize;
    const candidates=this.supportGrid.get(`${Math.floor(x/size)},${Math.floor(z/size)}`)??[];
    let height:number|null=null,best=Infinity;
    for(const list of [candidates,this.broadSupport]) for(const f of list) {
      const a=faces[f]*3,b=faces[f+1]*3,c=faces[f+2]*3;
      const ux=v[b]-v[a],uz=v[b+2]-v[a+2],vx=v[c]-v[a],vz=v[c+2]-v[a+2];
      const det=ux*vz-uz*vx;if(Math.abs(det)<1e-10) continue;
      const px=x-v[a],pz=z-v[a+2],s=(px*vz-pz*vx)/det,t=(ux*pz-uz*px)/det;
      if(s<-.00001||t<-.00001||s+t>1.00001) continue;
      const y=v[a+1]+s*(v[b+1]-v[a+1])+t*(v[c+1]-v[a+1]);
      const score=reference===undefined?-y:Math.abs(y-reference);
      if(score<best) { best=score;height=y; }
    }
    return height;
  }
  findNearby(x:number,z:number,reference:number): WalkingPoint|null {
    const check=(px:number,pz:number):WalkingPoint|null=>{
      const height=this.sample(px,pz,reference);
      return height!==null&&Math.abs(height-reference)<2&&this.canStand(px,pz,height)?{x:px,z:pz,height}:null;
    };
    const center=check(x,z);if(center)return center;
    for(let r=.5;r<=24;r+=.5) for(let i=0;i<24;i++) {
      const angle=i*Math.PI/12,p=check(x+Math.cos(angle)*r,z+Math.sin(angle)*r);if(p)return p;
    }
    return null;
  }
  private rayTriangle(f:number,ox:number,oy:number,oz:number,dx:number,dy:number,dz:number): boolean {
    const v=this.vertices,faces=this.blockers,a=faces[f]*3,b=faces[f+1]*3,c=faces[f+2]*3;
    const ex=v[b]-v[a],ey=v[b+1]-v[a+1],ez=v[b+2]-v[a+2];
    const fx=v[c]-v[a],fy=v[c+1]-v[a+1],fz=v[c+2]-v[a+2];
    const px=dy*fz-dz*fy,py=dz*fx-dx*fz,pz=dx*fy-dy*fx,det=ex*px+ey*py+ez*pz;
    if(Math.abs(det)<1e-10)return false;
    const tx=ox-v[a],ty=oy-v[a+1],tz=oz-v[a+2],u=(tx*px+ty*py+tz*pz)/det;
    if(u<-.00001||u>1.00001)return false;
    const qx=ty*ez-tz*ey,qy=tz*ex-tx*ez,qz=tx*ey-ty*ex,w=(dx*qx+dy*qy+dz*qz)/det;
    if(w<-.00001||u+w>1.00001)return false;
    const distance=(fx*qx+fy*qy+fz*qz)/det;
    return distance>=0&&distance<=1;
  }
  private blocked(a:WalkingPoint,b:WalkingPoint):boolean {
    const dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz);if(length<1e-8)return false;
    const size=this.spec.cellSize,radius=.20,candidates=new Set<number>(this.broadBlockers);
    for(let z=Math.floor((Math.min(a.z,b.z)-radius)/size);z<=Math.floor((Math.max(a.z,b.z)+radius)/size);z++)
      for(let x=Math.floor((Math.min(a.x,b.x)-radius)/size);x<=Math.floor((Math.max(a.x,b.x)+radius)/size);x++)
        for(let y=Math.floor((Math.min(a.height,b.height)+.3)/size);y<=Math.floor((Math.max(a.height,b.height)+1.7)/size);y++)
          for(const f of this.blockerGrid.get(`${x},${z},${y}`)??[])candidates.add(f);
    const ux=dx/length,uz=dz/length;
    for(const f of candidates) {
      const faces=this.blockers,v=this.vertices,ia=faces[f]*3,ib=faces[f+1]*3,ic=faces[f+2]*3;
      if(Math.max(v[ia+1],v[ib+1],v[ic+1])<Math.min(a.height,b.height)+.3||Math.min(v[ia+1],v[ib+1],v[ic+1])>Math.max(a.height,b.height)+1.7)continue;
      for(const side of [-radius,0,radius]) for(const height of [.4,1.0,1.6])
        if(this.rayTriangle(f,a.x-uz*side,a.height+height,a.z+ux*side,dx+ux*radius,b.height-a.height,dz+uz*radius))return true;
    }
    return false;
  }
  /** Sweep short steps so running or a slow frame cannot jump through a wall. */
  advance(x:number,z:number,height:number,dx:number,dz:number):WalkingPoint {
    if(![x,z,height,dx,dz].every(Number.isFinite)||Math.hypot(dx,dz)>100)return {x,z,height};
    let point={x,z,height};const n=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.12)),sx=dx/n,sz=dz/n;
    const attempt=(mx:number,mz:number):WalkingPoint|null=>{
      const nx=point.x+mx,nz=point.z+mz,y=this.sample(nx,nz,point.height);
      if(y===null||y-point.height>this.spec.stepHeight||point.height-y>this.spec.maximumDrop)return null;
      const next={x:nx,z:nz,height:y};return !this.canStand(next.x,next.z,next.height)?null:next;
    };
    for(let i=0;i<n;i++) {
      const next=attempt(sx,sz)??(Math.abs(sx)>1e-8?attempt(sx,0):null)??(Math.abs(sz)>1e-8?attempt(0,sz):null);
      if(!next)break;point=next;
    }
    return point;
  }
}

/** A small height field is loaded independently of visible render tiles. */
export class GroundField {
  private values: Uint16Array;
  constructor(readonly spec: GroundData) {
    if (spec.schema !== 'tempaku-ground-1' || spec.spacing <= 0 || spec.width < 2 || spec.height < 2 || spec.layers < 1 || spec.layers > 8) throw new Error('Invalid ground field');
    const raw = atob(spec.data);
    if (raw.length !== spec.width * spec.height * spec.layers * 2) throw new Error('Invalid ground field size');
    this.values = new Uint16Array(raw.length / 2);
    for (let i = 0; i < this.values.length; i++) this.values[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
  }
  sample(x: number, z: number, reference?: number): number | null {
    const s = this.spec, fx = (x - s.origin[0]) / s.spacing, fz = (z - s.origin[1]) / s.spacing;
    if (fx < 0 || fz < 0 || fx > s.width - 1 || fz > s.height - 1) return null;
    const ix = Math.min(s.width - 2, Math.floor(fx)), iz = Math.min(s.height - 2, Math.floor(fz));
    const dx = fx - ix, dz = fz - iz;
    const samples: { height: number; weight: number; distance: number }[] = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const start = ((iz + j) * s.width + ix + i) * s.layers;
      let chosen: number | null = null, best = Infinity;
      for (let layer = 0; layer < s.layers; layer++) {
        const encoded = this.values[start + layer]; if (encoded === s.missing) continue;
        const height = s.offset + encoded * s.scale;
        const score = reference === undefined ? -height : Math.abs(height - reference);
        if (score < best) { best = score; chosen = height; }
      }
      if (chosen !== null) samples.push({ height: chosen, weight: (i ? dx : 1-dx) * (j ? dz : 1-dz), distance: (i-dx)**2 + (j-dz)**2 });
    }
    if (!samples.length) return null;
    const lo = Math.min(...samples.map(p=>p.height)), hi = Math.max(...samples.map(p=>p.height));
    // Smooth slopes, but do not interpolate between a bridge and the road below.
    if (samples.length === 4 && hi - lo < 1.25) return samples.reduce((sum,p)=>sum+p.height*p.weight,0);
    samples.sort((a,b)=>a.distance-b.distance);
    return samples[0].height;
  }
  findNearby(x: number, z: number, reference: number): { x: number; z: number; height: number } | null {
    const check = (px: number,pz: number) => {
      const height=this.sample(px,pz,reference);
      return height!==null && Math.abs(height-reference)<9 ? {x:px,z:pz,height} : null;
    };
    const center=check(x,z);if(center) return center;
    for(let radius=1;radius<=24;radius++) {
      for(let offset=-radius;offset<=radius;offset++) {
        for(const [dx,dz] of [[offset,-radius],[offset,radius],[-radius,offset],[radius,offset]]) {
          const point=check(x+dx,z+dz);if(point) return point;
        }
      }
    }
    return null;
  }
}

/** Change one level at a time, and require sustained headroom before recovering. */
export class AdaptiveQuality {
  level: Extract<QualityLevel, 'low' | 'balanced' | 'high'> = 'balanced';
  private bad = 0;
  private good = 0;
  update(frameMs: number, seconds: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || seconds <= 0) return false;
    this.bad = frameMs > 40 ? this.bad + seconds : Math.max(0, this.bad-seconds);
    this.good = frameMs < 23 ? this.good + seconds : 0;
    if (this.bad >= 2 && this.level !== 'low') {
      this.level = this.level === 'high' ? 'balanced' : 'low'; this.bad = this.good = 0; return true;
    }
    if (this.good >= 12 && this.level !== 'high') {
      this.level = this.level === 'low' ? 'balanced' : 'high'; this.bad = this.good = 0; return true;
    }
    return false;
  }
  reset() { this.bad = this.good = 0; }
}
