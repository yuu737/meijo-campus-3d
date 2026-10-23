/** Model-independent acceptance gate using the actual shipped capsule and colliders. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import ts from 'typescript';
import {root,loadRelease,safeWebPath,sha256} from './viewer_release.mjs';
import {validateWalking,walkingCodeSha} from './viewer_walking.mjs';
const {manifest,text}=await loadRelease();
const plan=validateWalking(manifest.walking);
const source=(await readFile(path.join(root,'app/viewer/rapier-walk.ts'),'utf8')).replaceAll("'@dimforge/rapier3d-compat'",JSON.stringify(import.meta.resolve('@dimforge/rapier3d-compat')));
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {RapierWalkWorld,initializePhysics}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
await initializePhysics();const nav=new RapierWalkWorld();
const decode=(value,Type)=>{const b=Buffer.from(value,'base64');return new Type(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const tiles=new Set(manifest.colliders.tiles.map(t=>t.id));
const covered=(x,z,r)=>{
  const size=manifest.colliders.tileSize;
  for(let a=Math.floor((x-r)/size);a<=Math.floor((x+r)/size);a++)for(let b=Math.floor((z-r)/size);b<=Math.floor((z+r)/size);b++)if(!tiles.has(`${a}_${b}`))return false;
  return true;
};
const places=[],routes=[];
try{
  for(const tile of manifest.colliders.tiles){
    const raw=await readFile(safeWebPath(tile.url));
    if(raw.length!==tile.bytes||sha256(raw)!==tile.sha256)throw new Error('Collider integrity failure');
    const data=JSON.parse(gunzipSync(raw));
    if(data.id!==tile.id||data.policy!==manifest.colliders.policy)throw new Error('Collider identity mismatch');
    nav.addGeometry(decode(data.positions,Float32Array),decode(data.support,Uint32Array),decode(data.blockers,Uint32Array));
  }
  for(const place of plan.places){
    const [x,h,z]=place.position,landing=nav.findNearby(x,z,h,{radius:.5,up:.65,down:.65});
    if(landing){nav.teleport(landing);for(let i=0;i<120;i++)nav.update(1/60,0,0,covered);}
    const end=landing?nav.feet():null;
    places.push({id:place.id,landing,end,pass:!!end&&covered(end.x,end.z,.26)&&nav.grounded&&Math.abs(end.height-landing.height)<.06});
  }
  function walk(route,reverse,speed,fps){
    const points=reverse?[...route.points].reverse():route.points;
    const start=nav.findNearby(...[points[0][0],points[0][1],reverse?route.endHeight:route.height],{radius:.5,up:.65,down:.65});
    const result={id:route.id,reverse,speed,fps,pass:false};
    if(!start)return {...result,reason:'no starting floor'};
    nav.teleport(start);for(let i=0;i<30;i++)nav.update(1/60,0,0,covered);
    let maxVerticalStep=0;
    for(let segment=1;segment<points.length;segment++){
      const target=points[segment];let stale=0;
      const maxFrames=Math.ceil((Math.hypot(target[0]-nav.feet().x,target[1]-nav.feet().z)/speed+8)*fps);
      for(let frame=0;frame<maxFrames;frame++){
        const before=nav.feet(),dx=target[0]-before.x,dz=target[1]-before.z,distance=Math.hypot(dx,dz);
        if(distance<.09)break;
        const v=Math.min(speed,distance*fps);
        nav.update(1/fps,v*dx/distance,v*dz/distance,covered);
        const after=nav.feet();maxVerticalStep=Math.max(maxVerticalStep,Math.abs(after.height-before.height));
        stale=Math.hypot(after.x-before.x,after.z-before.z)<.002?stale+1:0;
        if(stale>fps||frame===maxFrames-1)return {...result,reason:nav.blockedByStreaming?'missing tile':nav.blockedByEdge?'ground edge':'blocked',segment,at:after};
      }
    }
    for(let i=0;i<60;i++)nav.update(1/60,0,0,covered);
    const end=nav.feet(),expected=reverse?route.height:route.endHeight;
    const contacts=Array.from({length:nav.controller.numComputedCollisions()},(_,i)=>{const c=nav.controller.computedCollision(i);return {normal:c.normal1,point:c.witness1};});
    return {...result,pass:nav.grounded&&Math.abs(end.height-expected)<.65,end,grounded:nav.grounded,expected,maxVerticalStep,...(!nav.grounded?{contacts}: {})};
  }
  for(const route of plan.routes)for(const reverse of [false,true])for(const [speed,fps] of [[3.2,60],[8.32,30],[13,15]]){
    const result=walk(route,reverse,speed,fps);routes.push(result);
    if(!result.pass)console.error('WALK_FAILED',JSON.stringify(result));
  }
}finally{nav.dispose();}
const report={schema:'tempaku-walking-audit-1',release:manifest.release,sourceModelSha256:manifest.source.sha256,manifestSha256:sha256(text),codeSha256:await walkingCodeSha(),
  pass:places.every(p=>p.pass)&&routes.every(r=>r.pass),destinationsPassed:places.filter(p=>p.pass).length,destinationsTotal:places.length,routesPassed:routes.filter(r=>r.pass).length,routesTotal:routes.length,
  method:'Authored collision triangles; shipped Rapier capsule; destination clearance and gravity settle; bidirectional paths at 3.2 m/s (60 Hz), 8.32 m/s (30 Hz) and maximum sprint 13 m/s (15 Hz).',
  limitation:'Recorded paths only. Real device performance and unrecorded ground are not certified.',places,routes};
const out=path.join(root,'outputs/viewer/walking');await mkdir(out,{recursive:true});await writeFile(path.join(out,manifest.release+'.json'),JSON.stringify(report,null,2));
console.log('WALKING_AUDIT',JSON.stringify({release:report.release,pass:report.pass,destinations:`${report.destinationsPassed}/${report.destinationsTotal}`,routes:`${report.routesPassed}/${report.routesTotal}`}));
if(!report.pass)process.exitCode=1;
