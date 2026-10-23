/** Make a checked rendering and walking inventory for lightweight CI. */
import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {root,web,loadRelease,checkLocalAssets,sha256} from './viewer_release.mjs';
import {verifyWalkingReceipt} from './viewer_walking.mjs';
if(process.argv.includes('--activate'))throw new Error('Use npm run model:activate to activate a candidate with the model hash, update lock and walking gate');
const {manifest,text,absolute}=await loadRelease();
await new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['scripts/validate_viewer_v3.mjs','--manifest',path.relative(web,absolute)],{cwd:root,stdio:'inherit',windowsHide:true});
  p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('Model validation failed')));
});
await new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['scripts/audit_viewer_walking.mjs','--manifest',path.relative(web,absolute)],{cwd:root,stdio:'inherit',windowsHide:true});
  p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('Walking validation failed')));
});
const {places,routes,...walkingAudit}=await verifyWalkingReceipt(manifest,text);
const assets=await checkLocalAssets(manifest);
const receipt={schema:'tempaku-release-receipt-1',release:manifest.release,revision:manifest.revision,sourceModelSha256:manifest.source.sha256,
  manifestSha256:sha256(text),assetListSha256:sha256(JSON.stringify(assets)),assets:assets.length,uniqueAssetBytes:assets.reduce((n,a)=>n+a.bytes,0),
  validation:'passed',walkingAudit,generatedAt:new Date().toISOString()};
await mkdir(path.join(root,'data/viewer'),{recursive:true});
await writeFile(path.join(root,'data/viewer/release-receipt.json'),JSON.stringify(receipt,null,2));
console.log('RELEASE_PREPARED',JSON.stringify({...receipt,published:false}));
