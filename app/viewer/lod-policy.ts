import type { Chunk } from './types-v2';
export const LOD_LEVELS=['full','medium','coarse','far'] as const;
export type LODLevel=typeof LOD_LEVELS[number];
export interface LODProfile {allFull:boolean;fullDistance:number;fullPixels:number}
/** A receipt is valid only for these exact source and derived assets. */
export function validatedLOD(chunk:Chunk,level:LODLevel,sourceHash:string,pixels:number):boolean {
  if(level==='full')return true;
  const v=chunk.lodValidation?.[level];
  return !!v&&v.status==='passed'&&/^[a-f0-9]{64}$/.test(sourceHash)&&v.sourceModelSha256===sourceHash&&
    v.fullAssetSha256===chunk.full.sha256&&v.assetSha256===chunk[level]?.sha256&&
    Number.isFinite(v.maxDiameterPixels)&&v.maxDiameterPixels>0&&Number.isFinite(pixels)&&pixels>=0&&pixels<=v.maxDiameterPixels&&
    Number.isFinite(v.maxSilhouetteErrorPixels)&&v.maxSilhouetteErrorPixels>=0&&v.maxSilhouetteErrorPixels<=1&&
    Number.isInteger(v.directions)&&v.directions>=4&&!!v.checks&&
    ['openings','intersections','joins','shading'].every(k=>v.checks[k as keyof typeof v.checks]===true);
}
/** Only validated reductions may replace authored geometry, using drawing pixels. */
export function chooseLOD(chunk:Chunk,profile:LODProfile,distance:number,pixels:number,
  previous:LODLevel|null,interior:boolean,occluded=false,sourceHash=''):LODLevel {
  if(profile.allFull||interior||distance<profile.fullDistance)return 'full';
  // Occlusion may defer a refinement; it cannot authorize an invalid reduction.
  if(occluded&&previous&&validatedLOD(chunk,previous,sourceHash,pixels))return previous;
  for(const level of ['far','coarse','medium'] as const){
    const limit=chunk.lodValidation?.[level]?.maxDiameterPixels??0;
    // Enter at 80% of the verified limit; retain until the verified limit itself.
    if(pixels<=limit*(previous===level?1:.8)&&validatedLOD(chunk,level,sourceHash,pixels))return level;
  }
  return 'full';
}
/** CPU/GPU resident texture estimate, using actual compressed mip payloads when available. */
export function estimateTextureBytes(texture:{mipmaps?:unknown[];image?:unknown;generateMipmaps?:boolean}):number {
  const mips=texture.mipmaps as {data?:ArrayBufferView}[]|undefined;
  if(mips?.length&&mips.every(m=>m.data&&ArrayBuffer.isView(m.data)))
    return mips.reduce((sum,m)=>sum+m.data!.byteLength,0);
  const image=texture.image as {width?:number;height?:number;data?:ArrayBufferView}|undefined;
  if(image?.data&&ArrayBuffer.isView(image.data))return image.data.byteLength*(texture.generateMipmaps?4/3:1);
  return image?.width&&image.height?image.width*image.height*4*(texture.generateMipmaps?4/3:1):0;
}
