import type { QualityLevel } from './types';
import type {Chunk,Asset} from './types-v2';

interface QualityProfile {
  label: string; description: string; renderScale: number; maxRatio: number; maxPixels: number;
  shadowSize: number; aoSamples: number; antialiasSamples: number; anisotropy: number;
  fullDistance: number; fullPixels: number; allFull: boolean; memoryMiB: number; loads: number;
}

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  low: { label:'軽量', description:'解像度を下げ、追加の影描画を省いて動作を軽くします。計算済みの昼光は保ちます。', renderScale:1, maxRatio:.85, maxPixels:700_000, shadowSize:0, aoSamples:0, antialiasSamples:0, anisotropy:2, fullDistance:15, fullPixels:Infinity, allFull:false, memoryMiB:140, loads:2 },
  balanced: { label:'標準', description:'通常の表示に適した解像度です。', renderScale:1, maxRatio:1.5, maxPixels:2_073_600, shadowSize:4096, aoSamples:0, antialiasSamples:4, anisotropy:8, fullDistance:40, fullPixels:800, allFull:false, memoryMiB:320, loads:3 },
  high: { label:'精細', description:'描画解像度を上げて、細い線や輪郭を滑らかにします。大きな画面や高密度の画面向けです。', renderScale:1.5, maxRatio:2.5, maxPixels:4_200_000, shadowSize:4096, aoSamples:0, antialiasSamples:8, anisotropy:16, fullDistance:50, fullPixels:220, allFull:false, memoryMiB:420, loads:3 },
  ultra: { label:'最高画質', description:'描画解像度と輪郭の滑らかさを高めます。', renderScale:1.25, maxRatio:2.5, maxPixels:4_200_000, shadowSize:4096, aoSamples:16, antialiasSamples:4, anisotropy:16, fullDistance:100, fullPixels:130, allFull:false, memoryMiB:420, loads:3 },
  extreme: { label:'最高画質', description:'PC・スマホ共通の最高設定です。遠景と樹木も精細形状で表示し、動作が遅くても自動では画質を下げません。', renderScale:1.5, maxRatio:3.5, maxPixels:8_300_000, shadowSize:4096, aoSamples:32, antialiasSamples:8, anisotropy:16, fullDistance:Infinity, fullPixels:0, allFull:true, memoryMiB:560, loads:3 },
};
export const MANUAL_QUALITIES = ['low','balanced','high','extreme'] as const;

/** Only separately baked, geometry-preserving images may replace native light. */
export function lightingAsset(chunk:Chunk, level:'full'|'medium'|'coarse'|'far', quality:QualityLevel, sourceHash:string, maxTextureSize=Infinity):Asset|undefined {
  const base=chunk[level];
  if(level!=='full')return base;
  const variants=Object.entries(chunk.lightingVariants??{}).filter(([,v])=>
    v.sourceModelSha256===sourceHash&&v.fullAssetSha256===chunk.full.sha256&&v.geometryPreserved&&
    v.resolution.every((n,i)=>Number.isFinite(n)&&n>0&&n>=v.atlasPackingSize[i]));
  const requested=variants.find(([key])=>key===quality)?.[1];
  const resolution=requested?.resolution??chunk.lightmapResolution;
  if(!resolution||Math.max(...resolution)<=maxTextureSize)return requested?.asset??base;
  // A physical texture limit may restrict the image, never the geometry or the
  // user's quality choice. This exception is disclosed in the settings panel.
  const supported=variants.map(([,v])=>v).filter(v=>Math.max(...v.resolution)<=maxTextureSize)
    .sort((a,b)=>b.resolution[0]*b.resolution[1]-a.resolution[0]*a.resolution[1]);
  if(supported[0])return supported[0].asset;
  const fallback=chunk.lightingFallback;
  if(fallback?.geometryPreserved&&fallback.sourceModelSha256===sourceHash&&fallback.fullAssetSha256===chunk.full.sha256)return fallback.asset;
  return requested?.asset??base;
}

/** Baked irradiance already includes occlusion: do not darken it a second time. */
export function postProcessAOSamples(quality:QualityLevel, bakedLighting:boolean, precisionDepth=false) {
  // GTAOPass reconstructs conventional depth; it cannot interpret logarithmic
  // or reversed depth. The static campus uses its baked occlusion instead.
  return bakedLighting || precisionDepth ? 0 : QUALITY_PROFILES[quality].aoSamples;
}

/** Bound both total pixels and each dimension by the actual renderer limits. */
export function renderSize(quality: QualityLevel, width: number, height: number, deviceRatio: number, maxDimension: number) {
  const profile=QUALITY_PROFILES[quality], w=Math.max(1,width), h=Math.max(1,height);
  const ratio=Math.min(Math.max(.1,deviceRatio)*profile.renderScale,profile.maxRatio,Math.sqrt(profile.maxPixels/(w*h)),maxDimension/w,maxDimension/h);
  return { ratio, width:Math.max(1,Math.floor(w*ratio)), height:Math.max(1,Math.floor(h*ratio)) };
}

export interface FrameSummary { fps:number; lowFps:number; frames:number; seconds:number; p95FrameMs:number; maxFrameMs:number; longFrames:number; freezes:number }

/** Measure delivered frames, including long frames; ignore the idle gap before starting. */
export class FrameBenchmark {
  running=false;
  elapsed=0;
  private first: number | null=null;
  private last: number | null=null;
  private intervals: number[]=[];
  constructor(readonly durationMs=30_000) {}
  start() { this.running=true;this.elapsed=0;this.first=this.last=null;this.intervals=[]; }
  stop() { this.running=false; }
  sample(now: number): FrameSummary | null {
    if(!this.running || !Number.isFinite(now)) return null;
    if(this.first===null) { this.first=this.last=now;return null; }
    const delta=now-this.last!;
    if(delta<=0) return null;
    this.intervals.push(delta);this.last=now;this.elapsed=now-this.first;
    if(this.elapsed<this.durationMs) return null;
    this.running=false;
    const tail=[...this.intervals].sort((a,b)=>b-a).slice(0,Math.max(1,Math.ceil(this.intervals.length*.01)));
    const sorted=[...this.intervals].sort((a,b)=>a-b);
    return { fps:this.intervals.length*1000/this.elapsed, lowFps:1000/(tail.reduce((sum,n)=>sum+n,0)/tail.length), frames:this.intervals.length, seconds:this.elapsed/1000,
      p95FrameMs:sorted[Math.ceil(sorted.length*.95)-1],maxFrameMs:sorted[sorted.length-1],longFrames:sorted.filter(n=>n>50).length,freezes:sorted.filter(n=>n>200).length };
  }
}
