import * as THREE from 'three/webgpu';
import { pass, vec3, vec4, mix, mrt, output, normalView } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { DisplayBackend } from './display-backend';
/** Loaded only when WebGPU is requested; the legacy renderer is a clean fallback. */
export async function createGPUDisplay(scene:THREE.Scene,camera:THREE.PerspectiveCamera):Promise<DisplayBackend> {
  const renderer=new THREE.WebGPURenderer({antialias:true,samples:4,alpha:false});
  let target:THREE.RenderTarget|undefined;
  try {
    await renderer.init();
    const environment=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer);
    try { target=await pmrem.fromSceneAsync(environment,.035);scene.environment=target.texture; }
    finally {environment.dispose();pmrem.dispose();}
    camera.coordinateSystem=renderer.coordinateSystem;camera.updateProjectionMatrix();
    const pipeline=new THREE.RenderPipeline(renderer),scenePass=pass(scene,camera);
    scenePass.setMRT(mrt({output,normal:normalView}));
    const color=scenePass.getTextureNode('output'),depth=scenePass.getTextureNode('depth');
    const ambient=ao(depth,scenePass.getTextureNode('normal').xyz,camera);ambient.radius.value=1.7;ambient.thickness.value=1.2;
    ambient.resolutionScale=.5;
    const shaded=color.mul(vec4(vec3(mix(1,ambient.getTextureNode().r,.48)),1));
    pipeline.outputNode=color;
    const backend:DisplayBackend={renderer,
      name:renderer.coordinateSystem===THREE.WebGPUCoordinateSystem?'WebGPU':'WebGL2 (WebGPU fallback)',fallback:'',
      maxTextureSize:4096,maxSamples:4,maxAnisotropy:renderer.getMaxAnisotropy(),samples:4,aoSamples:0,precisionDepth:false,
      configure(width,height,ratio,_samples,aoSamples){
        renderer.setPixelRatio(ratio);renderer.setSize(width,height,false);
        if(backend.aoSamples!==aoSamples){
          ambient.samples.value=Math.max(4,aoSamples);
          pipeline.outputNode=aoSamples>0?shaded:color;pipeline.needsUpdate=true;
          backend.aoSamples=aoSamples;
        }
      },
      render(){pipeline.render();},
      metrics(){return {calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles};},
      dispose(){ambient.dispose();scenePass.dispose();pipeline.dispose();target?.dispose();renderer.dispose();},
    };
    return backend;
  } catch(error) { target?.dispose();renderer.dispose();throw error; }
}
