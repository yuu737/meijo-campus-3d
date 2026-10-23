import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import {geometryIdentity} from '../scripts/viewer_geometry_identity.mjs';
import {releaseAssets} from '../scripts/viewer_release.mjs';
import {Document,NodeIO} from '@gltf-transform/core';
import {transferTreeOcclusion} from '../scripts/viewer_tree_occlusion.mjs';
import {preserveExactNodeTransforms,preserveExactNodeTransformsJSON} from '../scripts/viewer_gltf_transforms.mjs';
import {restoreUnbakedEmission} from '../scripts/viewer_lighting_fallback.mjs';

test('hardware fallback restores agreed emission from renumbered material duplicates without changing surfaces or buffers',()=>{
 const gltf={buffers:[{uri:'exact.bin'}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{
  name:'Housing.030',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.23,.25,.24,1]},
  emissiveTexture:{index:0},emissiveFactor:[1,1,1],extensions:{KHR_materials_emissive_strength:{emissiveStrength:4},KHR_materials_ior:{ior:1.7}},extras:{webLightmap:true,webLightmapGain:12,authored:'kept'}
 }]};
 const before=structuredClone(gltf),original={materials:[{name:'Housing.001'},{name:'Housing.006',emissiveFactor:[0,0,0],pbrMetallicRoughness:{baseColorFactor:[.58,.61,.59,1]}}]};
 restoreUnbakedEmission(gltf,original);
 assert.deepEqual(gltf.buffers,before.buffers);assert.deepEqual(gltf.meshes,before.meshes);
 const m=gltf.materials[0];assert.deepEqual(m.pbrMetallicRoughness,before.materials[0].pbrMetallicRoughness);
 assert.equal(m.emissiveTexture,undefined);assert.equal(m.emissiveFactor,undefined);
 assert.deepEqual(m.extensions,{KHR_materials_ior:{ior:1.7}});assert.deepEqual(m.extras,{authored:'kept'});
});

test('hardware fallback rejects conflicting, textured or missing original emission before mutating materials',()=>{
 for(const materials of [[],[{name:'Housing.001'},{name:'Housing.002',emissiveFactor:[.1,0,0]}],[{name:'Housing.001'},{name:'Housing.002',extensions:{KHR_materials_emissive_strength:{emissiveStrength:2}}}],[{name:'Housing.001',emissiveTexture:{index:0}}]]){
  const gltf={materials:[{name:'Valid',extras:{webLightmap:true},emissiveTexture:{index:0}},{name:'Housing.030',extras:{webLightmap:true},emissiveTexture:{index:0}}]},before=structuredClone(gltf);
  assert.throws(()=>restoreUnbakedEmission(gltf,{materials:[{name:'Valid'},...materials]}),/Cannot safely restore original emission/);
  assert.deepEqual(gltf,before);
 }
});

test('hardware fallback retains agreed authored light emission strength',()=>{
 const source={emissiveFactor:[.5,.2,.1],extensions:{KHR_materials_emissive_strength:{emissiveStrength:3}}};
 const gltf={materials:[{name:'Lamp.020',extras:{webLightmap:true},emissiveTexture:{index:0}}]};
 restoreUnbakedEmission(gltf,{materials:[{name:'Lamp.001',...source},{name:'Lamp.002',...source}]});
 assert.deepEqual(gltf.materials[0].emissiveFactor,source.emissiveFactor);assert.deepEqual(gltf.materials[0].extensions,source.extensions);
});

function treeFixture(order=[0,1,2],visibility=false){
 const doc=new Document(),buffer=doc.createBuffer();
 const material=doc.createMaterial('Leaves').setBaseColorFactor([.12,.3,.08,1]).setAlphaMode('MASK').setAlphaCutoff(.4).setDoubleSided(true);
 const texture=doc.createTexture('Authored leaf image').setImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0S8AAAAASUVORK5CYII=','base64')).setMimeType('image/png');
 material.setBaseColorTexture(texture);
 const points=[[0,0,0],[1,0,0],[0,1,0]],uvs=[[.1,.2],[.7,.2],[.1,.8]];
 const attr=(name,type,values)=>doc.createAccessor(name).setType(type).setBuffer(buffer).setArray(new Float32Array(values));
 const primitive=doc.createPrimitive().setMaterial(material)
  .setAttribute('POSITION',attr('positions','VEC3',order.flatMap(i=>points[i])))
  .setAttribute('NORMAL',attr('normals','VEC3',order.flatMap(()=>[0,0,1])))
  .setAttribute('TEXCOORD_0',attr('uv','VEC2',order.flatMap(i=>uvs[i])));
 if(visibility)primitive.setAttribute('COLOR_0',attr('visibility','VEC4',order.flatMap(i=>[.1+i*.2,.8-i*.2,1,1])));
 doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
 return {doc,primitive,material};
}

test('tree visibility follows cyclically reordered corners while authored normals, UV and alpha stay intact',async()=>{
 const source=treeFixture(),baked=treeFixture([1,2,0],true);
 // Bake-only materials must not replace the original surface.
 baked.material.setBaseColorFactor([1,0,0,1]).setAlphaMode('OPAQUE');
 const identity=geometryIdentity(source.doc),image=source.material.getBaseColorTexture().getImage();await transferTreeOcclusion(source.doc,baked.doc);
 assert.deepEqual(geometryIdentity(source.doc),identity);
 assert.deepEqual(source.material.getBaseColorFactor(),[.12,.3,.08,1]);assert.equal(source.material.getAlphaMode(),'MASK');assert.equal(source.material.getAlphaCutoff(),.4);
 assert.deepEqual(source.material.getBaseColorTexture().getImage(),image);
 assert.equal(source.material.getExtras().webTreeSelfOcclusion,'two-sided-vertex-v1');
 const p=source.primitive;
 for(let i=0;i<p.getAttribute('POSITION').getCount();i++){
  const point=p.getAttribute('POSITION').getElement(i,[]),id=point[0]===1?1:point[1]===1?2:0;
  assert.deepEqual(p.getAttribute('NORMAL').getElement(i,[]),[0,0,1]);
  const uv=p.getAttribute('TEXCOORD_0').getElement(i,[]),expected=[[.1,.2],[.7,.2],[.1,.8]][id];
  assert.ok(uv.every((n,j)=>Math.abs(n-expected[j])<1e-6));
  const value=p.getAttribute('COLOR_0').getElement(i,[]);assert.ok(Math.abs(value[0]-(.1+id*.2))<1e-6);assert.ok(Math.abs(value[1]-(.8-id*.2))<1e-6);assert.deepEqual(value.slice(2),[1,1]);
 }
});

test('tree visibility rejects flipped geometry and authored colours instead of replacing them',async()=>{
 await assert.rejects(transferTreeOcclusion(treeFixture().doc,treeFixture([0,2,1],true).doc),/changed geometry/);
 await assert.rejects(transferTreeOcclusion(treeFixture([0,1,2],true).doc,treeFixture([0,1,2],true).doc),/authored tree colours/);
});

test('binary export retains sub-tolerance authored transforms and unchanged resource bytes',async()=>{
 const {doc}=treeFixture(),node=doc.getRoot().listNodes()[0],scene=doc.getRoot().listScenes()[0];
 node.setName('Subtle source transform').setTranslation([1e-7,2e-7,3e-7]).setScale([1.0000073909759521,1,1.0000073909759521]).setRotation([0,1e-6,0,Math.sqrt(1-1e-12)]);
 scene.removeChild(node);scene.addChild(doc.createNode('Placement').setTranslation([10,0,0]).addChild(node));
 const io=new NodeIO(),before=geometryIdentity(doc),binary=await io.writeBinary(doc);
 assert.notDeepEqual(geometryIdentity(await io.readBinary(binary)),before,'Fixture must exercise the writer\'s near-default transform omission');
 const exact=preserveExactNodeTransforms(binary,doc),loaded=await io.readBinary(exact);
 assert.deepEqual(geometryIdentity(loaded),before);
 assert.deepEqual(loaded.getRoot().listNodes()[0].getTranslation(),node.getTranslation());
 assert.deepEqual(loaded.getRoot().listNodes()[0].getRotation(),node.getRotation());
 assert.deepEqual(loaded.getRoot().listNodes()[0].getScale(),node.getScale());
 const tail=bytes=>{const b=Buffer.from(bytes);return b.subarray(20+b.readUInt32LE(12));};
 assert.deepEqual(tail(exact),tail(binary));
 assert.deepEqual(Buffer.from(loaded.getRoot().listTextures()[0].getImage()),Buffer.from(doc.getRoot().listTextures()[0].getImage()));
 const external=await io.writeJSON(doc);preserveExactNodeTransformsJSON(external.json,doc);
 assert.deepEqual(geometryIdentity(await io.readJSON(external)),before);
 assert.throws(()=>preserveExactNodeTransforms(Buffer.from('invalid'),doc),/complete glTF/);
 const mismatch=new Document();assert.throws(()=>preserveExactNodeTransforms(binary,mismatch),/node count/);
});
const assetUrlsSource=await readFile(new URL('../app/viewer/asset-urls.ts',import.meta.url),'utf8');
const assetUrlsJS=ts.transpileModule(assetUrlsSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {resolveManifestAssets}=await import('data:text/javascript;base64,'+Buffer.from(assetUrlsJS).toString('base64'));
test('the authored HDR environment is published and follows the pinned asset origin',()=>{
 const hash='e'.repeat(64),image={url:`/viewer/assets/${hash}.hdr`,sha256:hash,bytes:128};
 const manifest={chunks:[],trees:null,assetBaseUrl:'https://assets.example.org',environment:{image}};
 assert.deepEqual(releaseAssets(manifest),[{...image,contentType:'image/vnd.radiance'}]);
 assert.equal(resolveManifestAssets(manifest,'https://viewer.example.org').environment.image.url,`https://assets.example.org${image.url}`);
 assert.equal(manifest.environment.image.url,image.url);
 assert.throws(()=>releaseAssets({...manifest,environment:{image:{...image,url:'/viewer/assets/../secret.hdr'}}}),/content-addressed/);
 assert.throws(()=>resolveManifestAssets({...manifest,environment:{image:{...image,url:'https://other.example.org/sky.hdr'}}},'https://viewer.example.org'),/Invalid immutable/);
});
const shaderSource=await readFile(new URL('../app/viewer/shader-ready.ts',import.meta.url),'utf8');
const shaderJS=ts.transpileModule(shaderSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {waitForShaderPrograms}=await import('data:text/javascript;base64,'+Buffer.from(shaderJS).toString('base64'));
test('context disposal cancels pending shader polls before programs are destroyed',async()=>{
 const controller=new AbortController();let polls=0,disposed=false;
 const pending=waitForShaderPrograms(()=>{assert.equal(disposed,false);polls++;return false;},controller.signal);
 controller.abort();disposed=true;await assert.rejects(pending,{name:'AbortError'});
 const atCancel=polls;await new Promise(r=>setTimeout(r,35));assert.equal(polls,atCancel);
});
test('shader readiness holds the new object until every program is ready',async()=>{
 let ready=false,finished=false;const controller=new AbortController();
 const pending=waitForShaderPrograms(()=>ready,controller.signal).then(()=>{finished=true;});
 await new Promise(r=>setTimeout(r,15));assert.equal(finished,false);ready=true;await pending;assert.equal(finished,true);
});

test('native lighting variants preserve oriented surfaces despite UV vertex splits',()=>{
  const shape=(points,indices)=>{
    const primitive={getMode:()=>4,getAttribute:()=>({getCount:()=>points.length/3,getElement:i=>points.slice(i*3,i*3+3)}),getIndices:()=>indices?{getCount:()=>indices.length,getScalar:i=>indices[i]}:null};
    const node={getMesh:()=>({listPrimitives:()=>[primitive]}),getExtension:()=>null,getWorldMatrix:()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
    const document={getRoot:()=>({listNodes:()=>[node]})};
    return geometryIdentity(document);
  };
  const original=shape([0,0,0,1,0,0,1,1,0,0,1,0],[0,1,2,0,2,3]);
  const split=shape([1,1,0,0,1,0,0,0,0,1,0,0,1,1,0,0,0,0]);
  assert.deepEqual(split,original);
  // Same triangle count and bounds are insufficient: changed diagonal surfaces
  // and inverted faces must fail, including a very thin displaced layer.
  assert.notEqual(shape([0,0,0,1,0,0,1,1,0,0,1,0],[0,2,1,0,2,3]).sha256,original.sha256);
  assert.notEqual(shape([0,0,0,1,0,0,1,1,.00001,0,1,0],[0,1,2,0,2,3]).sha256,original.sha256);
});
const source=await readFile(new URL('../app/viewer/lod-policy.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {chooseLOD,validatedLOD,estimateTextureBytes}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const qualitySource=await readFile(new URL('../app/viewer/quality.ts',import.meta.url),'utf8');
const qualityJS=ts.transpileModule(qualitySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {renderSize,lightingAsset,MANUAL_QUALITIES,QUALITY_PROFILES}=await import('data:text/javascript;base64,'+Buffer.from(qualityJS).toString('base64'));
test('hardware limits fall back to verified full geometry when no lighting atlas fits',()=>{
 const fallback={asset:{sha256:'unbaked'},sourceModelSha256:'source',fullAssetSha256:'full',geometryPreserved:true};
 const c={full:{sha256:'full'},lightmapResolution:[4096,4096],lightingFallback:fallback};
 assert.equal(lightingAsset(c,'full','extreme','source',2048),fallback.asset);
 assert.equal(lightingAsset(c,'full','extreme','source',8192),c.full);
 assert.equal(lightingAsset(c,'full','extreme','changed-source',2048),c.full);
});
const chunk={full:{},medium:{},coarse:{},far:{}};
const profile={allFull:false,fullDistance:40,fullPixels:400};
test('architectural facades retain full geometry at distance and in low quality',()=>{
 const building={...chunk,kind:'exterior'};
 assert.equal(chooseLOD(building,profile,500,10,'far',false),'full');
 assert.equal(chooseLOD(building,{...profile,fullDistance:15,fullPixels:Infinity},200,5,null,false,true),'full');
});
const daylightSettings=JSON.parse(await readFile(new URL('../data/viewer/daylight.json',import.meta.url),'utf8'));
const daylightSource=(await readFile(new URL('../app/viewer/daylight.ts',import.meta.url),'utf8'))
 .replace("'three'",JSON.stringify(import.meta.resolve('three')))
 .replace("import daylight from '../../data/viewer/daylight.json';",'const daylight='+JSON.stringify(daylightSettings)+';');
const daylightJS=ts.transpileModule(daylightSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {prepareBakedDaylight,setBakedDaylightEnabled}=await import('data:text/javascript;base64,'+Buffer.from(daylightJS).toString('base64'));
const sharingSource=(await readFile(new URL('../app/viewer/texture-sharing.ts',import.meta.url),'utf8')).replace("'three'",JSON.stringify(import.meta.resolve('three')));
const sharingJS=ts.transpileModule(sharingSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {tagTextureSources,textureSharingKey}=await import('data:text/javascript;base64,'+Buffer.from(sharingJS).toString('base64'));
const lookData=JSON.parse(await readFile(new URL('../data/viewer/agx-look.json',import.meta.url),'utf8'));
const lookSource=(await readFile(new URL('../app/viewer/agx-look.ts',import.meta.url),'utf8'))
 .replace("'three'",JSON.stringify(import.meta.resolve('three')))
 .replace("import look from '../../data/viewer/agx-look.json';",'const look='+JSON.stringify(lookData)+';');
const lookJS=ts.transpileModule(lookSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {applyAgXLookChannel,withBlenderAgXLook}=await import('data:text/javascript;base64,'+Buffer.from(lookJS).toString('base64'));

test('display contrast agrees with independent OpenColorIO reference samples',()=>{
 const scale=lookData.blenderLogRangeStops/lookData.threeLogRangeStops;
 for(const sample of lookData.referenceSamples)
  assert.ok(Math.abs(applyAgXLookChannel(sample.input*scale)-sample.output*scale)<3e-7);
 assert.match(withBlenderAgXLook('#include <tonemapping_pars_fragment>'),/AgX - Medium High Contrast/);
 assert.throws(()=>withBlenderAgXLook('unknown shader'),/AgX shader changed/);
});

test('identical texture data can share storage while different UVs and colour spaces stay separate',()=>{
 const a=new THREE.Texture();a.name='masonry';
 const scene=new THREE.Group();scene.add(new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshStandardMaterial({map:a})));
 const uri='a'.repeat(64)+'.ktx2';tagTextureSources(scene,{images:[{name:'masonry',uri}]});
 const b=a.clone();assert.equal(textureSharingKey(a),textureSharingKey(b));
 b.channel=1;assert.notEqual(textureSharingKey(a),textureSharingKey(b));
 b.channel=0;b.colorSpace=THREE.SRGBColorSpace;assert.notEqual(textureSharingKey(a),textureSharingKey(b));
 b.colorSpace=a.colorSpace;b.repeat.x=2;assert.notEqual(textureSharingKey(a),textureSharingKey(b));
});
test('ambiguous image names and unverified image paths never become shared texture keys',()=>{
 const texture=new THREE.Texture();texture.name='same-name';
 const scene=new THREE.Group();scene.add(new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshStandardMaterial({map:texture})));
 tagTextureSources(scene,{images:[{name:'same-name',uri:'a'.repeat(64)+'.ktx2'},{name:'same-name',uri:'b'.repeat(64)+'.ktx2'}]});
 assert.equal(textureSharingKey(texture),null);
 texture.userData.campusContentURI='unverified.png';assert.equal(textureSharingKey(texture),null);
});

test('baked daylight preserves an existing ground depth correction and can be toggled',()=>{
 const material=new THREE.MeshStandardMaterial();
 material.emissiveMap=new THREE.Texture();material.emissiveMap.channel=1;
 Object.assign(material.userData,{webLightmapMode:'diffuse-direct-indirect-sun',webLightmapGain:Math.PI});
 material.onBeforeCompile=shader=>{shader.vertexShader+='\n// existing ground depth correction';};
 material.customProgramCacheKey=()=> 'ground-depth';
 assert.equal(prepareBakedDaylight(material,true),true);
 assert.equal(prepareBakedDaylight(material,true),true);
 const shader={uniforms:{},vertexShader:'void main() {}',fragmentShader:'#include <lights_fragment_maps>\n#include <lights_fragment_end>'};
 material.onBeforeCompile(shader,{});
 assert.match(shader.vertexShader,/existing ground depth correction/);
 assert.match(material.customProgramCacheKey(),/ground-depth/);
 assert.equal(material.lightMap.channel,1);
 assert.equal(material.emissiveMap,null);
 assert.equal(shader.uniforms.useBakedDaylight.value,1);
 setBakedDaylightEnabled(material,false);
 assert.equal(shader.uniforms.useBakedDaylight.value,0);
});

test('fine display provides more pixels than standard on desktop and mobile',()=>{
 for(const [w,h,dpr] of [[762,794,1.25],[390,844,3]]){
  const standard=renderSize('balanced',w,h,dpr,4096),fine=renderSize('high',w,h,dpr,4096);
  assert.ok(fine.width*fine.height>standard.width*standard.height*1.5);
  assert.ok(fine.width*fine.height<=4200000);
 }
});

test('manual maximum uses the same full asset regardless of device and ignores smaller lighting variants',()=>{
 assert.deepEqual(MANUAL_QUALITIES,['low','balanced','high','extreme']);
 assert.equal(QUALITY_PROFILES.extreme.allFull,true);
 const c={full:{sha256:'full'},lightingVariants:{low:{asset:{sha256:'low'},sourceModelSha256:'source',fullAssetSha256:'full',geometryPreserved:true,resolution:[512,512],atlasPackingSize:[512,512]}}};
 assert.equal(lightingAsset(c,'full','low','source').sha256,'low');
 assert.equal(lightingAsset(c,'full','extreme','source').sha256,'full');
 assert.equal(lightingAsset(c,'full','low','changed-source').sha256,'full');
 c.lightingVariants.low.resolution=[256,256];
 assert.equal(lightingAsset(c,'full','low','source').sha256,'full');
});

test('only a physical texture limit may restrict maximum lighting, preserving full geometry and source checks',()=>{
 const variant={asset:{sha256:'smaller'},sourceModelSha256:'source',fullAssetSha256:'full',geometryPreserved:true,resolution:[2048,2048],atlasPackingSize:[2048,2048]};
 const c={full:{sha256:'full'},lightmapResolution:[4096,4096],lightingVariants:{balanced:variant}};
 assert.equal(lightingAsset(c,'full','extreme','source',8192).sha256,'full');
 assert.equal(lightingAsset(c,'full','extreme','source',2048).sha256,'smaller');
 assert.equal(lightingAsset(c,'full','extreme','new-source',2048).sha256,'full');
});

test('campus visibility remains correct with both conventional and reversed depth',()=>{
 for(const reversed of [false,true]){
  const projection=new THREE.Matrix4().makePerspective(-.035,.035,.035,-.035,.035,6000,THREE.WebGLCoordinateSystem,reversed);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(projection,THREE.WebGLCoordinateSystem,reversed);
  assert.ok(frustum.containsPoint(new THREE.Vector3(0,0,-100)));
  assert.ok(!frustum.containsPoint(new THREE.Vector3(0,0,-.001)));
  assert.ok(!frustum.containsPoint(new THREE.Vector3(0,0,10)));
  assert.ok(!frustum.containsPoint(new THREE.Vector3(0,0,-7000)));
 }
});
test('close objects and interiors retain full geometry',()=>{
 assert.equal(chooseLOD(chunk,profile,10,5,null,false),'full');
 assert.equal(chooseLOD(chunk,profile,200,5,null,true),'full');
});
const sourceHash='a'.repeat(64);
const approved={...chunk,full:{sha256:'f'.repeat(64)},medium:{sha256:'b'.repeat(64)}};
approved.lodValidation={medium:{status:'passed',sourceModelSha256:sourceHash,fullAssetSha256:approved.full.sha256,assetSha256:approved.medium.sha256,maxDiameterPixels:200,maxSilhouetteErrorPixels:.9,directions:8,checks:{openings:true,intersections:true,joins:true,shading:true}}};
test('unverified distant buildings, paving and terrain remain full',()=>{
 for(const kind of ['exterior','site','terrain'])for(const pixels of [0,20,300])
  assert.equal(chooseLOD({...chunk,kind},profile,2000,pixels,null,false,false,sourceHash),'full');
});
test('verified reduction uses drawing pixels with 20 percent hysteresis and zoom protection',()=>{
 assert.equal(chooseLOD(approved,profile,200,159,'full',false,false,sourceHash),'medium');
 assert.equal(chooseLOD(approved,profile,200,161,'full',false,false,sourceHash),'full');
 assert.equal(chooseLOD(approved,profile,200,199,'medium',false,false,sourceHash),'medium');
 assert.equal(chooseLOD(approved,profile,200,201,'medium',false,false,sourceHash),'full');
 assert.equal(chooseLOD(approved,profile,5000,2000,'medium',false,false,sourceHash),'full');
});
test('stale source, changed asset and visual defects invalidate geometry receipts',()=>{
 for(const patch of [{sourceModelSha256:'c'.repeat(64)},{assetSha256:'d'.repeat(64)},{fullAssetSha256:'e'.repeat(64)},{status:'failed'},{directions:1},{maxSilhouetteErrorPixels:1.01},{maxDiameterPixels:NaN},{checks:{...approved.lodValidation.medium.checks,joins:false}}]){
  const changed={...approved,lodValidation:{medium:{...approved.lodValidation.medium,...patch}}};
  assert.equal(validatedLOD(changed,'medium',sourceHash,50),false);
  assert.equal(chooseLOD(changed,profile,200,50,'medium',false,true,sourceHash),'full');
 }
});
test('missing levels choose existing data; maximum fidelity is never downgraded',()=>{
 assert.equal(chooseLOD({full:{}},profile,500,5,null,false),'full');
 assert.equal(chooseLOD(chunk,{...profile,allFull:true},500,5,null,false,true),'full');
});
test('occlusion cannot admit unverified simplified geometry',()=>{
 assert.equal(chooseLOD(chunk,profile,200,300,null,false,true),'full');
 assert.equal(chooseLOD(chunk,profile,10,300,null,false,true),'full');
});
test('compressed mip payloads are measured instead of an RGBA estimate',()=>{
 const t={image:{width:1024,height:1024},generateMipmaps:false,mipmaps:[{data:new Uint8Array(128)},{data:new Uint8Array(32)}]};
 assert.equal(estimateTextureBytes(t),160);
 assert.equal(estimateTextureBytes({image:{width:4,height:4},generateMipmaps:true}),4*4*4*4/3);
});
test('floating point data textures preserve their real allocation size',()=>{
 const image={width:4,height:4,data:new Float32Array(64)};
 assert.equal(estimateTextureBytes({image,generateMipmaps:false}),256);
});
