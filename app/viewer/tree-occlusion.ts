import * as THREE from 'three';

/** Local visibility on each side of a leaf; never change its colour or alpha. */
export function prepareTreeSelfOcclusion(material: THREE.MeshStandardMaterial) {
  if (material.userData.webTreeSelfOcclusion !== 'two-sided-vertex-v1') return false;
  if (material.userData.treeSelfOcclusionPrepared) return true;
  material.vertexColors = false;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.vertexShader = 'attribute vec4 color;\nvarying vec2 vTreeSelfOcclusion;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTreeSelfOcclusion = color.rg;');
    shader.fragmentShader = 'varying vec2 vTreeSelfOcclusion;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `
      #include <lights_fragment_end>
      float treeVisibility = clamp(gl_FrontFacing ? vTreeSelfOcclusion.r : vTreeSelfOcclusion.g, 0.0, 1.0);
      reflectedLight.indirectDiffuse *= treeVisibility;
      reflectedLight.indirectSpecular *= treeVisibility;
    `);
  };
  material.customProgramCacheKey = () => 'tree-self-occlusion-v1|' + previousKey;
  material.userData.treeSelfOcclusionPrepared = true;
  material.needsUpdate = true;
  return true;
}
