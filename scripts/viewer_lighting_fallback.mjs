/** Remove baked illumination while retaining the exact already-validated geometry. */
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {web,sha256} from './viewer_release.mjs';
export async function exactUnbakedFallback(full,unbaked){
 const gltf=JSON.parse(await readFile(path.join(web,full.url),'utf8'));
 const original=JSON.parse(await readFile(path.join(web,unbaked.url),'utf8'));
 restoreUnbakedEmission(gltf,original);
 // Buffer/vertex/index bytes are not rewritten or rounded. Unreferenced atlas
 // images are harmless metadata; GLTFLoader only loads material dependencies.
 const bytes=Buffer.from(JSON.stringify(gltf)),hash=sha256(bytes),url='/viewer/assets/'+hash+'.gltf';
 try{await writeFile(path.join(web,url),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
 return {...full,url,sha256:hash,bytes:bytes.length+(full.resources??[]).reduce((s,r)=>s+r.bytes,0)};
}
export function restoreUnbakedEmission(gltf,original){
 const stem=name=>(name??'').replace(/(?:\.\d{3})+$/,'');
 const emission=m=>JSON.stringify([m.emissiveFactor??[0,0,0],m.extensions?.KHR_materials_emissive_strength?.emissiveStrength??1]);
 const restores=[];
 for(const material of gltf.materials??[]){
  if(!material.extras?.webLightmap)continue;
  const matches=(original.materials??[]).filter(m=>stem(m.name)===stem(material.name));
  // Blender renumbers duplicates during joining. Several source materials can
  // share a stem while differing in colour. Only emission is restored here,
  // so accept that ambiguity only when every candidate agrees on emission.
  if(!matches.length||matches.some(m=>m.emissiveTexture)||new Set(matches.map(emission)).size!==1)throw new Error('Cannot safely restore original emission: '+material.name);
  restores.push([material,matches[0]]);
 }
 // Validate all matches before mutating any material.
 for(const [material,source] of restores){
  delete material.emissiveTexture;
  if(source.emissiveFactor)material.emissiveFactor=source.emissiveFactor;else delete material.emissiveFactor;
  if(material.extensions)delete material.extensions.KHR_materials_emissive_strength;
  if(source.extensions?.KHR_materials_emissive_strength){material.extensions??={};material.extensions.KHR_materials_emissive_strength=source.extensions.KHR_materials_emissive_strength;}
  for(const key of Object.keys(material.extras))if(key.startsWith('webLightmap'))delete material.extras[key];
 }
}
