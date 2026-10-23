export type Vec3 = [number, number, number];
export type Quality = 'auto' | 'extreme' | 'ultra' | 'high' | 'balanced' | 'low';
export type QualityLevel = Exclude<Quality, 'auto'>;
export type NavigationMode = 'orbit' | 'walk' | 'fly';
export type WalkPlace = 'gate' | 'arena' | 'library' | 'tower' | 'east-road' | 'sunken' | 'grand-stair' | 'research';
export type Trees = 'detailed' | 'light' | 'off';
export type ChunkKind = 'terrain' | 'exterior' | 'site' | 'context' | 'interior';
export interface Asset { url: string; bytes: number; triangles: number; sha256: string }
export interface Chunk {
  id: string;
  kind: ChunkKind;
  building?: string;
  bounds: [Vec3, Vec3];
  sourceObjects: number;
  full: Asset;
  coarse?: Asset;
}
export interface Manifest {
  schema: 'tempaku-viewer-1';
  revision: string;
  release: string;
  generatedAt: string;
  bounds: [Vec3, Vec3];
  home: { position: Vec3; target: Vec3 };
  chunks: Chunk[];
  trees: { detailed: Asset; light: Asset; transforms: number[][] } | null;
  source: { filename: string; sha256: string; objects: number };
  debugCampus?: boolean;
  navigation?: { url: string; sha256: string; bytes: number };
}
export interface ViewerOptions { quality: Quality; trees: Trees; shadows: boolean; exposure: number }
export interface BenchmarkResult {
  id: number; quality: QualityLevel; fps: number; lowFps: number; frames: number; seconds: number;
  p95FrameMs:number; maxFrameMs:number; longFrames:number; freezes:number;
  width: number; height: number; shadowSize: number; aoSamples: number; antialiasSamples: number;
  revision: string; position: Vec3;
}
export interface ViewerStatus {
  phase: 'loading' | 'ready' | 'error'; message: string; loaded: number; total: number;
  revision: string; azimuth: number; distance: number; fps: number;
  mode: NavigationMode; effectiveQuality: QualityLevel; groundReady: boolean; treesAvailable: boolean;
  renderWidth: number; renderHeight: number; drawCalls: number; triangles: number; residentMiB: number;
  benchmarking: boolean; benchmarkRemaining: number; benchmarkResults: BenchmarkResult[]; benchmarkMessage: string;
}
export interface ViewerAPI {
  home(): void; top(): void; north(): void; zoom(direction: number): void;
  setOptions(options: ViewerOptions): void; retry(): void; destroy(): void;
  setMode(mode: NavigationMode): void;
  move(x: number, forward: number, up?: number): void;
  goTo(place: WalkPlace): void;
  startBenchmark(): void; stopBenchmark(): void;
}
