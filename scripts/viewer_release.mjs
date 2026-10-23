import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const web=path.join(root,'web-public');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const immutablePattern=/^\/viewer\/assets\/([a-f0-9]{64})\.(gltf|bin|ktx2|glb|webp|png|jpg|hdr)$/;
export const mimeFor=url=>({gltf:'model/gltf+json',glb:'model/gltf-binary',bin:'application/octet-stream',ktx2:'image/ktx2',webp:'image/webp',png:'image/png',jpg:'image/jpeg',hdr:'image/vnd.radiance',json:'application/json'})[url.split('.').at(-1)]??'application/octet-stream';
export const argument=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
export function safeWebPath(url){
  if(!immutablePattern.test(url))throw new Error(`Invalid immutable asset path: ${url}`);
  return path.join(web,...url.slice(1).split('/'));
}
export async function loadRelease(file=argument('--manifest','viewer/current.json')){
  const absolute=path.resolve(web,file);
  if(!absolute.startsWith(web+path.sep))throw new Error('Manifest escapes Web root');
  const text=await readFile(absolute,'utf8'),manifest=JSON.parse(text);
  if(manifest.schema!=='tempaku-viewer-1'||!/^[a-f0-9]{20}$/.test(manifest.release)||!Array.isArray(manifest.chunks)||!manifest.chunks.length||!/^[a-f0-9]{64}$/.test(manifest.source?.sha256))throw new Error('Invalid release manifest');
  if(manifest.colliders?.sourceModelSha256!==manifest.source.sha256)throw new Error('Rendering and collision must use the same model');
  if(manifest.lightmaps&&manifest.lightmaps.sourceModelSha256!==manifest.source.sha256)throw new Error('Lighting/model mismatch');
  return {manifest,text,absolute};
}
export function releaseAssets(manifest){
  const entries=new Map();
  const add=a=>{
    if(!a)return;
    const match=a.url?.match(immutablePattern);
    if(!match||match[1]!==a.sha256)throw new Error(`Asset is not content-addressed: ${a.url}`);
    const bytes=a.resources?a.bytes-a.resources.reduce((n,r)=>n+r.bytes,0):a.bytes;
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw new Error('Invalid physical asset size');
    const old=entries.get(a.url);
    if(old&&(old.sha256!==a.sha256||old.bytes!==bytes))throw new Error('Conflicting asset metadata');
    entries.set(a.url,{url:a.url,sha256:a.sha256,bytes,contentType:mimeFor(a.url)});
    for(const resource of a.resources??[])add(resource);
  };
  for(const chunk of manifest.chunks)for(const level of ['full','medium','coarse','far'])add(chunk[level]);
  for(const chunk of manifest.chunks)for(const variant of Object.values(chunk.lightingVariants??{}))add(variant.asset);
  for(const chunk of manifest.chunks)add(chunk.lightingFallback?.asset);
  if(manifest.trees){add(manifest.trees.light);add(manifest.trees.medium);add(manifest.trees.detailed);}
  if(manifest.environment)add(manifest.environment.image);
  for(const tile of manifest.colliders?.tiles??[])add(tile);
  return [...entries.values()].sort((a,b)=>a.url.localeCompare(b.url));
}
export async function checkLocalAssets(manifest){
  const assets=releaseAssets(manifest);
  for(const asset of assets){const bytes=await readFile(safeWebPath(asset.url));
    if(bytes.length!==asset.bytes||sha256(bytes)!==asset.sha256)throw new Error(`Asset changed: ${asset.url}`);}
  return assets;
}
export function assetOrigin(value){
  if(!value)return '';
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname.endsWith('.r2.dev'))throw new Error('Use an HTTPS custom origin for model assets');
  return url.origin;
}
export async function verifyRemoteAssets(manifest,origin){
  const assets=releaseAssets(manifest);let cursor=0;
  await Promise.all(Array.from({length:6},async()=>{
    while(cursor<assets.length){const asset=assets[cursor++];
      const response=await fetch(origin+asset.url,{method:'HEAD',headers:{Origin:'https://meijo.yuustudio.app'},signal:AbortSignal.timeout(30000)});
      if(!response.ok||Number(response.headers.get('content-length'))!==asset.bytes||response.headers.get('x-amz-meta-sha256')!==asset.sha256)throw new Error(`Remote asset is not verified: ${asset.url}`);
      if(!(response.headers.get('content-type')??'').startsWith(asset.contentType))throw new Error(`Wrong asset MIME: ${asset.url}`);
      if(!response.headers.get('access-control-allow-origin'))throw new Error(`CORS missing: ${asset.url}`);
      if(!response.headers.get('timing-allow-origin'))throw new Error(`Resource Timing header missing: ${asset.url}`);
    }
  }));
  return assets;
}
