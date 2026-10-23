import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { createOutdoorEnvironment } from './daylight';
import {agxLook,withBlenderAgXLook} from './agx-look';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
export type DisplayRenderer = THREE.WebGLRenderer | WebGPURenderer;
export interface DisplayBackend {
  renderer: DisplayRenderer; name: string; fallback: string;
  maxTextureSize: number; maxSamples: number; maxAnisotropy: number;
  samples: number; aoSamples: number; precisionDepth:boolean;
  configure(width:number,height:number,ratio:number,samples:number,aoSamples:number):void;
  render(delta:number):void; dispose():void;
  metrics():{calls:number;triangles:number};
}
export async function createDisplayBackend(scene:THREE.Scene,camera:THREE.PerspectiveCamera):Promise<DisplayBackend> {
  let fallback='';
  if(new URLSearchParams(location.search).get('renderer')==='webgpu') {
    fallback='この表示ではWebGL2を使用しています';
  }
  camera.coordinateSystem=THREE.WebGLCoordinateSystem;camera.updateProjectionMatrix();
  // After a GPU reset the preferred adapter may be unavailable temporarily.
  // Each attempt needs a fresh canvas: a failed context must not poison retry.
  let canvas!:HTMLCanvasElement,context:WebGL2RenderingContext|null=null;
  for(const powerPreference of ['high-performance','default','low-power'] as const){
    canvas=document.createElement('canvas');
    try{context=canvas.getContext('webgl2',{antialias:false,alpha:false,powerPreference});}catch{context=null;}
    if(context&&!context.isContextLost())break;
    context=null;
  }
  if(!context)throw new Error('WebGL2 is temporarily unavailable');
  const cleanups:(()=>void)[]=[];
  const release=()=>{for(const cleanup of cleanups.splice(0).reverse())try{cleanup();}catch{/* Continue releasing the failed context. */}};
  cleanups.push(()=>{context?.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();});
  try{
  // Local QA can exercise the path used by phones without EXT_clip_control.
  const forceLog=['127.0.0.1','localhost'].includes(location.hostname)&&
    new URLSearchParams(location.search).get('depth')==='logarithmic';
  const reversed=!!context.getExtension('EXT_clip_control')&&!forceLog;
  const renderer=new THREE.WebGLRenderer({canvas,context,antialias:false,alpha:false,
    powerPreference:'high-performance',reversedDepthBuffer:reversed,logarithmicDepthBuffer:!reversed});
  cleanups.push(()=>renderer.dispose());
  canvas.dataset.depthMode=reversed?'reversed-float':'logarithmic';
  const environmentTarget=createOutdoorEnvironment(renderer);
  cleanups.push(()=>environmentTarget.dispose());
  scene.environment=environmentTarget.texture;
  const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,samples:4});
  // Reversed Z needs floating-point depth, not the default fixed 24-bit buffer.
  target.depthTexture=new THREE.DepthTexture(1,1,THREE.FloatType);
  const composer=new EffectComposer(renderer,target);composer.addPass(new RenderPass(scene,camera));
  cleanups.push(()=>composer.dispose());
  // Allocate the extra normal/depth/AO targets only for the unbaked fallback.
  let ao:GTAOPass|null=null;
  cleanups.push(()=>ao?.dispose());
  const output=new OutputPass();
  cleanups.push(()=>output.dispose());
  output.material.fragmentShader=withBlenderAgXLook(output.material.fragmentShader);
  canvas.dataset.displayLook=agxLook.name;
  composer.addPass(output);
  const gl=renderer.getContext();
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  renderer.domElement.dataset.gpu=debug?String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)):String(gl.getParameter(gl.RENDERER));
  const backend:DisplayBackend={renderer,name:'WebGL2',fallback,
    maxTextureSize:Math.min(renderer.capabilities.maxTextureSize,gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
    maxSamples:renderer.capabilities.maxSamples,maxAnisotropy:renderer.capabilities.getMaxAnisotropy(),samples:0,aoSamples:0,precisionDepth:true,
    configure(width,height,ratio,samples,aoSamples){
      if(aoSamples===0&&ao){composer.removePass(ao);ao.dispose();ao=null;}
      if(aoSamples>0&&!ao){
        ao=new GTAOPass(scene,camera,1,1);ao.blendIntensity=.48;
        ao.updateGtaoMaterial({radius:1.7,thickness:1.2,distanceFallOff:1,scale:.65,samples:aoSamples,screenSpaceRadius:false});
        ao.updatePdMaterial({samples:8,radius:4});composer.insertPass(ao,1);
      }
      const count=Math.min(samples,backend.maxSamples);
      for(const buffer of [composer.renderTarget1,composer.renderTarget2]) {
        if(buffer.samples!==count){buffer.samples=count;buffer.dispose();}
      }
      renderer.setPixelRatio(ratio);renderer.setSize(width,height,false);
      composer.setPixelRatio(ratio);composer.setSize(width,height);
      if(ao&&backend.aoSamples!==aoSamples)ao.updateGtaoMaterial({samples:aoSamples});
      backend.samples=count;backend.aoSamples=aoSamples;
      renderer.domElement.dataset.aoSamples=String(aoSamples);
    },
    render(delta){composer.render(delta);},
    metrics(){return {calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};},
    dispose(){release();},
  };
  return backend;
  }catch(cause){release();throw cause;}
}
