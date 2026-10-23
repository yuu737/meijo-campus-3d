import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const collisionSource = await readFile(new URL('../app/viewer/collision.ts', import.meta.url), 'utf8');
const collisionJS = ts.transpileModule(collisionSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const collisionURL = 'data:text/javascript;base64,'+Buffer.from(collisionJS).toString('base64');
const source = (await readFile(new URL('../app/viewer/navigation.ts', import.meta.url), 'utf8')).replace("'./collision'",JSON.stringify(collisionURL));
const js = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const { GroundField, WalkMesh, AdaptiveQuality } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const qualitySource = await readFile(new URL('../app/viewer/quality.ts', import.meta.url), 'utf8');
const qualityJs = ts.transpileModule(qualitySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const { FrameBenchmark, renderSize } = await import('data:text/javascript;base64,' + Buffer.from(qualityJs).toString('base64'));

function field(heights, layers=1) {
  const bytes=Buffer.alloc(heights.length*2);
  heights.forEach((value,i)=>bytes.writeUInt16LE(value===null?65535:Math.round(value*100),i*2));
  return new GroundField({schema:'tempaku-ground-1',origin:[10,20],spacing:1,width:2,height:2,layers,offset:0,scale:.01,missing:65535,data:bytes.toString('base64')});
}
test('walk smoothly up a slope, with coordinates independent of render tiles',()=>{
  const ground=field([8,8.5,8.5,9]);
  assert.equal(ground.sample(10,20),8);
  assert.equal(ground.sample(10.5,20.5),8.5);
  assert.equal(ground.sample(11,21),9);
});
test('keep the road and the bridge as separate walking levels',()=>{
  const ground=field([15,8,15,8,15,8,15,8],2);
  assert.equal(ground.sample(10.5,20.5,8.1),8);
  assert.equal(ground.sample(10.5,20.5,14.8),15);
});
test('missing terrain and out-of-bounds points do not produce an artificial ground plane',()=>{
  const ground=field([null,null,null,null]);
  assert.equal(ground.sample(10.5,20.5),null);
  assert.equal(ground.sample(5,5),null);
});
test('a cliff is not interpolated into a steep ramp',()=>{
  const ground=field([8,20,8,20]);
  assert.equal(ground.sample(10.1,20.5,8),8);
});
test('a destination can recover onto nearby ground instead of the remote base plane',()=>{
  const ground=field([0,20,0,20]);
  const point=ground.findNearby(10,20,20);
  assert.ok(point);
  assert.equal(point.height,20);
});
test('automatic quality falls after sustained slow frames and recovers gradually',()=>{
  const quality=new AdaptiveQuality();
  assert.equal(quality.level,'balanced');
  assert.equal(quality.update(50,1),false);
  assert.equal(quality.update(50,1),true);
  assert.equal(quality.level,'low');
  assert.equal(quality.update(16,11),false);
  assert.equal(quality.update(16,1),true);
  assert.equal(quality.level,'balanced');
  assert.equal(quality.update(16,12),true);
  assert.equal(quality.level,'high');
});
test('brief pauses do not count as performance headroom',()=>{
  const quality=new AdaptiveQuality();
  quality.update(16,11);quality.reset();quality.update(16,1);
  assert.equal(quality.level,'balanced');
  assert.equal(quality.update(NaN,100),false);
});
test('benchmark measures delivered frames and excludes the initial idle gap',()=>{
  const benchmark=new FrameBenchmark(1000);
  benchmark.start();assert.equal(benchmark.sample(90_000),null);
  let result;
  for(let i=1;i<=60;i++) result=benchmark.sample(90_000+i*1000/60);
  assert.ok(result);assert.equal(result.frames,60);
  assert.ok(Math.abs(result.fps-60)<1e-8);assert.ok(Math.abs(result.lowFps-60)<1e-8);
});
test('slow frames remain in the result and cancellation cannot produce a score',()=>{
  const benchmark=new FrameBenchmark(1000);
  benchmark.start();benchmark.sample(0);
  for(let i=1;i<=50;i++) benchmark.sample(i*10);
  const result=benchmark.sample(1000);
  assert.ok(result);assert.equal(result.fps,51);assert.equal(result.lowFps,2);
  benchmark.start();benchmark.sample(2000);benchmark.stop();
  assert.equal(benchmark.sample(5000),null);
});
test('high resolution respects both the pixel budget and GPU dimensions',()=>{
  const size=renderSize('extreme',3200,1800,3,4096);
  assert.ok(size.width<=4096 && size.height<=4096);
  assert.ok(size.width*size.height<=8_300_000);
  const tall=renderSize('extreme',500,10_000,3,2048);
  assert.ok(tall.height<=2048);
  const standard=renderSize('balanced',1200,800,1,8192);
  const extreme=renderSize('extreme',1200,800,1,8192);
  assert.ok(extreme.width>standard.width);
});

function walkMesh(rectangles, walls=[], ceilings=[]) {
  const vertices=[],support=[],blockers=[];
  const quad=(points,list)=>{
    const start=vertices.length/3;vertices.push(...points.flat());list.push(start,start+1,start+2,start,start+2,start+3);
  };
  for(const [x0,z0,x1,z1,y0,y1=y0] of rectangles) quad([[x0,y0,z0],[x1,y1,z0],[x1,y1,z1],[x0,y0,z1]],support);
  for(const [x,z0,z1,bottom,top] of walls) quad([[x,bottom,z0],[x,top,z0],[x,top,z1],[x,bottom,z1]],blockers);
  for(const [x0,z0,x1,z1,h] of ceilings)quad([[x0,h,z0],[x1,h,z0],[x1,h,z1],[x0,h,z1]],blockers);
  const encoded=a=>Buffer.from(a.buffer).toString('base64');
  return new WalkMesh({schema:'tempaku-walk-2',positions:encoded(new Float32Array(vertices)),support:encoded(new Uint32Array(support)),blockers:encoded(new Uint32Array(blockers)),vertexCount:vertices.length/3,supportCount:support.length/3,blockerCount:blockers.length/3,cellSize:3,stepHeight:.38,maximumDrop:.65});
}
test('walk both directions on narrow physical treads without raster rounding',()=>{
  const steps=Array.from({length:36},(_,i)=>[i*.3167,0,(i+1)*.3167,2.8,(i+1)*.19005]);
  const mesh=walkMesh(steps);
  let point={x:.05,z:1.4,height:.19005};
  for(let i=0;i<140;i++)point=mesh.advance(point.x,point.z,point.height,.08,0);
  assert.ok(point.x>11.1);assert.ok(Math.abs(point.height-36*.19005)<1e-5);
  for(let i=0;i<140;i++)point=mesh.advance(point.x,point.z,point.height,-.08,0);
  assert.ok(point.x<.1);assert.ok(Math.abs(point.height-.19005)<1e-5);
});
test('a road remains below a bridge even when their triangles share a cell',()=>{
  const mesh=walkMesh([[0,0,10,4,8],[0,0,10,4,15]]);
  assert.equal(mesh.sample(5,2,8),8);assert.equal(mesh.sample(5,2,15),15);
  assert.equal(mesh.advance(1,2,8,7,0).height,8);
});
test('walk collision stops a long move before a wall and permits travel along it',()=>{
  const mesh=walkMesh([[0,0,10,10,0]],[[5,0,10,0,3]]);
  const stopped=mesh.advance(1,2,0,8,0);
  assert.ok(stopped.x<4.81&&stopped.x>4.6);
  const along=mesh.advance(stopped.x,2,0,0,5);
  assert.ok(along.z>6.9);
});
test('missing support and a high retaining edge stop walking without floating',()=>{
  const gap=walkMesh([[0,0,2,2,0],[3,0,5,2,0]]);
  assert.ok(gap.advance(1,1,0,4,0).x<=2.001);
  const cliff=walkMesh([[0,0,2,2,0],[2,0,5,2,2]]);
  assert.ok(cliff.advance(1,1,0,4,0).x<=2.001);
  assert.ok(cliff.advance(4,1,2,-4,0).x>=1.999);
});
test('swept walking crosses spatial cell borders and follows a graded path',()=>{
  const mesh=walkMesh([[-10,-2,10,2,0,3]]);
  const point=mesh.advance(-9,0,.15,18,0);
  assert.ok(Math.abs(point.x-9)<1e-6);assert.ok(Math.abs(point.height-2.85)<1e-6);
});
test('low ceilings reject standing and movement, while full headroom remains open',()=>{
  const low=walkMesh([[0,0,10,4,0]],[],[[4,0,8,4,1.45]]);
  assert.equal(low.canStand(5,2,0),false);
  assert.equal(low.canStand(2,2,0),true);
  assert.ok(low.advance(1,2,0,8,0).x<4);
  const high=walkMesh([[0,0,10,4,0]],[],[[4,0,8,4,2.20]]);
  assert.equal(high.canStand(5,2,0),true);
  assert.ok(high.advance(1,2,0,8,0).x>8.9);
});
test('body width distinguishes a narrow gap from an open doorway',()=>{
  const narrow=walkMesh([[0,0,10,10,0]],[[5,0,4.85,0,3],[5,5.15,10,0,3]]);
  assert.ok(narrow.advance(1,5,0,8,0).x<5);
  const doorway=walkMesh([[0,0,10,10,0]],[[5,0,4.5,0,3],[5,5.5,10,0,3]]);
  assert.ok(doorway.advance(1,5,0,8,0).x>8.9);
});
test('nearby recovery does not place the character inside a wall',()=>{
  const mesh=walkMesh([[0,0,10,10,0]],[[5,0,10,0,3]]);
  assert.equal(mesh.canStand(5,5,0),false);
  const point=mesh.findNearby(5,5,0);
  assert.ok(point&&Math.abs(point.x-5)>=.198);
  assert.equal(mesh.canStand(point.x,point.z,point.height),true);
});
test('prepared worker data retains the same collision behavior',()=>{
  const mesh=walkMesh([[0,0,10,10,0]],[[5,0,10,0,3]]);
  const prepared=structuredClone(mesh.prepare());
  const copy=new WalkMesh(prepared.spec,prepared);
  assert.deepEqual(copy.advance(1,2,0,8,0),mesh.advance(1,2,0,8,0));
  assert.equal(copy.sample(3,3,0),0);
});
