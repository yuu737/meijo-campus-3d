import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {root,sha256} from './viewer_release.mjs';

export function validateWalking(plan){
  const assert=(ok,message)=>{if(!ok)throw new Error(`Walking plan: ${message}`);};
  const point=(p,n)=>Array.isArray(p)&&p.length===n&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<10000);
  const unique=items=>{const ids=new Set();for(const item of items){assert(/^[a-z0-9-]+$/.test(item.id)&&!ids.has(item.id),'invalid/duplicate ID');ids.add(item.id);}return ids;};
  assert(plan?.schema==='tempaku-walking-1','unsupported schema');
  assert(Array.isArray(plan.places)&&plan.places.length>0,'no destinations');
  assert(Array.isArray(plan.routes)&&plan.routes.length>0,'no regression routes');
  const ids=unique(plan.places);unique(plan.routes);
  assert(ids.has(plan.defaultPlaceId),'default destination missing');
  for(const p of plan.places){
    assert(typeof p.label==='string'&&p.label.trim().length>0,'destination label missing');
    assert(point(p.position,3)&&point(p.target,3),'invalid destination coordinates');
    assert(Math.hypot(p.target[0]-p.position[0],p.target[2]-p.position[2])>.01,'destination has no facing direction');
    assert(p.pitch===undefined||(Number.isFinite(p.pitch)&&Math.abs(p.pitch)<1.4),'invalid destination pitch');
  }
  for(const r of plan.routes)assert(Array.isArray(r.points)&&r.points.length>=2&&r.points.every(p=>point(p,2))&&Number.isFinite(r.height)&&Number.isFinite(r.endHeight),'invalid route');
  return plan;
}

export async function walkingCodeSha(){
  const files=['app/viewer/rapier-walk.ts','app/viewer/collider-loader.ts','app/viewer/collider-worker.ts','scripts/audit_viewer_walking.mjs','scripts/viewer_walking.mjs'];
  return sha256(Buffer.concat(await Promise.all(files.map(f=>readFile(path.join(root,f))))));
}
export async function verifyWalkingReceipt(manifest,text){
  validateWalking(manifest.walking);
  let receipt;
  try{receipt=JSON.parse(await readFile(path.join(root,'outputs/viewer/walking',manifest.release+'.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;receipt=JSON.parse(await readFile(path.join(root,'data/viewer/release-receipt.json'),'utf8')).walkingAudit;}
  if(!receipt)throw new Error('Walking audit is missing; run npm run viewer:walk:validate');
  if(receipt.manifestSha256!==sha256(text)||receipt.sourceModelSha256!==manifest.source.sha256||receipt.codeSha256!==await walkingCodeSha()||!receipt.pass)
    throw new Error('Walking audit is stale or failed; run npm run viewer:walk:validate');
  return receipt;
}
