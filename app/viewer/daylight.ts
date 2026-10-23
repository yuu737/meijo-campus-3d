import * as THREE from 'three';
import daylight from '../../data/viewer/daylight.json';

export { daylight };

/** Shared linear sky used by the Blender world, background and reflections. */
export function createDaySky(){
  const width=256,height=128,data=new Float32Array(width*height*4);
  for(let y=0;y<height;y++){
    const elevation=-Math.cos(Math.PI*(y+.5)/height);
    const color=elevation>=0?daylight.skyZenith:daylight.groundBounce;
    for(let x=0;x<width;x++){
      const index=(y*width+x)*4;
      for(let c=0;c<3;c++)data[index+c]=(daylight.skyHorizon[c]+(color[c]-daylight.skyHorizon[c])*Math.abs(elevation))*daylight.skyIntensity;
      data[index+3]=1;
    }
  }
  const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
  texture.mapping=THREE.EquirectangularReflectionMapping;
  texture.colorSpace=THREE.LinearSRGBColorSpace;texture.needsUpdate=true;
  return texture;
}

/** One PMREM convolution at startup. No per-frame reflection capture or download. */
export function createOutdoorEnvironment(renderer: THREE.WebGLRenderer) {
  const width=256,height=128,data=new Float32Array(width*height*4);
  for(let y=0;y<height;y++) {
    const elevation=-Math.cos(Math.PI*(y+.5)/height);
    const color=elevation>=0?daylight.skyZenith:daylight.groundBounce;
    for(let x=0;x<width;x++) {
      const index=(y*width+x)*4;
      for(let c=0;c<3;c++)data[index+c]=(daylight.skyHorizon[c]+(color[c]-daylight.skyHorizon[c])*Math.abs(elevation))*daylight.skyIntensity;
      data[index+3]=1;
    }
  }
  const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
  texture.mapping=THREE.EquirectangularReflectionMapping;
  texture.colorSpace=THREE.LinearSRGBColorSpace;texture.needsUpdate=true;
  const generator=new THREE.PMREMGenerator(renderer),target=generator.fromEquirectangular(texture);
  texture.dispose();generator.dispose();return target;
}

/** glTF's emissive slot is only a transport for the explicitly tagged lightmap. */
export function prepareBakedDaylight(material:THREE.MeshStandardMaterial,enabled:boolean) {
  if(material.userData.bakedDaylightUniform)return true;
  const mode=material.userData.webLightmapMode;
  if(!['diffuse-direct-indirect','diffuse-direct-indirect-sun'].includes(mode)||!material.emissiveMap)return false;
  material.lightMap=material.emissiveMap;
  // The atlas contains thousands of narrow charts. Do not mix unrelated surfaces
  // through whole-atlas mip levels; bilinear samples use padded valid texels.
  material.lightMap.minFilter=THREE.LinearFilter;
  material.lightMap.magFilter=THREE.LinearFilter;
  material.lightMap.userData.campusNativeAtlas=true;
  material.lightMap.anisotropy=1;
  material.lightMapIntensity=Number(material.userData.webLightmapGain);
  if(!Number.isFinite(material.lightMapIntensity)||material.lightMapIntensity<=0)throw new Error('Invalid baked irradiance gain');
  // GLTFLoader already retains the emissive texture's texCoord channel and sRGB decode.
  material.emissiveMap=null;material.emissive.set(0);
  const uniform={value:enabled?1:0};material.userData.bakedDaylightUniform=uniform;
  const previousCompile=material.onBeforeCompile;
  const previousProgramKey=material.customProgramCacheKey();
  material.onBeforeCompile=(shader,renderer)=>{
    previousCompile.call(material,shader,renderer);
    shader.uniforms.useBakedDaylight=uniform;
    shader.fragmentShader='uniform float useBakedDaylight;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_end>',`
      #include <lights_fragment_end>
      #ifdef USE_LIGHTMAP
        if (useBakedDaylight > 0.5) {
          // Replace the TOTAL diffuse term, including IBL, so fixed light is counted once.
          reflectedLight.directDiffuse = vec3(0.0);
          reflectedLight.indirectDiffuse = lightMapIrradiance * BRDF_Lambert(material.diffuseContribution);
          ${mode==='diffuse-direct-indirect-sun'?'reflectedLight.directSpecular *= texture2D(lightMap, vLightMapUv).a;':''}
        }
      #endif
    `);
    // Disable Three's additive lightMap path. The calibrated total above owns diffuse.
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_maps>',
      THREE.ShaderChunk.lights_fragment_maps.replace('irradiance += lightMapIrradiance;','/* Diffuse applied once after all lighting terms. */'));
  };
  material.customProgramCacheKey=()=> 'campus-baked-daylight-v3-'+mode+'|'+previousProgramKey;
  material.needsUpdate=true;return true;
}

export function setBakedDaylightEnabled(material:THREE.Material,enabled:boolean) {
  if(material.userData.bakedDaylightUniform)material.userData.bakedDaylightUniform.value=enabled?1:0;
}
