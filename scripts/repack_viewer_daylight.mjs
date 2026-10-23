/** Resample illumination through triangle UVs into newly packed, padded atlases. */
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {weld,prune} from '@gltf-transform/functions';
import {chromium} from '../.tooling/web-render-qa/node_modules/playwright-core/index.mjs';
import {geometryIdentity} from './viewer_geometry_identity.mjs';
import {preserveExactNodeTransforms} from './viewer_gltf_transforms.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const method='full-native-chart-reprojection-v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const codeFiles=['repack_viewer_daylight.mjs','repack_lightmap_uv.py','encode_repacked_lightmap.py','raster_repacked_lightmap.html','viewer_gltf_transforms.mjs'];
// Before 2026-10-21 repack_lightmap_uv.py did not pack sparse atlases again at twice the size. Its results are
// identical to the current code's whenever the first packing covered more than 5 % of the atlas. The second hash is
// the sparse-repacking code before this reuse rule was added.
const LEGACY_CODE_HASHES=['b4fceb081bf4434b7f17b29ab12ea3f9f0c440904e48962548314f8c4cc58796','d9096049c6538babd4e19d9811b5b275e2ba604ec230b1a9e81fec1e2d4409dc'];
export async function repackCodeHash(){return hash(Buffer.concat(await Promise.all(codeFiles.map(name=>fs.readFile(path.join(root,'scripts',name))))));}
async function exists(file){try{await fs.access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function python(script,args,python){await new Promise((resolve,reject)=>{const p=spawn(python,[path.join(root,'scripts',script),...args],{stdio:'inherit',windowsHide:true});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(script+' exited '+code)));});}
async function rasterize(directory,plan,ranges){
 let uploaded,uploadFailed;const upload=new Promise((resolve,reject)=>{uploaded=resolve;uploadFailed=reject;});
 const expected=plan.bakeResolution[0]*plan.bakeResolution[1]*16;
 const timer=setTimeout(()=>uploadFailed(Error('Lightmap reprojection timed out')),180000);
 // The page uploads row bands to /part (each at its byte offset), then confirms with /result.
 const projected=await fs.open(path.join(directory,'projected.rgba32f'),'w');let size=0;
 const server=http.createServer(async(req,res)=>{try{
  if(req.method==='POST'&&req.url==='/part'){
   const offset=Number(req.headers['x-offset']);if(!Number.isSafeInteger(offset)||offset!==size)throw Error('Projection band out of order');
   const chunks=[];let length=0;
   await new Promise((resolve,reject)=>{req.on('data',b=>{length+=b.length;if(offset+length>expected)req.destroy(Error('Oversized projection'));else chunks.push(b);});req.on('end',resolve);req.on('error',reject);});
   await projected.write(Buffer.concat(chunks,length),0,length,offset);size+=length;res.end('ok');return;
  }
  if(req.method==='POST'&&req.url==='/result'){
   if(size!==expected)throw Error('Truncated projection');
   const stats=JSON.parse(req.headers['x-raster-stats']);
   if(stats.width!==plan.bakeResolution[0]||stats.height!==plan.bakeResolution[1]||stats.bytes!==expected)throw Error('Projection metadata differs');
   uploaded(stats);res.end('ok');return;
  }
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file=req.url==='/'?path.join(root,'scripts/raster_repacked_lightmap.html'):['/geometry.bin','/source.png'].includes(req.url)?path.join(directory,req.url.slice(1)):null;
  if(req.method!=='GET'||!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',req.url==='/'?'text/html':req.url==='/source.png'?'image/png':'application/octet-stream');
  const input=createReadStream(file);input.on('error',error=>{uploadFailed(error);res.destroy(error);});input.pipe(res);
 }catch(e){uploadFailed(e);res.writeHead(500);res.end(String(e));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.VIEWER_QA_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const page=await browser.newPage();page.on('console',message=>console.log('REPACK_BROWSER',message.text()));await page.goto('http://127.0.0.1:'+server.address().port);
  // Completion is the checked file upload. Closing the page then releases the
  // large float framebuffer without waiting for a second browser copy of it.
  page.evaluate(spec=>window.run(spec),{resolution:plan.bakeResolution,ranges:ranges.map(({start,count,lit})=>({start,count,lit}))}).catch(uploadFailed);
  return await upload;
 }finally{clearTimeout(timer);await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await projected.close().catch(()=>{});}
}
export async function repackLightmap({sourceModelSha256,source,output,atlasSize,python:pythonPath='python',codeHash}){
 const started=performance.now(),input=path.resolve(root,source.raw),inputBytes=await fs.readFile(input),sourceRawSha256=hash(inputBytes);
 const fingerprint=hash(JSON.stringify({method,sourceModelSha256,sourceFingerprint:source.fingerprint,sourceRawSha256,atlasSize,codeHash}));
 const destination=path.resolve(output);await fs.mkdir(destination,{recursive:true});
 const result=path.join(destination,fingerprint+'.glb'),receipt=path.join(destination,fingerprint+'.json');
 if(await exists(receipt)&&await exists(result)){
  const cached=JSON.parse(await fs.readFile(receipt,'utf8'));
  if(cached.fingerprint!==fingerprint||cached.derivedSha256!==hash(await fs.readFile(result)))throw Error('Repacked cache integrity failure');
  return cached;
 }
 // Results of an earlier code version stay valid when the change cannot affect them (see LEGACY_CODE_HASHES).
 for(const legacy of LEGACY_CODE_HASHES){
  const old=hash(JSON.stringify({method,sourceModelSha256,sourceFingerprint:source.fingerprint,sourceRawSha256,atlasSize,codeHash:legacy}));
  const oldResult=path.join(destination,old+'.glb'),oldReceipt=path.join(destination,old+'.json');
  if(!(await exists(oldReceipt)&&await exists(oldResult)))continue;
  const cached=JSON.parse(await fs.readFile(oldReceipt,'utf8'));
  if(cached.fingerprint!==old||cached.derivedSha256!==hash(await fs.readFile(oldResult)))throw Error('Repacked cache integrity failure');
  if(cached.uvCoverage>.05)return cached;
 }
 const scratchRoot=path.join(destination,'repack-tmp'),scratch=path.join(scratchRoot,fingerprint);await fs.mkdir(scratch,{recursive:true});
 const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),doc=await io.readBinary(new Uint8Array(inputBytes)),before=geometryIdentity(doc),ranges=[];
 let count=0,vertices=0;const materials=doc.getRoot().listMaterials(),lightTextures=new Set();
 for(const node of doc.getRoot().listNodes())if(node.getMesh()){
  if(node.getExtension('EXT_mesh_gpu_instancing'))throw Error('Static lightmap receiver has instances');
  for(const primitive of node.getMesh().listPrimitives()){
   if(primitive.getMode()!==4)throw Error('Expected triangle primitives');
   const material=primitive.getMaterial(),positions=primitive.getAttribute('POSITION'),indices=primitive.getIndices(),length=indices?.getCount()??positions.getCount(),lit=!!material?.getExtras().webLightmap;
   if(lit){
    if(material.getName().includes('_WebThinGlass'))throw Error('Original glass was not restored before full baking');
    if(!material.getEmissiveTexture())throw Error('Missing full irradiance texture');
    if(material.getEmissiveTextureInfo().getExtension('KHR_texture_transform'))throw Error('Transformed lightmap UVs require explicit handling');
    if(Math.abs(material.getExtras().webLightmapGain-source.gain)>1e-6)throw Error('Full lightmap gains differ');
    lightTextures.add(material.getEmissiveTexture());
   }
   ranges.push({primitive,material,positions,indices,matrix:node.getWorldMatrix(),start:count,count:length,lit,texCoord:lit?material.getEmissiveTextureInfo().getTexCoord():1,materialId:materials.indexOf(material)});count+=length;vertices+=positions.getCount();
  }
 }
 if(lightTextures.size!==1)throw Error('Expected one source lightmap');
 const light=[...lightTextures][0];await fs.writeFile(path.join(scratch,'source.png'),light.getImage());
 const alpha=await sharp(light.getImage()).ensureAlpha().raw().toBuffer();
 for(let i=3;i<alpha.length;i+=4)if(alpha[i]!==255)throw Error('This reprojection only supports saved Worlds without a separate Sun visibility map');
 const positions=new Float32Array(count*3),ids=new Uint32Array(count),oldUV=new Float32Array(count*2);
 for(const r of ranges){const m=r.matrix,uv=r.primitive.getAttribute('TEXCOORD_'+r.texCoord);if(r.lit&&!uv)throw Error('Missing source light UV');for(let j=0;j<r.count;j++){
  const index=r.indices?r.indices.getScalar(j):j,[x,y,z]=r.positions.getElement(index,[]),offset=r.start+j;
  positions.set([m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]],offset*3);ids[offset]=r.materialId;if(uv)oldUV.set(uv.getElement(index,[]),offset*2);
 }}
 await Promise.all([fs.writeFile(path.join(scratch,'positions.bin'),Buffer.from(positions.buffer)),fs.writeFile(path.join(scratch,'materials.bin'),Buffer.from(ids.buffer)),fs.writeFile(path.join(scratch,'input.json'),JSON.stringify({vertices,corners:count}))]);
 const size=atlasSize*(before.triangles>50000?2:1);
 await python('repack_lightmap_uv.py',[scratch,String(size)],pythonPath);
 const plan=JSON.parse(await fs.readFile(path.join(scratch,'plan.json'),'utf8')),uvBytes=await fs.readFile(path.join(scratch,'new-uv.bin')),newUV=new Float32Array(uvBytes.buffer,uvBytes.byteOffset,uvBytes.byteLength/4);
 if(newUV.length!==count*2)throw Error('Repacked UV corner count differs');
 const attributes=new Float32Array(count*4);for(let i=0;i<count;i++){attributes.set(newUV.subarray(i*2,i*2+2),i*4);attributes.set(oldUV.subarray(i*2,i*2+2),i*4+2);}await fs.writeFile(path.join(scratch,'geometry.bin'),Buffer.from(attributes.buffer));
 let raster;
 for(let attempt=0;attempt<2;attempt++){
  try{raster=await rasterize(scratch,plan,ranges);break;}catch(error){if(attempt===1)throw error;console.warn('REPACK_RETRY',String(error));}
 }
 await python('encode_repacked_lightmap.py',[scratch],pythonPath);
 const encoding=JSON.parse(await fs.readFile(path.join(scratch,'encoding.json'),'utf8'));
 const replacement=doc.createTexture('Native repacked irradiance').setImage(await fs.readFile(path.join(scratch,'repacked.png'))).setMimeType('image/png');
 for(const r of ranges){const p=r.primitive;for(const semantic of p.listSemantics()){
  const accessor=p.getAttribute(semantic),array=accessor.getArray(),components=accessor.getElementSize(),expanded=new array.constructor(r.count*components);
  for(let i=0;i<r.count;i++){const index=r.indices?r.indices.getScalar(i):i;expanded.set(array.subarray(index*components,(index+1)*components),i*components);}p.setAttribute(semantic,accessor.clone().setArray(expanded));
 }p.setIndices(null);if(r.lit){p.setAttribute('TEXCOORD_'+r.texCoord,doc.createAccessor('NativeChartUV').setType('VEC2').setBuffer(doc.getRoot().listBuffers()[0]).setArray(new Float32Array(newUV.subarray(r.start*2,(r.start+r.count)*2))));r.material.setEmissiveTexture(replacement);}}
 await doc.transform(weld(),prune());const pending=path.join(scratch,'result.glb');
 await fs.writeFile(pending,preserveExactNodeTransforms(await io.writeBinary(doc),doc));
 const after=geometryIdentity(await io.read(pending));if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Native atlas repacking changed geometry');
 if(await repackCodeHash()!==codeHash)throw Error('Repacking code changed during generation');
 const derivedBytes=await fs.readFile(pending),derivedSha256=hash(derivedBytes);await fs.writeFile(result,derivedBytes,{flag:'wx'});
 await fs.copyFile(path.join(scratch,'repacked.png'),path.join(destination,fingerprint+'.png'));
 const record={raw:path.relative(root,result).replaceAll('\\','/'),fingerprint,gain:source.gain,mode:source.mode,receivers:source.receivers,triangles:before.triangles,size,...plan,...encoding,derivedSha256,
  seconds:(performance.now()-started)/1000,derivation:{method,sourceModelSha256,sourceFingerprint:source.fingerprint,sourceRawSha256,geometryReceipt:after},raster,contributors:source.contributors,treeContributors:source.treeContributors};
 await fs.writeFile(receipt,JSON.stringify(record,null,2),{flag:'wx'});
 const resolved=await fs.realpath(scratch),allowed=await fs.realpath(scratchRoot);
 if(!resolved.startsWith(allowed+path.sep))throw Error('Unexpected scratch directory');
 await fs.rm(resolved,{recursive:true,force:true});
 return record;
}
