import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {validateWalking} from '../scripts/viewer_walking.mjs';
async function moduleURL(file,replacements={}){
  let source=await readFile(new URL('../app/viewer/'+file,import.meta.url),'utf8');
  for(const [from,to] of Object.entries(replacements))source=source.replaceAll(`'${from}'`,JSON.stringify(to));
  return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
const {NavigationTransition}=await import(await moduleURL('navigation-transition.ts'));
const {newerRelease}=await import(await moduleURL('release-update.ts'));
const physicsURL=await moduleURL('rapier-walk.ts',{'@dimforge/rapier3d-compat':import.meta.resolve('@dimforge/rapier3d-compat')});
const {initializePhysics}=await import(physicsURL);await initializePhysics();
const {ColliderNavigation}=await import(await moduleURL('collider-loader.ts',{'./rapier-walk':physicsURL}));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('latest destination wins even when an older download finishes last',async()=>{
  const nav=new NavigationTransition(()=>{}),a=deferred(),b=deferred(),commits=[];
  const first=nav.run(()=>a.promise,p=>commits.push(p),'A');
  const second=nav.run(()=>b.promise,p=>commits.push(p),'B');
  b.resolve('B');await second;a.resolve('A');await first;
  assert.deepEqual(commits,['B']);assert.equal(nav.pending,false);
});
test('Home or exit cancels pending movement and stale errors',async()=>{
  const nav=new NavigationTransition(()=>{}),a=deferred(),commits=[];
  const request=nav.run(()=>a.promise,p=>commits.push(p),'Loading');
  nav.cancel();a.reject(new Error('old request failed'));await request;
  assert.equal(nav.error,'');assert.equal(nav.pending,false);assert.deepEqual(commits,[]);
  nav.retry();assert.equal(nav.pending,false);
});
test('a failed destination can retry the same intent',async()=>{
  const nav=new NavigationTransition(()=>{}),commits=[];let attempts=0;
  await nav.run(async()=>{if(!attempts++)throw new Error('offline');return 'arrived';},p=>commits.push(p),'Loading');
  assert.equal(nav.error,'offline');nav.retry();await new Promise(r=>setImmediate(r));
  assert.deepEqual(commits,['arrived']);assert.equal(nav.error,'');
});
const tile=(x,z)=>({id:`${x}_${z}`,cell:[x,z],bounds:[[x*45,0,z*45],[(x+1)*45,0,(z+1)*45]],url:'/fake',bytes:10,sha256:'0'.repeat(64),triangles:2});
const manifest=tiles=>({schema:'tempaku-colliders-1',policy:'authored-surfaces-v1',sourceModelSha256:'0'.repeat(64),tileSize:45,bytes:tiles.length*10,tiles});
const geometry=t=>({id:t.id,positions:new Float32Array([t.cell[0]*45,0,t.cell[1]*45,(t.cell[0]+1)*45,0,t.cell[1]*45,(t.cell[0]+1)*45,0,(t.cell[1]+1)*45,t.cell[0]*45,0,(t.cell[1]+1)*45]),support:new Uint32Array([0,2,1,0,3,2]),blockers:new Uint32Array()});
test('streaming waits for neighbours, deduplicates requests and retries failed cells',async()=>{
  let fail=true;const calls=[];
  const nav=new ColliderNavigation(manifest([tile(0,0),tile(1,0)]),new AbortController().signal,async t=>{
    calls.push(t.id);if(t.id==='1_0'&&fail)throw new Error('offline');return geometry(t);
  });
  try{
    const first=nav.ensureAround(44,20),second=nav.ensureAround(44,20);
    await Promise.all([assert.rejects(first,/offline/),assert.rejects(second,/offline/)]);
    assert.deepEqual(calls,['0_0','1_0']);assert.equal(nav.failedTileCount,1);assert.equal(nav.canTraverse(44.9,20,.26),false);
    fail=false;await nav.ensureAround(44,20);
    assert.equal(nav.failedTileCount,0);assert.equal(nav.canTraverse(44.9,20,.26),true);
    assert.equal(nav.canTraverse(-.01,20,.26),false);
  }finally{nav.dispose();}
});
test('disposing a viewer cancels in-flight decoding and never adds geometry to a freed world',async()=>{
  const waiting=deferred();let signal;
  const nav=new ColliderNavigation(manifest([tile(0,0)]),new AbortController().signal,async(t,s)=>{signal=s;await waiting.promise;return geometry(t);});
  const request=nav.ensureAround(20,20);await Promise.resolve();await Promise.resolve();
  nav.dispose();assert.equal(signal.aborted,true);waiting.resolve();await assert.rejects(request,{name:'AbortError'});
  assert.equal(nav.loadedTileCount,0);assert.equal(nav.failedTileCount,0);nav.dispose();
});
test('a model/collider mismatch is rejected before creating a physics world',async()=>{
  await assert.rejects(ColliderNavigation.create(manifest([tile(0,0)]),'1'.repeat(64),new AbortController().signal),/mismatch/);
});
test('walking contract rejects missing defaults, duplicate IDs and wrong coordinate data',async()=>{
  const plan=JSON.parse(await readFile(new URL('../data/viewer/walking.json',import.meta.url),'utf8'));
  assert.equal(validateWalking(plan),plan);
  assert.throws(()=>validateWalking({...plan,defaultPlaceId:'gone'}));
  assert.throws(()=>validateWalking({...plan,places:[plan.places[0],plan.places[0]]}));
  assert.throws(()=>validateWalking({...plan,places:[{...plan.places[0],position:[NaN,0,0]}]}));
  assert.throws(()=>validateWalking({...plan,routes:[]}));
});
test('update notices require a different complete release with matching model and collision',()=>{
  const m={schema:'tempaku-viewer-1',release:'a'.repeat(20),source:{sha256:'a'.repeat(64)},colliders:{sourceModelSha256:'a'.repeat(64)}};
  assert.equal(newerRelease(m,'b'.repeat(20)),true);
  assert.equal(newerRelease(m,m.release),false);
  assert.equal(newerRelease({...m,colliders:{sourceModelSha256:'b'.repeat(64)}},'b'.repeat(20)),false);
  assert.equal(newerRelease('<html>offline</html>','b'.repeat(20)),false);
});
