import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCapabilities,validateCapabilities} from '../scripts/viewer_capabilities.mjs';
const fixture=()=>({chunks:[{id:'EXT_library',kind:'exterior',full:{url:'full',triangles:100},medium:{url:'medium',triangles:50}}],trees:null,lightmaps:null});
const facts=()=>new Map([['full',{triangles:100,lightmappedMaterials:0,litMaterials:2}],['medium',{triangles:50,lightmappedMaterials:0,litMaterials:2}]]);
test('rejects claiming distant LOD that is not actually supplied',()=>{
  const m=fixture();m.capabilities=summarizeCapabilities(m);m.capabilities.lod.chunks.far=1;
  assert.throws(()=>validateCapabilities(m,facts()),/capabilities/);
});
test('rejects daylight declarations without encoded material tags',()=>{
  const m=fixture();m.chunks[0].lightmap='diffuse-direct-indirect-sun';m.lightmaps={targets:['EXT_library']};
  assert.throws(()=>validateCapabilities(m,facts()),/glTF materials/);
});
test('rejects an untagged LOD in an otherwise baked chunk',()=>{
  const m=fixture();m.chunks[0].lightmap='diffuse-direct-indirect-sun';m.lightmaps={targets:['EXT_library']};
  const f=facts();f.get('full').lightmappedMaterials=2;
  assert.throws(()=>validateCapabilities(m,f),/EXT_library\/medium/);
  f.get('medium').lightmappedMaterials=2;
  assert.equal(validateCapabilities(m,f).daylight.coverage,'outdoor');
});
test('actual geometry counts are checked rather than trusted',()=>{
  const m=fixture();const f=facts();f.get('full').triangles=101;
  assert.throws(()=>validateCapabilities(m,f),/Triangle declaration/);
});
test('legacy shared trees count as one level',()=>{
  const m=fixture();m.trees={light:{sha256:'same'},detailed:{sha256:'same'},transforms:[[]],renderMode:'unlit-shared'};
  assert.deepEqual(summarizeCapabilities(m).trees,{instances:1,levels:1,lighting:'unlit'});
});
