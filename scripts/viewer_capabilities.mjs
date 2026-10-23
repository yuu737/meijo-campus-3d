/** Actual release capabilities, derived from assets rather than build switches. */
export function summarizeCapabilities(manifest) {
  const chunks=manifest.chunks;
  const levels=Object.fromEntries(['full','medium','coarse','far'].map(level=>[level,chunks.filter(c=>c[level]).length]));
  const targets=chunks.filter(c=>c.lightmap).map(c=>c.id).sort();
  const outdoor=chunks.filter(c=>c.kind!=='interior'&&c.kind!=='context');
  return {schema:'tempaku-capabilities-1',lod:{chunks:levels,outdoorChunks:outdoor.length,
    outdoorWithThreeReducedLevels:outdoor.filter(c=>c.medium&&c.coarse&&c.far).length},
    trees:{instances:manifest.trees?.transforms.length??0,levels:manifest.trees?new Set(['light','medium','detailed'].map(l=>manifest.trees[l]?.sha256).filter(Boolean)).size:0,
      lighting:manifest.trees?.renderMode==='unlit-shared'?'unlit':manifest.trees?'pbr':'none'},
    daylight:{enabled:targets.length>0,targets,coverage:targets.length===0?'none':outdoor.every(c=>c.lighting==='dynamic'||targets.includes(c.id))?'outdoor':'partial'}};
}

export function validateCapabilities(manifest, assetFacts) {
  const expected=summarizeCapabilities(manifest);
  if(manifest.capabilities&&JSON.stringify(manifest.capabilities)!==JSON.stringify(expected))throw new Error('Declared capabilities do not match release assets');
  const declared=[...(manifest.lightmaps?.targets??[])].sort();
  if(JSON.stringify(declared)!==JSON.stringify(expected.daylight.targets))throw new Error('Daylight target list does not match chunk tags');
  for(const c of manifest.chunks)for(const level of ['full','medium','coarse','far'])if(c[level]){
    const facts=assetFacts.get(c[level].url);
    if(!facts)throw new Error('Missing verified asset facts: '+c.id);
    if(Boolean(c.lightmap)!==Boolean(facts.lightmappedMaterials))throw new Error('Daylight declaration differs from glTF materials: '+c.id+'/'+level);
    if(c.lightmap&&facts.litMaterials!==facts.lightmappedMaterials)throw new Error('Partly missing daylight material tags: '+c.id+'/'+level);
    if(facts.triangles!==c[level].triangles)throw new Error('Triangle declaration differs from glTF geometry: '+c.id+'/'+level);
  }
  return expected;
}
