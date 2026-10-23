import * as THREE from 'three';
import look from '../../data/viewer/agx-look.json';

export const agxLook=look;
export const agxLookOffset=look.offset*look.blenderLogRangeStops/look.threeLogRangeStops;
export function applyAgXLookChannel(value:number){return value*look.slope+agxLookOffset;}

/** The saved Blender look operates before AgX's sigmoid, in normalized log space. */
export function withBlenderAgXLook(fragmentShader:string) {
  const marker='color = agxDefaultContrastApprox( color );';
  const chunk=THREE.ShaderChunk.tonemapping_pars_fragment;
  if(chunk.split(marker).length!==2||!fragmentShader.includes('#include <tonemapping_pars_fragment>'))
    throw new Error('AgX shader changed; verify the display look before updating Three.js');
  const calibrated=chunk.replace(marker,`
    // AgX - Medium High Contrast, derived from the bundled Blender OCIO config.
    color = clamp(color * ${look.slope.toFixed(10)} + vec3(${agxLookOffset.toFixed(10)}), 0.0, 1.0);
${marker}`);
  return fragmentShader.replace('#include <tonemapping_pars_fragment>',calibrated);
}
