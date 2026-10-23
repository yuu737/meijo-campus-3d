import type {Manifest,Asset} from './types-v2';
/** The pinned manifest owns the origin. glTF dependencies resolve beside its header. */
export function resolveManifestAssets(manifest:Manifest,pageOrigin:string):Manifest{
  const origin=new URL(manifest.assetBaseUrl||pageOrigin,pageOrigin);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)))throw new Error('Invalid asset origin');
  const resolve=(url:string)=>{
    if(!/^\/viewer\/assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(url))throw new Error('Invalid immutable asset path');
    return new URL(url,origin).href;
  };
  const asset=(value:Asset|undefined):Asset|undefined=>value?{...value,url:resolve(value.url),resources:value.resources?.map(r=>asset(r)!)}:undefined;
  return {...manifest,chunks:manifest.chunks.map(c=>({...c,full:asset(c.full)!,medium:asset(c.medium),coarse:asset(c.coarse),far:asset(c.far),...(c.lightingVariants?{lightingVariants:Object.fromEntries(Object.entries(c.lightingVariants).map(([q,v])=>[q,{...v,asset:asset(v!.asset)!}]))}:{})})),
    trees:manifest.trees?{...manifest.trees,detailed:asset(manifest.trees.detailed)!,medium:asset(manifest.trees.medium),light:asset(manifest.trees.light)!}:null,
    environment:manifest.environment?{...manifest.environment,image:{...manifest.environment.image,url:resolve(manifest.environment.image.url)}}:undefined,
    colliders:manifest.colliders?{...manifest.colliders,tiles:manifest.colliders.tiles.map(t=>({...t,url:resolve(t.url)}))}:undefined};
}
