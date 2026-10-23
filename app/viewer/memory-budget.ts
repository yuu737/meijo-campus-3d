/** Starting model-memory limit from what the browser reports; the viewer never lowers it on its own. */
export const MEMORY_CHOICES=[140,320,512,1024,2048,3072] as const;
const STORAGE_KEY='tempaku.viewer.memoryMiB';

function gpuName():string {
  try {
    const gl=document.createElement('canvas').getContext('webgl2')??document.createElement('canvas').getContext('webgl');
    if(!gl)return '';
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    const name=String(gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

/** deviceMemory exists only in Chromium browsers and stops at 8 GB; GPU names are often reported. */
export function detectMemoryMiB():number {
  if(typeof window==='undefined')return 320;
  const memory=(navigator as Navigator&{deviceMemory?:number}).deviceMemory;
  const cores=navigator.hardwareConcurrency||0;
  const touch=window.matchMedia('(pointer: coarse)').matches;
  if(memory!==undefined&&memory<=3)return 140;
  if(touch||(memory!==undefined&&memory<=4))return 320;
  const discrete=/NVIDIA|GeForce|Quadro|RTX|Radeon (RX|Pro)|Arc\(TM\) A|Apple M\d (Pro|Max|Ultra)/i.test(gpuName());
  if(discrete&&cores>=8&&(memory===undefined||memory>=8))return 2048;
  if(memory===undefined)return 512;
  return memory>=8&&cores>=4?1024:512;
}

export function storedMemoryMiB():number|null {
  try { const v=Number(localStorage.getItem(STORAGE_KEY)); return MEMORY_CHOICES.includes(v as typeof MEMORY_CHOICES[number])?v:null; } catch { return null; }
}
/** null returns to the automatic value. */
export function storeMemoryMiB(value:number|null):void {
  try { if(value===null)localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY,String(value)); } catch { /* private mode: keep for this page only */ }
}
