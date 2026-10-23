export type Vec3 = [number, number, number];
export type Quality = 'extreme' | 'ultra' | 'high' | 'balanced' | 'low';
export type QualityLevel = Quality;
export type NavigationMode = 'orbit' | 'walk' | 'fly';
export type WalkPlace = string;
export interface WalkingPlace { id:string; label:string; position:Vec3; target:Vec3; pitch?:number }
export interface WalkingPlan { schema:'tempaku-walking-1'; defaultPlaceId:string; places:WalkingPlace[]; routes:{id:string;points:[number,number][];height:number;endHeight:number}[] }
export type Trees = 'detailed' | 'light' | 'off';
export type ChunkKind = 'terrain' | 'exterior' | 'site' | 'context' | 'interior';
export interface Asset { url:string; bytes:number; triangles:number; sha256:string; resources?:Asset[] }
export interface SavedEnvironment { schema:'tempaku-environment-1';sourceModelSha256:string;lightingSignature:string;world:string;image:{url:string;bytes:number;sha256:string};resolution:[number,number];exposure:number;viewTransform:string;look:string;diffuseFill:[number,number,number];sunIntensity:number }
export interface LODValidation {
  status:'passed'|'failed'; sourceModelSha256:string; fullAssetSha256:string; assetSha256:string;
  maxDiameterPixels:number; maxSilhouetteErrorPixels:number; directions:number;
  checks:{openings:boolean; intersections:boolean; joins:boolean; shading:boolean};
}
export interface LightingFallback { asset:Asset; sourceModelSha256:string; fullAssetSha256:string; geometryPreserved:true }
export interface LightingVariant extends LightingFallback { resolution:[number,number]; atlasPackingSize:[number,number] }
export interface Chunk { id:string; navigationGroup?:string; kind:ChunkKind; building?:string; label?:string; floor?:string; bounds:[Vec3,Vec3]; sourceObjects:number; full:Asset; medium?:Asset; coarse?:Asset; far?:Asset; lightmapResolution?:[number,number]; lodValidation?:Partial<Record<'medium'|'coarse'|'far',LODValidation>>; lightingFallback?:LightingFallback; lightingVariants?:Partial<Record<'low'|'balanced',LightingVariant>> }
export interface NavigationAsset { url:string; sha256:string; bytes:number; policy?:string; sourceModelSha256?:string }

export interface ReviewCameraAPI { setView?(position:Vec3,target:Vec3):void }
export interface ColliderTile { id:string; cell:[number,number]; bounds:[Vec3,Vec3]; url:string; sha256:string; bytes:number; triangles:number }
export interface ColliderManifest { schema:'tempaku-colliders-1'; policy:'authored-surfaces-v1'; sourceModelSha256:string; tileSize:number; tiles:ColliderTile[]; bytes:number }
export interface Manifest { environment?:SavedEnvironment; walking?:WalkingPlan; schema:'tempaku-viewer-1'; revision:string; release:string; generatedAt:string; bounds:[Vec3,Vec3]; home:{position:Vec3;target:Vec3}; chunks:Chunk[]; trees:{detailed:Asset;medium?:Asset;light:Asset;transforms:number[][];renderMode?:'unlit-shared'|'pbr-lod';brightness?:number;attribution?:string}|null; source:{filename:string;sha256:string;objects:number}; debugCampus?:boolean; includeInteriors?:boolean; navigation?:NavigationAsset; colliders?:ColliderManifest; assetBaseUrl?:string; lightmaps?:{mode:string;targets:string[]}|null }
export interface ViewerOptions { quality:Quality; trees:Trees; shadows:boolean; exposure:number; interiors?:boolean; walkSpeed?:number; lookSensitivity?:number; occlusion?:boolean; lightmaps?:boolean; memoryMiB?:number }
export interface BenchmarkResult { id:number; quality:QualityLevel; fps:number; lowFps:number; frames:number; seconds:number; p95FrameMs:number; maxFrameMs:number; longFrames:number; freezes:number; width:number; height:number; shadowSize:number; aoSamples:number; antialiasSamples:number; revision:string; position:Vec3 }
export interface Destination { id:string; label:string; interior:boolean }
export interface ViewerStatus { walkingPlaces?:{id:string;label:string}[]; modelUpdateAvailable?:boolean; phase:'loading'|'ready'|'error'; message:string; loaded:number; total:number; revision:string; azimuth:number; distance:number; fps:number; mode:NavigationMode; effectiveQuality:QualityLevel; groundReady:boolean; treesAvailable:boolean; renderWidth:number; renderHeight:number; drawCalls:number; triangles:number; residentMiB:number; release?:string; sourceFilename?:string; navigationPolicy?:string; navigationLoading?:boolean; navigationMiB?:number; rendererBackend?:string; rendererFallback?:string; occlusionDeferred?:number; lightmappedMeshes?:number; bakedLightingMode?:string; compressedTextures?:number; destinations?:Destination[]; benchmarking:boolean; benchmarkRemaining:number; benchmarkResults:BenchmarkResult[]; benchmarkMessage:string }
export interface ViewerAPI extends ReviewCameraAPI { home():void; top():void; north():void; zoom(direction:number):void; setOptions(options:ViewerOptions):void; retry():void; destroy():void; setMode(mode:NavigationMode):void; move(x:number,forward:number,up?:number):void; jump():void; goTo(place:WalkPlace):void; goToChunk?(id:string):void; recover?():void; shareView?():string; lockPointer?():void; pause?():void; reviewView?(id:string):void; startBenchmark():void; stopBenchmark():void }
