/** Build lower native atlases from full illumination; optionally follow its active bake. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './viewer_release.mjs';
import {repackCodeHash,repackLightmap} from './repack_viewer_daylight.mjs';
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback,prefix=arg('--experiment','');
if(!/^[a-z0-9][a-z0-9-]{0,48}$/.test(prefix))throw Error('An isolated experiment prefix is required');
const full=path.join(root,'outputs/viewer/experiments',prefix+'-full'),source=JSON.parse(await fs.readFile(path.join(full,'export/source-manifest.json'),'utf8')),environment=JSON.parse(await fs.readFile(path.join(full,'environment.json'),'utf8'));
if(environment.sunIntensity!==0||environment.sourceModelSha256!==source.source.sha256)throw Error('Native reprojection requires the same saved World without a separate Sun');
const ids=source.chunks.filter(c=>c.lighting!=='dynamic'&&!['interior','context'].includes(c.kind)).map(c=>c.id),codeHash=await repackCodeHash();
const options={balanced:Number(arg('--balanced-size','1024')),low:Number(arg('--low-size','512'))};
if(!Object.values(options).every(n=>Number.isInteger(n)&&n>=128&&n<=2048))throw Error('Invalid target atlas density');
const outputs={};
for(const quality of Object.keys(options)){
 const directory=path.join(root,'outputs/viewer/experiments',prefix+'-'+quality);await fs.mkdir(directory,{recursive:true});
 await fs.cp(path.join(full,'export'),path.join(directory,'export'),{recursive:true});await fs.copyFile(path.join(full,'environment.json'),path.join(directory,'environment.json'));
 await fs.mkdir(path.join(directory,'daylight'),{recursive:true});outputs[quality]=directory;
}
async function exists(file){try{await fs.access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function readJson(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function yieldToNativeBake(){
 if(!args.includes('--yield-to-native-bake'))return;
 const lock=path.join(full,'update-v3.lock'),directory=path.join(full,'daylight');
 for(;;){
  if(!await exists(lock)||(await readJson(path.join(directory,'index.json'))).complete)return;
  // Large Cycles render buffers overlap poorly with a second raster process.
  // A current linear file exists only after GPU baking and during CPU encoding.
  // The following GPU bake still has minutes of setup/rendering after it ends.
  let started;try{started=(await fs.stat(lock)).mtimeMs;}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const name of await fs.readdir(directory))if(name.endsWith('.linear.npz')){
   try{if((await fs.stat(path.join(directory,name))).mtimeMs>=started)return;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
}
const records={balanced:{},low:{}};
for(;;){
 if(await repackCodeHash()!==codeHash)throw Error('Repacking code changed');
 const currentSource=await readJson(path.join(full,'export/source-manifest.json'));if(JSON.stringify(currentSource)!==JSON.stringify(source))throw Error('Source export changed during derivation');
 const base=await readJson(path.join(full,'daylight/index.json'));if(base.sourceModelSha256!==source.source.sha256)throw Error('Lighting source mismatch');
 for(const id of ids){const baked=base.targets[id];if(!baked)continue;
  for(const [quality,atlasSize]of Object.entries(options)){
   if(records[quality][id]?.derivation.sourceFingerprint===baked.fingerprint)continue;
   await yieldToNativeBake();
   const record=await repackLightmap({sourceModelSha256:source.source.sha256,source:baked,output:path.join(outputs[quality],'daylight'),atlasSize,codeHash});records[quality][id]=record;
   const result={schema:'tempaku-daylight-1',sourceModelSha256:source.source.sha256,mode:base.mode,lighting:base.lighting,derivation:'full-native-chart-reprojection-v1',targets:records[quality],complete:ids.every(key=>base.targets[key]&&records[quality][key]?.derivation.sourceFingerprint===base.targets[key].fingerprint)};
   const pending=path.join(outputs[quality],'daylight/index.pending.json');await fs.writeFile(pending,JSON.stringify(result,null,2));await fs.rename(pending,path.join(outputs[quality],'daylight/index.json'));
   console.log('NATIVE_LIGHTING_VARIANT',quality,id,record.bakeResolution,record.seconds.toFixed(2));
  }
 }
 const active=await exists(path.join(full,'update-v3.lock'));
 let candidate=null;try{candidate=await readJson(path.join(root,'web-public/viewer','candidate-'+prefix+'-full.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const completed=base.complete&&!active&&candidate?.source.sha256===source.source.sha256&&candidate.lightmaps?.scope==='outdoor'&&ids.every(id=>candidate.chunks.find(c=>c.id===id)?.lightmapSourceFingerprint===base.targets[id]?.fingerprint);
 if(completed){console.log('NATIVE_LIGHTING_VARIANTS_COMPLETE',ids.length);break;}
 if(args.includes('--available')){console.log('NATIVE_LIGHTING_VARIANTS_PARTIAL',Object.keys(base.targets).length,ids.length);break;}
 if(!args.includes('--follow'))throw Error('Full lighting must complete before deriving all variants');
 if(!active)throw Error('Full lighting build stopped before a validated complete release was available');
 await new Promise(resolve=>setTimeout(resolve,15000));
}
