/** Verify the viewer's publishable model references, not historical geometry gates. */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {validateCapabilities} from './viewer_capabilities.mjs';
import {validateWalking} from './viewer_walking.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'web-public');
const index=process.argv.indexOf('--manifest');
const manifestPath=path.resolve(base,index<0?'viewer/current.json':process.argv[index+1]);
if(!manifestPath.startsWith(base+path.sep))throw new Error('Manifest escapes Web root');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
if(manifest.walking)validateWalking(manifest.walking);

function assert(condition, message) { if (!condition) throw new Error(message); }
assert(manifest.schema === 'tempaku-viewer-1', 'Unexpected manifest schema');
assert(manifest.chunks.length > 0, 'No model chunks');
assert(manifest.source?.sha256?.length === 64, 'Source model is unidentified');
const ids = new Set(), resources = new Map(), assetFacts=new Map();
let objects = 0, fullTriangles = 0;
async function checkAsset(asset,lightmapResolution) {
  assert(asset?.url?.startsWith('/viewer/assets/'), 'Unexpected asset location');
  assert(Number.isFinite(asset.triangles) && asset.triangles > 0, `Empty mesh ${asset.url}`);
  for (const item of [{ url: asset.url, sha256: asset.sha256 }, ...(asset.resources ?? [])]) {
    if (resources.has(item.url)) { assert(resources.get(item.url) === item.sha256, 'Conflicting asset hashes'); continue; }
    const file = path.resolve(base, '.' + item.url);
    assert(file.startsWith(base + path.sep), 'Resource escapes the web directory');
    const bytes = await readFile(file);
    assert(createHash('sha256').update(bytes).digest('hex') === item.sha256, `Asset integrity failure: ${item.url}`);
    if (item.bytes !== undefined) assert(bytes.length === item.bytes, `Asset size mismatch: ${item.url}`);
    resources.set(item.url, item.sha256);
  }
  const doc = JSON.parse(await readFile(path.resolve(base, '.' + asset.url), 'utf8'));
  const materials=doc.materials??[];
  for(const material of materials)if(material.name?.includes('_WebThinGlass')){
    const transmission=material.extensions?.KHR_materials_transmission?.transmissionFactor;
    assert(Number.isFinite(transmission)&&transmission>0&&transmission<=1,'Thin glass lost its transmission');
    assert(material.pbrMetallicRoughness?.metallicFactor===0,'Thin glass became an opaque metal');
    assert(!material.extras?.webLightmap,'Thin glass must retain its transmission and reflection shader');
  }
  if(manifest.geometryPositionEncoding==='float32-meshopt')for(const mesh of doc.meshes??[])for(const primitive of mesh.primitives)
    assert(doc.accessors[primitive.attributes.POSITION].componentType===5126,'Quantized positions can merge thin facade layers');
  assetFacts.set(asset.url,{lightmappedMaterials:materials.filter(m=>m.extras?.webLightmap).length,
    litMaterials:materials.filter(m=>!m.extensions?.KHR_materials_unlit&&!m.extras?.webLightingDynamic).length,
    triangles:(doc.meshes??[]).reduce((n,m)=>n+m.primitives.reduce((s,p)=>s+doc.accessors[p.indices??p.attributes.POSITION].count/3,0),0)});
  for(const [materialIndex,mat] of (doc.materials??[]).entries())if(mat.extras?.webLightmap){
    assert(mat.emissiveTexture,'Missing lightmap texture');const lightUV=mat.emissiveTexture.texCoord??0;
    assert(Number.isInteger(lightUV)&&lightUV>=0&&lightUV<=3,'Lightmap UV channel exceeds the browser renderer limit; prune unused channels');
    if(manifest.lightmaps?.resolutionPolicy==='native-chart-pixels'){
      assert(lightmapResolution?.length===2,'Missing native lightmap resolution');
      const texture=doc.textures[mat.emissiveTexture.index];
      const image=doc.images[texture.extensions?.KHR_texture_basisu?.source??texture.source];
      const encoded=await readFile(path.resolve(base,'viewer/assets',image.uri));
      assert(encoded.readUInt32LE(20)===lightmapResolution[0]&&encoded.readUInt32LE(24)===lightmapResolution[1],'Lightmap was resized after UV packing');
    }
    const surfaceMaps=[mat.pbrMetallicRoughness?.baseColorTexture,mat.pbrMetallicRoughness?.metallicRoughnessTexture,mat.normalTexture,mat.occlusionTexture].filter(Boolean);
    // glTF-Transform may compact UV1 to UV0 on a solid-colour material. What must
    // stay separate is atlas UV vs any tiled surface texture, not the UV's number.
    assert(surfaceMaps.every(t=>(t.texCoord??0)!==lightUV),'Lightmap overlaps the surface texture UV channel');
    for(const mesh of doc.meshes??[])for(const primitive of mesh.primitives)if(primitive.material===materialIndex)
      assert(primitive.attributes['TEXCOORD_'+lightUV]!==undefined,'Missing lightmap UV attribute');
    assert(Number.isFinite(mat.extras.webLightmapGain)&&mat.extras.webLightmapGain>0,'Invalid lightmap gain');
  }
  if(manifest.renderPipeline==='ktx2-lod-v3')assert((doc.images??[]).every(i=>i.uri?.endsWith('.ktx2')),'Non-KTX2 image in v3');
  for (const resource of [...(doc.images ?? []), ...(doc.buffers ?? [])]) {
    if (!resource.uri) continue;
    assert(!resource.uri.includes('/') && !resource.uri.includes('..'), 'Asset dependency is not immutable and local');
    const uri = '/viewer/assets/' + resource.uri;
    assert(resources.has(uri), `Unlisted asset dependency: ${uri}`);
  }
}
for (const chunk of manifest.chunks) {
  assert(!ids.has(chunk.id), `Duplicate chunk ${chunk.id}`); ids.add(chunk.id);
  assert(chunk.bounds.length === 2 && chunk.bounds.flat().length === 6 && chunk.bounds.flat().every(Number.isFinite), `Invalid bounds ${chunk.id}`);
  assert(chunk.bounds[0].every((n, i) => n <= chunk.bounds[1][i]), `Inverted bounds ${chunk.id}`);
  await checkAsset(chunk.full,chunk.lightmapResolution);
  if(chunk.lightingFallback){
    const fallback=chunk.lightingFallback;
    assert(fallback.sourceModelSha256===manifest.source.sha256&&fallback.fullAssetSha256===chunk.full.sha256&&fallback.geometryPreserved,'Stale hardware lighting fallback');
    assert(fallback.asset.sceneTriangles===chunk.full.sceneTriangles,'Hardware lighting fallback changed geometry');
    assert(fallback.geometryReceipt?.algorithm==='world-float32-oriented-triangles-v1'&&/^[a-f0-9]{64}$/.test(fallback.geometryReceipt.sha256),'Missing hardware fallback geometry receipt');
    await checkAsset(fallback.asset);
  }
  for(const variant of Object.values(chunk.lightingVariants??{})){
    assert(variant.sourceModelSha256===manifest.source.sha256&&variant.fullAssetSha256===chunk.full.sha256&&variant.geometryPreserved,'Stale lighting variant');
    assert(variant.asset.sceneTriangles===chunk.full.sceneTriangles,'Lighting variant changed scene geometry');
    assert(variant.resolution.every((n,i)=>n>=variant.atlasPackingSize[i]),'Lighting variant was downsampled after packing');
    if(variant.derivation){
      assert(variant.derivation.method==='full-native-chart-reprojection-v1'&&variant.derivation.sourceModelSha256===manifest.source.sha256&&variant.derivation.sourceFingerprint===chunk.lightmapSourceFingerprint,'Repacked light is not derived from this full bake');
      assert(/^[a-f0-9]{64}$/.test(variant.derivation.sourceRawSha256)&&variant.derivation.geometryReceipt?.algorithm==='world-float32-oriented-triangles-v1','Missing repacking provenance');
    }
    await checkAsset(variant.asset,variant.resolution);
  }
  let last=chunk.full.triangles;
  for(const level of ['medium','coarse','far'])if(chunk[level]){await checkAsset(chunk[level],chunk.lightmapResolution);assert(chunk[level].triangles<=last,'LOD triangle count increases');last=chunk[level].triangles;}
  objects += chunk.sourceObjects; fullTriangles += chunk.full.triangles;
}
if (manifest.trees) {
  await checkAsset(manifest.trees.light); await checkAsset(manifest.trees.detailed);
  if(manifest.trees.renderMode==='unlit-shared'){
    assert(manifest.trees.light.url===manifest.trees.detailed.url,'Shared trees have conflicting assets');
    assert(manifest.trees.light.triangles===manifest.trees.light.originalTriangles,'Shared tree geometry was reduced');
    assert(Number.isFinite(manifest.trees.brightness)&&manifest.trees.brightness>0,'Invalid tree brightness');
    assert(manifest.trees.attribution?.includes('CC BY 4.0'),'Missing tree attribution');
    const tree=JSON.parse(await readFile(path.resolve(base,'.'+manifest.trees.light.url),'utf8'));
    assert(tree.materials.every(m=>m.extensions?.KHR_materials_unlit&&m.pbrMetallicRoughness?.baseColorTexture&&!m.normalTexture),'Trees must retain unlit color textures');
  }else {
    assert(manifest.trees.light.triangles < manifest.trees.detailed.triangles, 'Tree quality levels do not reduce geometry');
    if(manifest.trees.renderMode==='pbr-lod'){
      await checkAsset(manifest.trees.medium);
      assert(manifest.trees.detailed.triangles===manifest.trees.detailed.originalTriangles,'Near tree geometry changed');
      assert(manifest.trees.light.triangles<manifest.trees.medium.triangles&&manifest.trees.medium.triangles<manifest.trees.detailed.triangles,'Tree LOD must have three decreasing levels');
      assert(manifest.trees.attribution?.includes('CC BY 4.0'),'Missing tree attribution');
      const selfOcclusion=manifest.trees.selfOcclusion;
      if(selfOcclusion){
        assert(selfOcclusion.method==='two-sided-vertex-v1'&&selfOcclusion.originalMaterialDataRetained,'Unverified tree visibility method');
        for(const key of ['sourceFingerprint','sourceRawSha256','derivedRawSha256'])assert(/^[a-f0-9]{64}$/.test(selfOcclusion[key]),'Missing tree visibility provenance');
        assert(selfOcclusion.geometryReceipt?.algorithm==='world-float32-oriented-triangles-v1'&&JSON.stringify(selfOcclusion.geometryReceipt)===JSON.stringify(manifest.trees.detailed.geometryReceipt),'Tree visibility changed the full tree geometry');
      }
      for(const level of ['light','medium','detailed']){
        const doc=JSON.parse(await readFile(path.resolve(base,'.'+manifest.trees[level].url),'utf8'));
        assert(doc.materials.every(m=>!m.extensions?.KHR_materials_unlit&&m.pbrMetallicRoughness?.baseColorTexture),'PBR trees must receive scene lighting');
        assert(doc.materials.some(m=>/trunk/i.test(m.name))&&doc.materials.some(m=>/leaves/i.test(m.name)),'Tree trunk or leaf material assignment was lost');
        assert(doc.materials.filter(m=>/leaves/i.test(m.name)).every(m=>m.alphaMode==='MASK'),'Leaf silhouettes must retain their alpha mask');
        if(selfOcclusion){
          assert(doc.materials.every(m=>m.extras?.webTreeSelfOcclusion===selfOcclusion.method),'Missing tree visibility material declaration');
          for(const mesh of doc.meshes)for(const primitive of mesh.primitives){
            const color=doc.accessors[primitive.attributes.COLOR_0];
            assert(color?.type==='VEC4'&&color.count===doc.accessors[primitive.attributes.POSITION].count,'Missing front/back tree visibility attributes');
          }
        }
      }
    }
  }
  for (const matrix of manifest.trees.transforms) assert(matrix.length === 16 && matrix.every(Number.isFinite), 'Invalid tree instance');
  objects += manifest.trees.transforms.length;
}
if (manifest.navigation) {
  if(manifest.debugCampus)assert(!manifest.chunks.some(chunk=>chunk.kind==='context'||(!manifest.includeInteriors&&chunk.kind==='interior')), 'Excluded geometry included');
  if(manifest.debugCampus)assert(!manifest.trees||manifest.trees.renderMode==='unlit-shared', 'Debug build includes unapproved high-density trees');
  const nav = manifest.navigation;
  assert(nav?.url?.startsWith('/viewer/assets/'), 'Debug ground data missing');
  const file = path.resolve(base, '.' + nav.url);
  assert(file.startsWith(base + path.sep), 'Ground data escapes the web directory');
  const bytes = await readFile(file);
  assert(createHash('sha256').update(bytes).digest('hex')===nav.sha256, 'Ground data hash mismatch');
  assert(bytes.length===nav.bytes, 'Ground data size mismatch');
  const ground=JSON.parse((bytes[0]===31&&bytes[1]===139?gunzipSync(bytes):bytes).toString('utf8'));
  if(ground.schema==='tempaku-walk-2') {
    assert(ground.cellSize>0&&ground.supportCount>0&&ground.vertexCount>0,'Invalid walking mesh');
    if(nav.policy==='authored-surfaces-v1'){
      assert(ground.policy===nav.policy&&ground.capturedCollisionObjects===0,'Captured collision is forbidden');
      assert(ground.sourceModelSha256===manifest.source.sha256,'Navigation/model mismatch');
    }

    assert(Buffer.from(ground.positions,'base64').length===ground.vertexCount*12,'Invalid walking positions');
    assert(Buffer.from(ground.support,'base64').length===ground.supportCount*12,'Invalid support triangles');
    assert(Buffer.from(ground.blockers,'base64').length===ground.blockerCount*12,'Invalid barrier triangles');
  } else {
    assert(ground.schema==='tempaku-ground-1' && ground.spacing>0 && ground.width>1 && ground.height>1, 'Invalid ground data');
    assert(Buffer.from(ground.data,'base64').length===ground.width*ground.height*ground.layers*2, 'Invalid packed ground size');
  }
  resources.set(nav.url,nav.sha256);
}
if(manifest.lightmaps)assert(manifest.lightmaps.sourceModelSha256===manifest.source.sha256,'Lightmap source mismatch');
if(manifest.environment){
  const env=manifest.environment;
  assert(env.schema==='tempaku-environment-1'&&env.sourceModelSha256===manifest.source.sha256,'Environment source mismatch');
  assert(/^[a-f0-9]{64}$/.test(env.lightingSignature),'Missing saved lighting signature');
  if(manifest.lightmaps)assert(manifest.lightmaps.lightingId==='saved-world-'+env.lightingSignature.slice(0,16),'Baked light and saved environment differ');
  assert(env.look==='AgX - Medium High Contrast'&&env.viewTransform==='AgX','Unsupported display transform');
  assert(Number.isFinite(env.exposure)&&env.exposure>0&&Array.isArray(env.diffuseFill)&&env.diffuseFill.length===3&&env.diffuseFill.every(n=>Number.isFinite(n)&&n>=0),'Invalid environment lighting');
  assert(/^\/viewer\/assets\/[a-f0-9]{64}\.hdr$/.test(env.image?.url),'Missing immutable HDR');
  const bytes=await readFile(path.resolve(base,'.'+env.image.url));
  assert(bytes.length===env.image.bytes&&createHash('sha256').update(bytes).digest('hex')===env.image.sha256,'Environment integrity failure');
  assert(bytes.subarray(0,64).toString('ascii').includes('RADIANCE'),'Invalid HDR environment');
  resources.set(env.image.url,env.image.sha256);
}
if(manifest.colliders){
  const index=manifest.colliders;
  assert(index.schema==='tempaku-colliders-1'&&index.policy==='authored-surfaces-v1'&&index.sourceModelSha256===manifest.source.sha256,'Collider/model mismatch');
  assert(index.tileSize===45&&index.tiles.length>0,'Invalid collider grid');
  const cells=new Set();let totalBytes=0;
  for(const tile of index.tiles){
    assert(!cells.has(tile.id),'Duplicate collider cell');cells.add(tile.id);
    assert(tile.id===tile.cell.join('_')&&tile.url.startsWith('/viewer/assets/'),'Invalid collider tile');
    const file=path.resolve(base,'.'+tile.url);assert(file.startsWith(base+path.sep),'Collider escapes web root');
    const bytes=await readFile(file);totalBytes+=bytes.length;
    assert(bytes.length===tile.bytes&&createHash('sha256').update(bytes).digest('hex')===tile.sha256,'Collider integrity failure');
    const data=JSON.parse(gunzipSync(bytes).toString('utf8'));
    assert(data.schema==='tempaku-collider-tile-1'&&data.policy===index.policy&&data.id===tile.id,'Collider data mismatch');
    const p=Buffer.from(data.positions,'base64'),s=Buffer.from(data.support,'base64'),b=Buffer.from(data.blockers,'base64');
    assert(p.length===data.vertexCount*12&&s.length===data.supportCount*12&&b.length===data.blockerCount*12,'Invalid collider arrays');
    for(let i=0;i<p.length;i+=12){const x=p.readFloatLE(i),y=p.readFloatLE(i+4),z=p.readFloatLE(i+8);
      assert([x,y,z].every(Number.isFinite)&&x>=tile.bounds[0][0]-.001&&x<=tile.bounds[1][0]+.001&&z>=tile.bounds[0][2]-.001&&z<=tile.bounds[1][2]+.001,'Collider leaves its cell');}
    for(const array of [s,b])for(let i=0;i<array.length;i+=4)assert(array.readUInt32LE(i)<data.vertexCount,'Collider index out of range');
    resources.set(tile.url,tile.sha256);
  }
  assert(totalBytes===index.bytes,'Collider total differs');
}
assert(objects === manifest.source.objects, `Source coverage changed: ${objects} / ${manifest.source.objects}`);
const capabilities=validateCapabilities(manifest,assetFacts);
const sumBytes = (await Promise.all([...resources.keys()].map((url) => stat(path.resolve(base, '.' + url))))).reduce((n, item) => n + item.size, 0);
console.log(JSON.stringify({ revision: manifest.revision, release: manifest.release, chunks: ids.size, sourceObjects: objects, fullTriangles, resources: resources.size, uniqueMB: +(sumBytes / 1024 / 1024).toFixed(2),capabilities }));
