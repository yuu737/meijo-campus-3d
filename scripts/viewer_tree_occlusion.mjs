/** Transfer baked self visibility onto the original tree's untouched attributes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {weld,prune} from '@gltf-transform/functions';
import {geometryIdentity} from './viewer_geometry_identity.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const method='two-sided-vertex-v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
const codeFiles=['viewer_tree_occlusion.mjs','bake_viewer_tree_occlusion.py','viewer_geometry_identity.mjs'];
const codeHash=async()=>hash(Buffer.concat(await Promise.all(codeFiles.map(name=>fs.readFile(path.join(root,'scripts',name))))));
async function exists(file){try{await fs.access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

function triangles(doc){
 const rows=[];
 for(const node of doc.getRoot().listNodes())if(node.getMesh()){
  if(node.getExtension('EXT_mesh_gpu_instancing'))throw Error('Tree prototype must not contain instances');
  const matrix=node.getWorldMatrix();
  for(const primitive of node.getMesh().listPrimitives()){
   if(primitive.getMode()!==4)throw Error('Tree must contain triangles');
   const position=primitive.getAttribute('POSITION'),indices=primitive.getIndices(),count=indices?.getCount()??position.getCount();
   if(count%3)throw Error('Incomplete tree triangle');
   for(let start=0;start<count;start+=3){
    const vertices=Array.from({length:3},(_,i)=>indices?indices.getScalar(start+i):start+i);
    const points=vertices.map(index=>{const [x,y,z]=position.getElement(index,[]);return new Float32Array([
     matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12],matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13],matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14]]);});
    const encoded=points.map(point=>{for(let i=0;i<3;i++){if(!Number.isFinite(point[i]))throw Error('Invalid tree position');if(Object.is(point[i],-0))point[i]=0;}return Buffer.from(point.buffer).toString('hex');});
    const turns=[0,1,2].map(turn=>[0,1,2].map(i=>encoded[(turn+i)%3]).join(''));
    let turn=0;for(let i=1;i<3;i++)if(turns[i]<turns[turn])turn=i;
    const key=primitive.getMaterial().getName()+'|'+[0,1,2].map(i=>encoded[(turn+i)%3]).join('');
    rows.push({key,primitive,start,vertices,turn,count});
   }
  }
 }
 return rows;
}

export async function transferTreeOcclusion(sourceDoc,bakedDoc){
 const before=geometryIdentity(sourceDoc);
 if(JSON.stringify(before)!==JSON.stringify(geometryIdentity(bakedDoc)))throw Error('Tree visibility bake changed geometry');
 const colorsByTriangle=new Map();
 for(const row of triangles(bakedDoc)){
  const colors=row.primitive.getAttribute('COLOR_0');if(!colors)throw Error('Missing baked tree visibility');
  const values=[0,1,2].map(i=>colors.getElement(row.vertices[(row.turn+i)%3],[]).slice(0,2));
  if(values.flat().some(value=>!Number.isFinite(value)||value<0||value>1))throw Error('Invalid baked tree visibility');
  if(!colorsByTriangle.has(row.key))colorsByTriangle.set(row.key,[]);
  colorsByTriangle.get(row.key).push(values);
 }
 const colorsByPrimitive=new Map();
 for(const row of triangles(sourceDoc)){
  if(row.primitive.getAttribute('COLOR_0'))throw Error('Do not overwrite authored tree colours');
  const queue=colorsByTriangle.get(row.key),values=queue?.shift();if(!values)throw Error('Tree visibility triangle correspondence failed');
  if(!colorsByPrimitive.has(row.primitive))colorsByPrimitive.set(row.primitive,new Float32Array(row.count*4));
  const colors=colorsByPrimitive.get(row.primitive);
  for(let i=0;i<3;i++)colors.set([...values[i],1,1],(row.start+(row.turn+i)%3)*4);
 }
 if([...colorsByTriangle.values()].some(queue=>queue.length))throw Error('Extra baked tree triangles');
 for(const [primitive,colors]of colorsByPrimitive){
  const indices=primitive.getIndices();
  for(const semantic of primitive.listSemantics()){
   const accessor=primitive.getAttribute(semantic),array=accessor.getArray(),size=accessor.getElementSize(),expanded=new array.constructor(colors.length/4*size);
   for(let i=0;i<colors.length/4;i++){const index=indices?indices.getScalar(i):i;expanded.set(array.subarray(index*size,(index+1)*size),i*size);}
   primitive.setAttribute(semantic,accessor.clone().setArray(expanded));
  }
  primitive.setIndices(null);
  primitive.setAttribute('COLOR_0',sourceDoc.createAccessor('Tree front/back visibility').setType('VEC4').setBuffer(sourceDoc.getRoot().listBuffers()[0]).setArray(colors));
  const material=primitive.getMaterial();material.setExtras({...material.getExtras(),webTreeSelfOcclusion:method});
 }
 await sourceDoc.transform(weld(),prune());
 if(JSON.stringify(before)!==JSON.stringify(geometryIdentity(sourceDoc)))throw Error('Tree visibility transfer changed geometry');
 return before;
}

export async function ensureTreeOcclusion(tree){
 const bytes=await fs.readFile(path.resolve(root,tree.raw)),sourceRawSha256=hash(bytes);
 const code=await codeHash();
 const fingerprint=hash(JSON.stringify({method,sourceFingerprint:tree.fingerprint,sourceRawSha256,code}));
 const directory=path.join(root,'outputs/viewer/tree-occlusion'),output=path.join(directory,fingerprint+'.glb'),receipt=path.join(directory,fingerprint+'.json');
 await fs.mkdir(directory,{recursive:true});
 if(await exists(receipt)&&await exists(output)){
  const cached=JSON.parse(await fs.readFile(receipt,'utf8'));
  if(cached.fingerprint!==fingerprint||cached.sha256!==hash(await fs.readFile(output)))throw Error('Tree visibility cache changed');
  return cached;
 }
 const scratch=path.join(directory,'tmp-'+fingerprint);await fs.mkdir(scratch,{recursive:true});
 const baked=path.join(scratch,'visibility.glb'),settings=JSON.parse(await fs.readFile(path.join(root,'data/viewer/source.json'),'utf8'));
 await new Promise((resolve,reject)=>{
  const child=spawn(path.resolve(root,settings.blender),['--disable-autoexec','--background','--factory-startup','--python-exit-code','1','--python',path.join(root,'scripts/bake_viewer_tree_occlusion.py'),'--','--input',path.resolve(root,tree.raw),'--output',baked],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,TEMP:scratch,TMP:scratch}});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Tree visibility bake exited '+code)));
 });
 const sourceDoc=await io.readBinary(new Uint8Array(bytes)),bakedDoc=await io.read(baked),geometryReceipt=await transferTreeOcclusion(sourceDoc,bakedDoc);
 const result=await io.writeBinary(sourceDoc),reloaded=await io.readBinary(result);
 if(JSON.stringify(geometryReceipt)!==JSON.stringify(geometryIdentity(reloaded)))throw Error('Saved tree visibility changed geometry');
 const nowCode=await codeHash();
 if(nowCode!==code||hash(await fs.readFile(path.resolve(root,tree.raw)))!==sourceRawSha256)throw Error('Tree visibility inputs changed during generation');
 const record={raw:path.relative(root,output).replaceAll('\\','/'),fingerprint,sha256:hash(result),method,sourceFingerprint:tree.fingerprint,sourceRawSha256,geometryReceipt,originalMaterialDataRetained:true};
 await fs.writeFile(output,result,{flag:'wx'});await fs.writeFile(receipt,JSON.stringify(record,null,2),{flag:'wx'});
 const resolved=await fs.realpath(scratch),allowed=await fs.realpath(directory);
 if(!resolved.startsWith(allowed+path.sep)||path.basename(resolved)!=='tmp-'+fingerprint)throw Error('Unexpected tree visibility scratch directory');
 await fs.rm(resolved,{recursive:true,force:true});
 console.log('TREE_SELF_OCCLUSION_READY',fingerprint);return record;
}
