import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';
const source=(await readFile(new URL('../app/viewer/rapier-walk.ts',import.meta.url),'utf8'))
  .replaceAll("'@dimforge/rapier3d-compat'",JSON.stringify(import.meta.resolve('@dimforge/rapier3d-compat')));
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {RapierWalkWorld,initializePhysics}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
await initializePhysics();
function fixture(){
  const nav=new RapierWalkWorld();
  nav.addGeometry(new Float32Array([-20,0,-20,20,0,-20,20,0,20,-20,0,20]),new Uint32Array([0,2,1,0,3,2]),new Uint32Array());
  nav.teleport({x:0,z:0,height:0});return nav;
}
const step=(nav,frames=60,x=0,z=0,ready=()=>true)=>{for(let i=0;i<frames;i++)nav.update(1/60,x,z,ready);};
test('jump has gravity, cannot jump again in air, and lands on the same floor',()=>{
  const nav=fixture();try{
    step(nav,5);nav.jump();step(nav,20);const first=nav.feet().height;
    assert.ok(first>.8&&first<1.5);assert.equal(nav.grounded,false);
    nav.jump();step(nav,20);assert.ok(nav.feet().height<1.6);
    step(nav,100);assert.ok(Math.abs(nav.feet().height)<.05);assert.equal(nav.grounded,true);
  }finally{nav.dispose();}
});
test('capsule slides on a wall and stays below a low ceiling when jumping',()=>{
  const nav=fixture();try{
    nav.world.createCollider(RAPIER.ColliderDesc.cuboid(.1,2,10).setTranslation(1,2,0));
    nav.world.createCollider(RAPIER.ColliderDesc.cuboid(10,.1,10).setTranslation(0,2.1,0));nav.world.step();
    step(nav,5);nav.jump();let highest=0;
    for(let i=0;i<90;i++){nav.update(1/60,2,1,()=>true);highest=Math.max(highest,nav.feet().height);}
    assert.ok(highest<.34,`ceiling height ${highest}`);assert.ok(nav.feet().x<.73);assert.ok(nav.feet().z>1);
  }finally{nav.dispose();}
});
test('a loaded floor cannot carry the character through an unloaded tile boundary',()=>{
  const nav=fixture();try{
    step(nav,120,3.2,0,(x,z,radius)=>x+radius<1);
    assert.ok(nav.feet().x<.75);assert.equal(nav.blockedByStreaming,true);
    step(nav,20,3.2,0);assert.ok(nav.feet().x>1.5);
  }finally{nav.dispose();}
});
test('small stairs are climbed; a tall wall is not treated as a step',()=>{
  const nav=fixture();try{
    nav.world.createCollider(RAPIER.ColliderDesc.cuboid(1,.15,3).setTranslation(2,.15,0));
    nav.world.createCollider(RAPIER.ColliderDesc.cuboid(.5,1,3).setTranslation(4,1,0));nav.world.step();
    step(nav,90,2,0);assert.ok(nav.feet().height>.28);assert.ok(nav.feet().x>1.5&&nav.feet().x<3.4);
    step(nav,60,2,0);assert.ok(nav.feet().x<3.35);
  }finally{nav.dispose();}
});

test('walking stops at missing authored ground while an explicit jump can leave the edge',()=>{
  const nav=new RapierWalkWorld();try{
    nav.addGeometry(new Float32Array([-4,0,-4,0,0,-4,0,0,4,-4,0,4]),new Uint32Array([0,2,1,0,3,2]),new Uint32Array());
    nav.teleport({x:-1,z:0,height:0});step(nav,60,3.2,0);
    assert.ok(nav.feet().x<0);assert.ok(nav.feet().height>-.04);assert.equal(nav.blockedByEdge,true);
    nav.jump();step(nav,20,3.2,0);assert.ok(nav.feet().x>.5);assert.ok(nav.feet().height>.8);
  }finally{nav.dispose();}
});
test('five substeps bound catch-up after a long frame; gravity also runs without input',()=>{
  const nav=fixture();try{
    nav.teleport({x:0,z:0,height:2});nav.grounded=false;
    nav.update(5,3,0,()=>true);assert.ok(nav.feet().x<=.251);assert.ok(nav.droppedSeconds>0);
    step(nav,120);assert.ok(nav.feet().height<.05);
  }finally{nav.dispose();}
});

test('capsule crosses a narrow paving joint in both directions but stops at a real gap',()=>{
  for(const gap of [.035,1])for(const reverse of [false,true]){
    const nav=new RapierWalkWorld();try{
      const vertices=new Float32Array([-4,0,-4,0,0,-4,0,0,4,-4,0,4,gap,0,-4,4,0,-4,4,0,4,gap,0,4]);
      nav.addGeometry(vertices,new Uint32Array([0,2,1,0,3,2,4,6,5,4,7,6]),new Uint32Array());
      const start=reverse?gap+1:-1;
      nav.teleport({x:start,z:0,height:0});step(nav,60,reverse?-3.2:3.2,0);
      const x=nav.feet().x;
      if(gap<.1){assert.ok(reverse?x<-.5:x>.5,`joint ${gap}, reverse=${reverse}, x=${x}`);assert.ok(nav.feet().height>-.04);}
      else {assert.ok(reverse?x>=gap:x<=0);assert.equal(nav.blockedByEdge,true);}
    }finally{nav.dispose();}
  }
});

test('a capsule stays grounded on a slope and can jump after standing still',()=>{
  const nav=new RapierWalkWorld();try{
    nav.addGeometry(new Float32Array([-10,-5,-10,10,5,-10,10,5,10,-10,-5,10]),new Uint32Array([0,2,1,0,3,2]),new Uint32Array());
    nav.teleport({x:0,z:0,height:0});step(nav,60,2,0);step(nav,120);
    assert.equal(nav.grounded,true);const before=nav.feet().height;
    nav.jump();step(nav,20);assert.ok(nav.feet().height>before+.7);
  }finally{nav.dispose();}
});
test('strict destination lookup cannot silently switch to a different floor',()=>{
  const nav=fixture();try{
    assert.equal(nav.findNearby(0,0,4,{radius:.5,up:.65,down:.65}),null);
    assert.ok(nav.findNearby(0,0,.2,{radius:.5,up:.65,down:.65}));
  }finally{nav.dispose();}
});
test('walking distance is consistent at 30, 60 and 120 rendered frames per second',()=>{
  const positions=[];
  for(const fps of [30,60,120]){const nav=fixture();try{for(let i=0;i<fps;i++)nav.update(1/fps,3.2,0,()=>true);positions.push(nav.feet().x);}finally{nav.dispose();}}
  assert.ok(Math.max(...positions)-Math.min(...positions)<.01);
});
