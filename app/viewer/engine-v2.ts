import { createDisplayBackend } from './display-backend';
import { daylight, createDaySky, prepareBakedDaylight, setBakedDaylightEnabled } from './daylight';
import { prepareTreeSelfOcclusion } from './tree-occlusion';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { chooseLOD, validatedLOD, LOD_LEVELS, estimateTextureBytes, type LODLevel } from './lod-policy';
import { OcclusionStreaming } from './occlusion-streaming';
import * as THREE from 'three';
import fallbackWalking from '../../data/viewer/walking.json';
import {NavigationTransition} from './navigation-transition';
import {newerRelease} from './release-update';
import type {Landing} from './rapier-walk';
import {ColliderNavigation} from './collider-loader';
import reviewViews from '../../data/viewer/review-views.json';
import pilotViews from '../../data/viewer/render-pilot-views.json';
import {transferMetrics} from './performance-metrics';
import {resolveManifestAssets} from './asset-urls';
import {parseView,serializeView,type ViewState} from './view-state';
import {tagTextureSources,textureSharingKey} from './texture-sharing';
import {waitForShaderPrograms} from './shader-ready';
import CameraControls from 'camera-controls';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import type { BenchmarkResult, Chunk, Manifest, Trees, NavigationMode, QualityLevel, ViewerAPI, ViewerOptions, ViewerStatus } from './types-v2';
import type { WalkPlace } from './types-v2';
import { FrameBenchmark, QUALITY_PROFILES, renderSize, lightingAsset, type FrameSummary } from './quality';

CameraControls.install({ THREE });
type Level = LODLevel;
type Resident = { object: THREE.Group; bytes: number; lastUsed: number; assetSha256:string };
type Tile = { spec: Chunk; box: THREE.Box3; sphere: THREE.Sphere; desired: Level | null; activeLevel?:Level; loading: Set<Level>; failures: Set<Level> } & Partial<Record<Level,Resident>>;
const toBox = (bounds: Manifest['bounds']) => new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));

/** Camera controls and physically based glTF display; no procedural campus model. */
export async function createViewer(host: HTMLElement, initial: ViewerOptions, notify: (status: ViewerStatus) => void, restart:()=>void=()=>{},recoveryView?:string): Promise<ViewerAPI> {
  const scene = new THREE.Scene();
  const sky=createDaySky();scene.background=sky;scene.backgroundIntensity=1;
  scene.fog = new THREE.Fog('#bddbee', 1500, 4200);
  const camera = new THREE.PerspectiveCamera(42, 1, .035, 6000);
  camera.position.set(300, 340, 430);
  const backend = await createDisplayBackend(scene,camera).catch(cause=>{sky.dispose();throw cause;});
  const renderer = backend.renderer;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if(renderer instanceof THREE.WebGLRenderer)renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3Dモデル。ドラッグで回転、右ドラッグで移動、ホイールで拡大縮小。');
  host.append(canvas);
  const controls = new CameraControls(camera, canvas);
  controls.smoothTime = .20;
  controls.draggingSmoothTime = .075;
  controls.dollyToCursor = true;
  controls.infinityDolly = true;
  controls.minDistance = .35;
  controls.maxDistance = 2400;
  controls.maxPolarAngle = Math.PI * .995;
  controls.dollySpeed = .9;
  controls.truckSpeed = 1.8;
  controls.setLookAt(300, 340, 430, 0, 24, 0, false);

  // The same sun and sky irradiance as Blender; no additional ambient term.
  scene.environmentIntensity = 1;
  const sun = new THREE.DirectionalLight(new THREE.Color().fromArray(daylight.sunColor), daylight.sunIntensity);
  sun.castShadow = true; sun.shadow.autoUpdate=false; sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.normalBias = .06;
  // r185 hardware PCF adds bias directly; reversed depth needs the other sign.
  sun.shadow.bias = renderer instanceof THREE.WebGLRenderer&&renderer.capabilities.reversedDepthBuffer ? .00008 : -.00008;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 1700;
  scene.add(sun, sun.target);
  let savedEnvironmentTarget:THREE.WebGLRenderTarget|null=null;
  let savedEnvironmentTexture:THREE.DataTexture|null=null;
  let savedDiffuseFill:THREE.AmbientLight|null=null;
  async function loadSavedEnvironment(next:Manifest){
    const spec=next.environment;if(!spec)return;
    if(spec.sourceModelSha256!==next.source.sha256)throw new Error('Saved environment belongs to another model');
    const texture=await new HDRLoader().loadAsync(spec.image.url);
    if(destroyed){texture.dispose();return;}
    texture.mapping=THREE.EquirectangularReflectionMapping;
    const generator=new THREE.PMREMGenerator(renderer as THREE.WebGLRenderer);
    let target:THREE.WebGLRenderTarget;
    try{target=generator.fromEquirectangular(texture);}catch(cause){texture.dispose();throw cause;}finally{generator.dispose();}
    savedEnvironmentTarget?.dispose();savedEnvironmentTexture?.dispose();savedDiffuseFill?.removeFromParent();
    savedEnvironmentTarget=target;savedEnvironmentTexture=texture;
    scene.environment=target.texture;scene.background=texture;
    savedDiffuseFill=new THREE.AmbientLight(new THREE.Color().fromArray(spec.diffuseFill),Math.PI);
    scene.add(savedDiffuseFill);sun.intensity=spec.sunIntensity;
    canvas.dataset.savedWorld=spec.world;canvas.dataset.environmentSource=spec.sourceModelSha256;
  }

  const ktx = new KTX2Loader().setTranscoderPath('/viewer/basis/').setWorkerLimit(2);
  ktx.detectSupport(renderer);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx);
  const occlusion = new OcclusionStreaming(renderer,camera);scene.add(occlusion.group);
  let occlusionDeferred=0;
  const abort = new AbortController();
  const group = new THREE.Group(); scene.add(group);
  const treeGroup = new THREE.Group(); scene.add(treeGroup);
  const materialCache = new Map<string, THREE.Material>();
  const materialRefs = new Map<THREE.Material, number>();
  const materialKeys = new Map<THREE.Material, string>();
  const textureRefs = new Map<THREE.Texture, number>();
  const keptTextures = new Set<THREE.Texture>();
  const sharedTextures = new Map<string,THREE.Texture>();
  const sharedTextureKeys = new Map<THREE.Texture,string>();
  const benchmark = new FrameBenchmark();
  let benchmarkConfig: Omit<BenchmarkResult, keyof FrameSummary> | null = null;
  let benchmarkResults: BenchmarkResult[] = [], benchmarkMessage = '', benchmarkSequence = 0;
  let residentMiB = 0, wasRendering = false, lastMeasured = 0;
  let appliedQuality: QualityLevel | null = null;
  const drawingSize = new THREE.Vector2();
  let options = { ...initial };
  let mode: NavigationMode = 'orbit', ground: ColliderNavigation | null = null, startedAtDefault = false;
  let walkGroundHeight=0;
  let groundFailed=false,groundLoading=false,contextLost=false;
  let lastCollisionPrefetch=0;
  const startTime=performance.getEntriesByName('campus-3d-start').at(-1)?.startTime??performance.now();
  let firstReady:Record<string,unknown>|null=null;
  let lastSafe:{x:number;z:number;height:number}|null=null;
  const sharedView=parseView(recoveryView??location.hash);
  let sharedRestored=false;
  let navigationPolicy='pending';
  let yaw = 0, pitch = 0, groundNotice = '';
  const held = new Set<string>();
  const moveInput = new THREE.Vector3();
  const walkPosition = new THREE.Vector3(), walkDirection = new THREE.Vector3();
  const eyeHeight = 1.65;
  let lookPointer: number | null = null, lookX = 0, lookY = 0;
  let manifest: Manifest | null = null;
  let tiles: Tile[] = [];
  let destroyed = false, dirty = true, loadingManifest = false;
  let activeLoads = 0, frameId = 0, lastTime = performance.now(), lastSchedule = 0, lastStatus = 0, lastInput = 0;
  let error = '', manifestFailed = false;
  let modelUpdateAvailable=false,checkingUpdate=false;
  const candidateName=new URLSearchParams(location.search).get('candidate')??'';
  const candidatePreview=['127.0.0.1','localhost'].includes(location.hostname)&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidateName);
  let renderedFrames = 0, renderTime = 0, meanFrame = 0;
  let treeMode: Trees = 'off', treeLoading = false, treeFailed = false;
  const treeVariants: Partial<Record<'detailed' | 'medium' | 'light', THREE.InstancedMesh[]>> = {};
  const treeSpheres: THREE.Sphere[] = [];
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4(), focus = new THREE.Vector3(), temp = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const activePointers = new Set<number>();
  let down = { x: 0, y: 0, time: 0 }, lastTap = { x: 0, y: 0, time: 0 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const quality = (): QualityLevel => options.quality;

  function requestRender(shadow = true) { dirty=true; if(shadow){sun.shadow.needsUpdate=true;if(renderer instanceof THREE.WebGLRenderer)renderer.shadowMap.needsUpdate=true;} }
  const materialTextures = (material: THREE.Material) => Object.values(material).filter((value): value is THREE.Texture => value instanceof THREE.Texture);
  function lightmappedCount(){let n=0;group.traverse(o=>{if(o instanceof THREE.Mesh&&o.userData.webLightmap)n++;});return n;}
  function prepareMaterials(object: THREE.Object3D, namespace = '') {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const list = Array.isArray(child.material) ? child.material : [child.material];
      const canonical = list.map((originalMaterial) => {
        let material=originalMaterial;
        if(material instanceof THREE.MeshStandardMaterial&&material.userData.webLightmapMode==='combined-diffuse'&&material.emissiveMap){
          const basic=new THREE.MeshBasicMaterial({name:material.name,map:material.emissiveMap,side:material.side});
          basic.map!.userData.campusNativeAtlas=true;basic.map!.minFilter=THREE.LinearFilter;basic.map!.magFilter=THREE.LinearFilter;
          basic.color.setScalar(Number(material.userData.webLightmapGain));
          basic.userData={...material.userData};material.dispose();material=basic;child.userData.webLightmap=true;
        }
        if(material instanceof THREE.MeshStandardMaterial&&/^EXT_Research_Subsoil(?:\.\d+)*$/.test(material.name)&&!material.userData.groundUnderlayDepth){
          // R152 bedding and finished stair tiles share exact positions. Move
          // only bedding's rendered depth back 3 mm, keeping its screen outline
          // and all source/collision geometry intact (also works with log depth).
          material.onBeforeCompile=shader=>{
            shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
              mvPosition.xyz *= 1.0 + 0.003 / max(length(mvPosition.xyz), 0.001);
              gl_Position = projectionMatrix * mvPosition;`);
          };
          material.customProgramCacheKey=()=> 'campus-ground-underlay-depth-v1';
          material.userData.groundUnderlayDepth=true;
        }
        const baked=material.userData?.webLightmap;
        if(baked&&material instanceof THREE.MeshStandardMaterial)
          child.userData.webLightmap=prepareBakedDaylight(material,options.lightmaps!==false);
        if(material instanceof THREE.MeshStandardMaterial&&material.userData.webTreeSelfOcclusion){
          if((child.geometry.getAttribute('color')?.itemSize??0)<2)throw new Error('Tree visibility data is missing');
          prepareTreeSelfOcclusion(material);
        }
        const key = `${namespace}|${material.name || material.uuid}|${baked?material.uuid:''}`;
        const previous = materialCache.get(key);
        if (previous) {
          if (previous !== material) {
            for (const texture of materialTextures(material)) if (!keptTextures.has(texture)) texture.dispose();
            material.dispose();
          }
          return previous;
        }
        for(const [slot,texture] of Object.entries(material))if(texture instanceof THREE.Texture){
          const key=textureSharingKey(texture);if(!key)continue;
          const shared=sharedTextures.get(key);
          if(shared&&shared!==texture){
            (material as unknown as Record<string,unknown>)[slot]=shared;
            texture.dispose();
          }else if(!shared){sharedTextures.set(key,texture);sharedTextureKeys.set(texture,key);}
        }
        for (const texture of materialTextures(material)) { texture.anisotropy = texture.userData.campusNativeAtlas?1:Math.min(QUALITY_PROFILES[quality()].anisotropy, backend.maxAnisotropy); keptTextures.add(texture); }
        for (const texture of new Set(materialTextures(material))) textureRefs.set(texture, (textureRefs.get(texture) ?? 0) + 1);
        materialCache.set(key, material);
        materialKeys.set(material, key);
        return material;
      });
      for (const material of canonical) materialRefs.set(material, (materialRefs.get(material) ?? 0) + 1);
      child.material = Array.isArray(child.material) ? canonical : canonical[0];
      child.userData.webMaterialsReady = true;
      // Opaque glTF glass is a visual approximation. Let daylight pass through
      // panes while frames, walls and roofs remain ordinary shadow casters.
      child.castShadow = !canonical.some((m) => (m instanceof THREE.MeshPhysicalMaterial && m.transmission > .1) || m.transparent || /glass|glazing|skybluewindow/i.test(m.name));
      child.receiveShadow = true;
      child.frustumCulled = true;
      child.geometry.computeBoundingSphere();
      child.matrixAutoUpdate = false;
      child.updateMatrix();
    });
    object.updateMatrixWorld(true);
  }
  async function prepareForDisplay(object:THREE.Object3D){
    if(renderer instanceof THREE.WebGLRenderer){
      try{
      object.traverse(o=>{if(o instanceof THREE.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])for(const t of materialTextures(m))renderer.initTexture(t);});
      // Three r185 compileAsync polls disposed programs after context loss.
      // Keep the same readiness gate, with cancellation before backend disposal.
      const pending=renderer.compile(object,camera,scene);
      await waitForShaderPrograms(()=>{
        if(renderer.getContext().isContextLost())throw new DOMException('GPU context lost','AbortError');
        for(const material of pending){
          const program=(renderer.properties.get(material) as {currentProgram?:{isReady():boolean}}).currentProgram;
          if(!program)throw new Error('Shader program unavailable');
          if(program.isReady())pending.delete(material);
        }
        return pending.size===0;
      },abort.signal);
      }catch(cause){disposeObject(object);throw cause;}
    }
  }
  function disposeObject(object: THREE.Object3D, materials = false) {
    const geometries = new Set<THREE.BufferGeometry>();
    const rawMaterials = new Set<THREE.Material>();
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      geometries.add(child.geometry);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (child.userData.webMaterialsReady) {
          const references = (materialRefs.get(material) ?? 1) - 1;
          if (references > 0) { materialRefs.set(material, references); continue; }
          materialRefs.delete(material);
          const key = materialKeys.get(material); if (key) materialCache.delete(key);
          materialKeys.delete(material);
          for (const texture of new Set(materialTextures(material))) {
            const count = (textureRefs.get(texture) ?? 1) - 1;
            if (count > 0) textureRefs.set(texture, count);
            else {
              textureRefs.delete(texture);keptTextures.delete(texture);
              const key=sharedTextureKeys.get(texture);if(key)sharedTextures.delete(key);
              sharedTextureKeys.delete(texture);texture.dispose();
            }
          }
          material.dispose();
        } else if (materials) rawMaterials.add(material);
      }
    });
    for (const material of rawMaterials) {
      for (const texture of materialTextures(material)) if (!keptTextures.has(texture)) texture.dispose();
      material.dispose();
    }
    for (const geometry of geometries) geometry.dispose();
    object.removeFromParent();
  }
  function textureBytes() {
    let total = 0;
    for (const texture of keptTextures) {
      total += estimateTextureBytes(texture);
    }
    return total;
  }
  function geometryBytes(object: THREE.Object3D) {
    const arrays = new Set<ArrayBufferLike>();
    object.traverse((child) => { if (child instanceof THREE.Mesh) {
      for (const attr of Object.values(child.geometry.attributes) as (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[]) arrays.add(attr.array.buffer);
      if (child.geometry.index) arrays.add(child.geometry.index.array.buffer);
    } });
    return [...arrays].reduce((n, array) => n + array.byteLength, 0);
  }

  async function loadTile(tile: Tile, level: Level) {
    const asset = lightingAsset(tile.spec,level,quality(),manifest!.source.sha256,backend.maxTextureSize);
    if (tile.loading.has(level) || tile.failures.has(level) || tile[level]?.assetSha256===asset?.sha256) return;
    if (!asset) return;
    tile.loading.add(level); activeLoads++;
    try {
      const gltf = await loader.loadAsync(asset.url);
      if (destroyed) { disposeObject(gltf.scene, true); return; }
      tagTextureSources(gltf.scene,gltf.parser.json);
      prepareMaterials(gltf.scene, level);
      // Compile and upload off-screen before publishing the resident slot.
      await prepareForDisplay(gltf.scene);
      // A finished download stays resident (hidden) even if the view moved away; the memory budget decides eviction.
      if(destroyed){disposeObject(gltf.scene,true);return;}
      const previous=tile[level];
      gltf.scene.visible = previous?.object.visible??false;
      group.add(gltf.scene);
      tile[level] = { object: gltf.scene, bytes: geometryBytes(gltf.scene), lastUsed: performance.now(),assetSha256:asset.sha256 };
      if(previous)disposeObject(previous.object);
      requestRender();
    } catch (cause) {
      if (!destroyed) { console.warn('Campus chunk load failed', tile.spec.id, level, cause); tile.failures.add(level); error = '一部のモデルを読み込めませんでした'; }
    } finally { tile.loading.delete(level); activeLoads--; lastSchedule = 0; }
  }

  function neededTreeLevels():('light'|'medium'|'detailed')[]{
    if(!manifest?.trees)return [];
    if(manifest.trees.renderMode==='unlit-shared')return ['light'];
    if(QUALITY_PROFILES[quality()].allFull)return ['detailed'];
    const levels:('light'|'medium'|'detailed')[]=['light'];
    const visible=treeSpheres.filter(s=>frustum.intersectsSphere(s));
    if(manifest.trees.renderMode==='pbr-lod'){
      if(visible.some(s=>camera.position.distanceTo(s.center)<160))levels.push('medium');
      if(visible.some(s=>camera.position.distanceTo(s.center)<(options.trees==='detailed'?65:35)))levels.push('detailed');
    }else if(options.trees==='detailed'&&visible.some(s=>camera.position.distanceTo(s.center)<160))levels.push('detailed');
    return levels;
  }
  async function loadTrees() {
    if (!manifest?.trees || treeLoading || treeFailed || options.trees === 'off') return;
    const treeSpec = manifest.trees;
    const mode = options.trees;
    treeLoading = true;
    try {
      // Both levels are available for detailed trees; distant trees stay light.
      // Do not allocate every tree quality at startup on a phone. Visible
      // distance rules stay unchanged; manual highest still requests full trees.
      const levels=neededTreeLevels();
      for (const level of levels) {
        if (treeVariants[level]) continue;
        const asset=treeSpec[level];if(!asset)continue;
        const gltf = await loader.loadAsync(asset.url);
        if (destroyed) { disposeObject(gltf.scene, true); return; }
        if(treeSpec.renderMode==='unlit-shared'){
          const materials=new Set<THREE.Material>();
          gltf.scene.traverse(child=>{if(child instanceof THREE.Mesh)for(const material of Array.isArray(child.material)?child.material:[child.material])materials.add(material);});
          for(const material of materials){
            if(!(material instanceof THREE.MeshBasicMaterial))throw new Error('Unlit tree material required');
            material.color.multiplyScalar(treeSpec.brightness??1);
          }
        }
        tagTextureSources(gltf.scene,gltf.parser.json);
        prepareMaterials(gltf.scene, `trees-${level}`);
        const meshes: THREE.InstancedMesh[] = [],staged=new THREE.Group();
        const transforms = treeSpec.transforms;
        gltf.scene.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const instanced = new THREE.InstancedMesh(child.geometry, child.material, transforms.length);
          instanced.userData.localMatrix = child.matrixWorld.clone();
          instanced.userData.webMaterialsReady = true;
          instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          instanced.castShadow = treeSpec.renderMode !== 'unlit-shared';
          instanced.receiveShadow = treeSpec.renderMode !== 'unlit-shared';
          // Individual instances are culled and compacted below, including a
          // margin for shadows, rather than relying on one campus-wide bound.
          instanced.frustumCulled = false;
          instanced.count = 0; staged.add(instanced); meshes.push(instanced);
        });
        await prepareForDisplay(staged);
        if(destroyed){disposeObject(staged);return;}
        treeGroup.add(...meshes);
        treeVariants[level] = meshes;
        if (!treeSpheres.length) {
          const box = new THREE.Box3().setFromObject(gltf.scene);
          for (const transform of transforms) treeSpheres.push(box.clone().applyMatrix4(new THREE.Matrix4().fromArray(transform)).getBoundingSphere(new THREE.Sphere()));
        }
        // A slow later level must not postpone showing the already ready trees.
        lastSchedule=0;requestRender();
      }
      treeMode = mode; requestRender();
    } catch { treeFailed = true; error = '樹木を読み込めませんでした'; }
    finally { treeLoading = false; lastSchedule = 0; requestRender(); }
  }
  const displayedTreeLevels:('light'|'medium'|'detailed'|undefined)[]=[];
  function updateTrees() {
    treeGroup.visible = options.trees !== 'off';
    if (!manifest?.trees || !treeGroup.visible) return;
    const matrices = { light: [] as THREE.Matrix4[], medium: [] as THREE.Matrix4[], detailed: [] as THREE.Matrix4[] };
    for (const [i, transform] of manifest.trees.transforms.entries()) {
      const sphere = treeSpheres[i]; if (!sphere) continue;
      const distance = camera.position.distanceTo(sphere.center);
      const margin = sphere.clone(); margin.radius += 18;
      if (!frustum.intersectsSphere(margin) && distance > controls.distance + 100) continue;
      // Even standard trees keep the original mesh within walking distance.
      const fullDistance=options.trees==='detailed'?65:35;
      const allFull=QUALITY_PROFILES[quality()].allFull;
      const sharedUnlit:boolean=manifest.trees.renderMode==='unlit-shared';
      if(allFull&&!sharedUnlit&&!treeVariants.detailed&&!displayedTreeLevels[i])continue;
      const level = sharedUnlit?'light':allFull?(treeVariants.detailed?'detailed':displayedTreeLevels[i]!):manifest.trees.renderMode==='pbr-lod'
        ?distance<fullDistance&&treeVariants.detailed?'detailed':distance<160&&treeVariants.medium?'medium':'light'
        :options.trees === 'detailed' && distance < 160 && treeVariants.detailed ? 'detailed' : 'light';
      if(!treeVariants[level])continue;
      displayedTreeLevels[i]=level;
      matrices[level].push(new THREE.Matrix4().fromArray(transform));
    }
    for (const level of ['light', 'medium', 'detailed'] as const) for (const mesh of treeVariants[level] ?? []) {
      mesh.count = matrices[level].length;
      for (const [i, matrix] of matrices[level].entries()) mesh.setMatrixAt(i, matrix.clone().multiply(mesh.userData.localMatrix));
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function schedule(now: number) {
    if (!manifest) return;
    const profile = QUALITY_PROFILES[quality()];
    camera.updateMatrixWorld(); projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(projection,renderer.coordinateSystem,camera.reversedDepth);
    occlusionDeferred=0;
    const queue: { tile: Tile; level: Level; score: number }[] = [];
    let memory = textureBytes();
    for (const tile of tiles) {
      const distance = tile.box.distanceToPoint(camera.position);
      const visible = frustum.intersectsBox(tile.box);
      const isInterior = tile.spec.kind === 'interior';
      const near = distance < 100;
      const interiorNear=isInterior&&options.interiors!==false&&mode!=='orbit'&&tile.box.distanceToPoint(camera.position)<8&&camera.position.y>tile.box.min.y-1.5&&camera.position.y<tile.box.max.y+1.5;
      // Load only the current view; no widened-frustum or distance prefetch.
      const relevant=tile.spec.kind==='context'?false:isInterior?interiorNear:visible;
      // Nearest bound is conservative for long buildings and zoomed close views.
      const pixels = tile.sphere.radius * drawingSize.y / Math.max(.035, distance * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV() / 2)));
      const hidden=occlusion.test(tile.spec.id,visible&&!isInterior,distance,now);
      if(hidden)occlusionDeferred++;
      const lod=chooseLOD(tile.spec,{...profile,fullDistance:profile.fullDistance*(mode==='orbit'?1.5:1)},distance,pixels,tile.activeLevel??null,isInterior,hidden,manifest.source.sha256);
      tile.desired=relevant?lod:null;
      const desired = tile.desired;
      const retained=tile.activeLevel&&validatedLOD(tile.spec,tile.activeLevel,manifest.source.sha256,pixels)?tile[tile.activeLevel]:undefined;
      const active = desired ? (tile[desired] ?? retained ?? tile.full) : null;
      if(active)tile.activeLevel=LOD_LEVELS.find(level=>tile[level]===active);
      for (const level of LOD_LEVELS) {
        const resident = tile[level]; if (!resident) continue;
        resident.object.visible = resident === active;
        if (resident === active) resident.lastUsed = now;
        memory += resident.bytes;
      }
      if (desired && tile[desired]?.assetSha256!==lightingAsset(tile.spec,desired,quality(),manifest.source.sha256,backend.maxTextureSize)?.sha256) {
        // Load the required detail directly; a coarse seed can be visibly
        // distorted while the correct facade waits behind other downloads.
        queue.push({tile,level:desired,score:distance+(visible?0:5000)+(isInterior?-400:0)-(near&&tile.spec.kind==='terrain'?1000:0)});
      }
    }
    const budget = (options.memoryMiB ?? profile.memoryMiB) * 1024 * 1024;
    if (memory > budget) {
      const unused = tiles.flatMap((tile) => (LOD_LEVELS).flatMap((level) => tile[level] && !tile[level]!.object.visible ? [{ tile, level, resident: tile[level]! }] : [])).sort((a,b) => a.resident.lastUsed - b.resident.lastUsed);
      for (const entry of unused) {
        if (memory <= budget) break;
        if (now - entry.resident.lastUsed < 8000) continue;
        const beforeTextures = textureBytes();
        disposeObject(entry.resident.object); memory -= entry.resident.bytes + beforeTextures - textureBytes(); delete entry.tile[entry.level];
      }
    }
    queue.sort((a,b) => a.score - b.score);
    for (const item of queue) {
      if (activeLoads >= profile.loads) break;
      void loadTile(item.tile, item.level);
    }
    if (!treeLoading && !treeFailed && options.trees !== 'off' && activeLoads < 3 &&
        (treeMode !== options.trees || neededTreeLevels().some(level=>!treeVariants[level]))) void loadTrees();
    updateTrees();
    canvas.dataset.loadedChunks = String(tiles.filter((tile) => LOD_LEVELS.some(level=>tile[level])).length);
    residentMiB = memory / 1024 / 1024;
    canvas.dataset.residentMb = residentMiB.toFixed(1);
    requestRender();
  }

  function updateSun() {
    if (mode === 'orbit') controls.getTarget(focus); else focus.copy(camera.position).addScaledVector(camera.getWorldDirection(temp), 22);
    const span = mode === 'orbit' ? THREE.MathUtils.clamp(controls.distance * .72, 18, 480) : 65;
    sun.target.position.copy(focus);
    sun.position.copy(focus).add(temp.fromArray(daylight.sunDirection).multiplyScalar(800));
    const shadow = sun.shadow.camera;
    shadow.left = -span; shadow.right = span; shadow.top = span; shadow.bottom = -span;
    const reach=span*Math.SQRT2+130;
    shadow.near=Math.max(1,800-reach);shadow.far=800+reach;
    shadow.updateProjectionMatrix(); sun.target.updateMatrixWorld();
  }
  function resize() {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    const q = quality(), profile = QUALITY_PROFILES[q];
    const limit=backend.maxTextureSize;
    const {ratio,width:renderWidth,height:renderHeight}=renderSize(q,width,height,window.devicePixelRatio,limit);
    if(benchmark.running&&(drawingSize.x!==renderWidth||drawingSize.y!==renderHeight))stopBenchmark('画面サイズが変わったため計測を中止しました');
    backend.configure(width,height,ratio,profile.antialiasSamples,0);
    renderer.getDrawingBufferSize(drawingSize);
    camera.aspect = width / height; camera.updateProjectionMatrix(); requestRender(); lastSchedule = 0;
    renderer.shadowMap.enabled = options.shadows && profile.shadowSize > 0 && (manifest?.environment?.sunIntensity??daylight.sunIntensity)>0; sun.castShadow = renderer.shadowMap.enabled;
    const mapSize = Math.min(profile.shadowSize || 1024, backend.maxTextureSize);
    if (sun.shadow.mapSize.x !== mapSize) { sun.shadow.mapSize.set(mapSize, mapSize); sun.shadow.dispose(); }
    if (appliedQuality !== q) {
      for (const texture of keptTextures) {
        texture.anisotropy = texture.userData.campusNativeAtlas?1:Math.min(profile.anisotropy,backend.maxAnisotropy);texture.needsUpdate = true;
      }
      appliedQuality = q;
      meanFrame = renderTime = renderedFrames = 0; wasRendering = false;
    }
    canvas.dataset.quality=q;canvas.dataset.renderResolution=`${drawingSize.x}x${drawingSize.y}`;
    const restrictions=[];
    if(backend.maxSamples<profile.antialiasSamples)restrictions.push(`輪郭の補正：端末上限 ${backend.maxSamples}（設定 ${profile.antialiasSamples}）`);
    if(backend.maxAnisotropy<profile.anisotropy)restrictions.push(`斜め方向のテクスチャ精度：端末上限 ${backend.maxAnisotropy}（設定 ${profile.anisotropy}）`);
    if(backend.maxTextureSize<profile.shadowSize)restrictions.push(`影の解像度：端末上限 ${backend.maxTextureSize}（設定 ${profile.shadowSize}）`);
    const limitedLightmaps=manifest?.chunks.filter(c=>lightingAsset(c,'full',q,manifest!.source.sha256)?.sha256!==lightingAsset(c,'full',q,manifest!.source.sha256,limit)?.sha256).length??0;
    const realtimeFallbacks=manifest?.chunks.filter(c=>c.lightingFallback&&lightingAsset(c,'full',q,manifest!.source.sha256,limit)?.sha256===c.lightingFallback.asset.sha256).length??0;
    if(limitedLightmaps>realtimeFallbacks)restrictions.push(`照明画像：端末上限 ${limit}px のため ${limitedLightmaps-realtimeFallbacks} 区域で対応解像度を使用（形状は精細のまま）`);
    if(realtimeFallbacks)restrictions.push(`照明画像が端末上限 ${limit}px に収まらない ${realtimeFallbacks} 区域は簡易照明で表示（形状は精細のまま）`);
    const unlimited=renderSize(q,width,height,window.devicePixelRatio,Infinity);
    if(renderWidth<unlimited.width||renderHeight<unlimited.height)restrictions.push(`描画寸法：端末上限 ${backend.maxTextureSize}px`);
    backend.fallback=restrictions.join('。');canvas.dataset.hardwareLimits=backend.fallback;
  }
  function startBenchmark() {
    if (!manifest) { benchmarkMessage = 'モデルを読み込んでから計測してください'; return; }
    const profile = QUALITY_PROFILES[quality()];
    benchmarkConfig = { id:++benchmarkSequence, quality:quality(), width:drawingSize.x, height:drawingSize.y,
      shadowSize:renderer.shadowMap.enabled ? sun.shadow.mapSize.x : 0, aoSamples:backend.aoSamples,
      antialiasSamples:backend.samples, revision:manifest.revision, position:camera.position.toArray() };
    benchmarkMessage = '';benchmark.start();wasRendering = false;meanFrame = renderTime = renderedFrames = 0;
    requestRender();report(performance.now());
  }
  function stopBenchmark(message = '計測を中止しました') {
    if (!benchmark.running) return;
    benchmark.stop();benchmarkConfig=null;benchmarkMessage=message;report(performance.now());
  }
  function applyWalkingCamera() {
    camera.position.copy(walkPosition);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    requestRender(); lastInput = performance.now();
  }
  function clearMovement() { held.clear(); moveInput.set(0,0,0); lookPointer = null;ground?.pause(); }
  const transition=new NavigationTransition(()=>{if(!destroyed){clearMovement();requestRender();report(performance.now());}});
  const walking=()=>manifest?.walking??fallbackWalking;
  async function landingAt(x:number,z:number,height:number,exact=false):Promise<Landing> {
    if(!ground)throw new Error('歩行データを準備中です。少し待ってから再試行してください');
    try{await ground.ensureAround(x,z);}catch{throw new Error('移動先の床と壁を読み込めませんでした。再試行できます');}
    const point=ground.findNearby(x,z,height,exact?{radius:.5,up:.65,down:.65}:undefined);
    if(!point||!ground.canTraverse(point.x,point.z,.26))throw new Error('近くに立てる床がありません。移動先から場所を選んでください');
    return point;
  }
  function commitMode(next:NavigationMode,landing?:Landing,orientation?:{yaw:number;pitch:number}) {
    clearMovement();
    if(next==='orbit'){
      if(document.pointerLockElement===canvas)document.exitPointerLock();
      camera.getWorldDirection(walkDirection);
      const target=camera.position.clone().addScaledVector(walkDirection,20);
      controls.enabled=true;camera.fov=42;
      void controls.setLookAt(camera.position.x,camera.position.y,camera.position.z,target.x,target.y,target.z,false);
    }else{
      if(mode==='orbit'){
        camera.getWorldDirection(walkDirection);yaw=Math.atan2(-walkDirection.x,-walkDirection.z);
        pitch=Math.asin(THREE.MathUtils.clamp(walkDirection.y,-.9,.9));walkPosition.copy(camera.position);
      }
      if(landing){ground?.teleport(landing);walkPosition.set(landing.x,landing.height+eyeHeight,landing.z);walkGroundHeight=landing.height;lastSafe=landing;pitch=-.05;groundNotice='';}
      if(orientation){yaw=orientation.yaw;pitch=orientation.pitch;}
      controls.enabled=false;camera.fov=65;
    }
    mode=next;camera.updateProjectionMatrix();canvas.dataset.navigationMode=mode;
    canvas.setAttribute('aria-label',mode==='orbit'?'3Dモデル。ドラッグで回転、ホイールで拡大縮小。':'3Dモデル。WASDで移動、ドラッグで見回す。Spaceでジャンプ。');
    if(mode!=='orbit')applyWalkingCamera();lastSchedule=0;requestRender();report(performance.now());
  }
  function setMode(next:NavigationMode) {
    // Even an already-active mode cancels a pending teleport (Home, for example).
    transition.cancel();groundNotice='';
    if(next===mode)return;
    if(next!=='walk'){commitMode(next);return;}
    const start=mode==='orbit'?controls.getTarget(new THREE.Vector3()):new THREE.Vector3(walkPosition.x,walkPosition.y-eyeHeight,walkPosition.z);
    void transition.run(()=>landingAt(start.x,start.z,start.y),point=>commitMode('walk',point),'足元の床と壁を読み込んでいます');
  }
  function goTo(place: WalkPlace) {
    const selected=walking().places.find(p=>p.id===place);if(!selected)return;
    groundNotice='';const [x,height,z]=selected.position;
    return transition.run(()=>landingAt(x,z,height,true),point=>commitMode('walk',point,{
      yaw:Math.atan2(point.x-selected.target[0],point.z-selected.target[2]),pitch:selected.pitch??-.05,
    }),`${selected.label}の床と壁を読み込んでいます`);
  }
  function updateWalking(delta: number) {
    if (mode === 'orbit'||transition.pending) return false;
    let x = moveInput.x + Number(held.has('d') || held.has('arrowright')) - Number(held.has('a') || held.has('arrowleft'));
    let forward = moveInput.y + Number(held.has('w') || held.has('arrowup')) - Number(held.has('s') || held.has('arrowdown'));
    const up = mode === 'fly' ? moveInput.z + Number(held.has('e') || held.has(' ')) - Number(held.has('q')) : 0;
    const length = Math.hypot(x,forward); if (length > 1) { x /= length; forward /= length; }
    if (!x && !forward && !up && mode==='fly') return false;
    const speed = (mode === 'fly' ? 9 : THREE.MathUtils.clamp(options.walkSpeed??3.2,1,5)) * (held.has('shift') ? 2.6 : 1);
    const dx=(Math.cos(yaw)*x - Math.sin(yaw)*forward)*speed*delta;
    const dz=(-Math.sin(yaw)*x - Math.cos(yaw)*forward)*speed*delta;
    if (mode === 'fly') {
      walkPosition.x+=dx;walkPosition.z+=dz;
      walkPosition.y += (up + Math.sin(pitch)*forward)*speed*delta;
    } else if(ground) {
      const changed=ground.update(delta,dx/Math.max(delta,.00001),dz/Math.max(delta,.00001),ground.canTraverse);
      const point=ground.feet();
      walkPosition.set(point.x,point.height+eyeHeight,point.z);walkGroundHeight=point.height;lastSafe=ground.lastSafe;
      if(performance.now()-lastCollisionPrefetch>250){ground.prefetch(point.x,point.z);lastCollisionPrefetch=performance.now();}
      groundNotice=ground.failedTileCount?'一部の歩行データを読み込めませんでした。再試行できます':ground.blockedByStreaming?'周囲の床と壁の読み込みを待っています':ground.blockedByEdge?'歩ける地面の端です。別の方向へ進んでください':'';
      if(!transition.error&&(point.height < -15||(lastSafe&&point.height<lastSafe.height-6)))void recover();
      if(!changed)return false;
    }
    if (manifest) {
      walkPosition.x = THREE.MathUtils.clamp(walkPosition.x,manifest.bounds[0][0]-65,manifest.bounds[1][0]+65);
      walkPosition.z = THREE.MathUtils.clamp(walkPosition.z,manifest.bounds[0][2]-65,manifest.bounds[1][2]+65);
    }
    walkPosition.y = THREE.MathUtils.clamp(walkPosition.y,-10,240);
    applyWalkingCamera(); return true;
  }
  async function goToChunk(id:string){
    const tile=tiles.find(t=>t.spec.id===id);if(!tile)return;
    const box=tile.box.clone();
    if(tile.spec.navigationGroup)for(const other of tiles)if(other.spec.navigationGroup===tile.spec.navigationGroup)box.union(other.box);
    const c=box.getCenter(new THREE.Vector3());
    if(tile.spec.kind==='interior'&&ground){
      return transition.run(async()=>{
        const point=await landingAt(c.x,c.z,tile.box.min.y+.20,true);
        if(point.x<tile.box.min.x||point.x>tile.box.max.x||point.z<tile.box.min.z||point.z>tile.box.max.z)throw new Error('この階の開始位置は未確認です');
        return point;
      },point=>commitMode('walk',point,{yaw:0,pitch:0}),'この階の床と壁を読み込んでいます');
    }
    setMode('orbit');const r=Math.max(12,box.getBoundingSphere(new THREE.Sphere()).radius*1.7);
    void controls.setLookAt(c.x+r,c.y+r*.6,c.z+r,c.x,c.y,c.z,!reducedMotion);lastSchedule=0;requestRender();
  }
  async function recover(){
    if(!ground){home();return;}
    if(!lastSafe){await goTo(walking().defaultPlaceId);return;}
    const point={...lastSafe},orientation={yaw,pitch};
    return transition.run(()=>landingAt(point.x,point.z,point.height,true),p=>commitMode('walk',p,orientation),'復帰先の床と壁を確認しています');
  }
  function shareView(){
    const target=mode==='orbit'?controls.getTarget(new THREE.Vector3()):camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()),10);
    const state:ViewState={version:1,release:manifest?.release??'unknown',mode,position:camera.position.toArray(),target:target.toArray()};
    return location.origin+location.pathname+serializeView(state);
  }
  function home() {
    if (!manifest) return;
    setMode('orbit');
    const bounds = toBox(manifest.bounds), sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const center = bounds.getCenter(new THREE.Vector3()); center.y = Math.max(22, manifest.home.target[1]);
    const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const distance = sphere.radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.04;
    const direction = new THREE.Vector3(...manifest.home.position).sub(new THREE.Vector3(...manifest.home.target)).normalize();
    const position = center.clone().addScaledVector(direction, distance);
    void controls.setLookAt(position.x,position.y,position.z,center.x,center.y,center.z,!reducedMotion); lastSchedule = 0;
  }
  function north() { if (mode !== 'orbit') { yaw = 0; applyWalkingCamera(); } else void controls.rotateTo(0, controls.polarAngle, !reducedMotion); }
  function top() { if (mode !== 'orbit') home(); void controls.rotateTo(0, .0001, !reducedMotion); }
  function zoom(direction: number) {
    if(transition.pending)return;
    if (mode !== 'orbit') {
      camera.getWorldDirection(walkDirection);
      if(mode==='walk'&&ground) {
        ground.update(1/30,walkDirection.x*direction*3.2,walkDirection.z*direction*3.2,ground.canTraverse);
        const point=ground.feet();
        walkPosition.set(point.x,point.height+eyeHeight,point.z);walkGroundHeight=point.height;
      } else if(mode==='fly')walkPosition.addScaledVector(walkDirection,direction*2);
      applyWalkingCamera();return;
    }
    void controls.dollyTo(Math.max(.35, controls.distance * (direction > 0 ? .72 : 1.38)), !reducedMotion);
  }
  function focusAt(x: number, y: number) {
    if (mode !== 'orbit') return;
    const rect = canvas.getBoundingClientRect(); pointer.set((x-rect.left)/rect.width*2-1,1-(y-rect.top)/rect.height*2);
    raycaster.setFromCamera(pointer,camera);
    const visible = group.children.filter((child) => child.visible);
    const hit = raycaster.intersectObjects(visible,true)[0];
    if (!hit) return;
    void controls.setLookAt(camera.position.x,camera.position.y,camera.position.z,hit.point.x,hit.point.y,hit.point.z,!reducedMotion);
    lastSchedule = 0;
  }
  function key(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || event.ctrlKey || event.metaKey || event.altKey) return;
    if((event.target instanceof HTMLElement&&event.target.isContentEditable)||host.parentElement?.querySelector('.viewer-panel'))return;
    const code = event.key.toLowerCase();
    if (code === 'escape') { transition.cancel(); clearMovement(); return; }
    if(transition.pending&&!['home','t','f'].includes(code))return;
    if (mode !== 'orbit' && ['w','a','s','d','arrowleft','arrowright','arrowup','arrowdown','q','e',' ','shift'].includes(code)) {
      if (event.target instanceof HTMLButtonElement && (code === ' ' || code === 'enter')) return;
      if(code===' '&&mode==='walk'){if(!event.repeat)ground?.jump();event.preventDefault();return;}
      held.add(code); event.preventDefault(); lastInput = performance.now(); return;
    }
    const step = Math.max(.25, controls.distance * .025);
    switch(event.key.toLowerCase()) {
      case 'home': home(); break; case 't': top(); break; case 'n': north(); break;
      case 'f': setMode(mode === 'fly' ? 'walk' : 'fly'); break;
      case '+': case '=': zoom(1); break; case '-': zoom(-1); break;
      case 'arrowleft': void controls.truck(-step,0,!reducedMotion); break;
      case 'arrowright': void controls.truck(step,0,!reducedMotion); break;
      case 'arrowup': void controls.truck(0,step,!reducedMotion); break;
      case 'arrowdown': void controls.truck(0,-step,!reducedMotion); break;
      default: return;
    }
    event.preventDefault(); lastInput=performance.now();
  }
  function pointerDown(event: PointerEvent) {
    canvas.focus({preventScroll:true});activePointers.add(event.pointerId);down={x:event.clientX,y:event.clientY,time:performance.now()};lastInput=down.time;
    if (mode !== 'orbit' && lookPointer === null) {
      lookPointer=event.pointerId;lookX=event.clientX;lookY=event.clientY;canvas.setPointerCapture(event.pointerId);
    }
  }
  function pointerMove(event: PointerEvent) {
    if (mode === 'orbit' || document.pointerLockElement===canvas || event.pointerId !== lookPointer) return;
    yaw -= (event.clientX-lookX)*.004*(options.lookSensitivity??1);
    pitch = THREE.MathUtils.clamp(pitch-(event.clientY-lookY)*.004*(options.lookSensitivity??1),-Math.PI*.46,Math.PI*.46);
    lookX=event.clientX;lookY=event.clientY;applyWalkingCamera();
  }
  function pointerUp(event: PointerEvent) {
    const now=performance.now();const solo=activePointers.size===1;activePointers.delete(event.pointerId);
    if (event.pointerId===lookPointer) lookPointer=null;
    if (event.pointerType==='touch' && solo && now-down.time<250 && Math.hypot(event.clientX-down.x,event.clientY-down.y)<8) {
      if (now-lastTap.time<330 && Math.hypot(event.clientX-lastTap.x,event.clientY-lastTap.y)<22) {focusAt(event.clientX,event.clientY);lastTap.time=0;}
      else lastTap={x:event.clientX,y:event.clientY,time:now};
    }
  }
  const lockPointer=()=>{if(mode!=='orbit'&&canvas.requestPointerLock)try{void Promise.resolve(canvas.requestPointerLock()).catch(()=>{});}catch{/* Drag remains available. */}};
  const lockedLook=(event:MouseEvent)=>{if(document.pointerLockElement!==canvas||mode==='orbit')return;
    yaw-=event.movementX*.0025*(options.lookSensitivity??1);pitch=THREE.MathUtils.clamp(pitch-event.movementY*.0025*(options.lookSensitivity??1),-Math.PI*.46,Math.PI*.46);applyWalkingCamera();};
  const doubleClick=(event:MouseEvent)=>{if(mode==='orbit')focusAt(event.clientX,event.clientY);else lockPointer();};
  const lostCapture=(event:PointerEvent)=>{activePointers.delete(event.pointerId);if(lookPointer===event.pointerId)lookPointer=null;};
  const lockChanged=()=>{if(document.pointerLockElement!==canvas)clearMovement();};
  document.addEventListener('pointerlockchange',lockChanged);
  canvas.addEventListener('lostpointercapture',lostCapture);document.addEventListener('mousemove',lockedLook);
  const contextMenu=(event:Event)=>event.preventDefault();
  const input=()=>{lastInput=performance.now();};
  const keyUp=(event:KeyboardEvent)=>held.delete(event.key.toLowerCase());
  const visibility=()=>{if(document.hidden) { clearMovement();wasRendering=false;stopBenchmark('ページが非表示になったため計測を中止しました'); }else void checkModelUpdate();};
  // Recreate the backend, PMREM, targets, shadows and model buffers together.
  // Updating texture flags alone leaves GPU-only render targets empty after loss.
  const lost=(event:Event)=>{event.preventDefault();contextLost=true;clearMovement();stopBenchmark('3D表示が中断されたため計測を中止しました');error='3D表示が中断されました。「再試行」か「軽量に戻す」をお試しください';report(performance.now());};
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);
  canvas.addEventListener('pointermove',pointerMove);
  canvas.addEventListener('dblclick',doubleClick);canvas.addEventListener('contextmenu',contextMenu);canvas.addEventListener('wheel',input,{passive:true});
  canvas.addEventListener('webglcontextlost',lost);
  window.addEventListener('keydown',key); window.addEventListener('keyup',keyUp); window.addEventListener('blur',clearMovement); document.addEventListener('visibilitychange',visibility); controls.addEventListener('update',()=>requestRender());
  const observer=new ResizeObserver(resize);observer.observe(host);

  async function restoreSharedView(){
    const state=sharedView;if(!state||sharedRestored||!manifest)return;
    const box=toBox(manifest.bounds).expandByScalar(100);
    if(!box.containsPoint(new THREE.Vector3(...(state.mode==='orbit'?state.target:state.position))))return;
    if(state.mode==='walk'&&!ground)return;
    sharedRestored=true;setMode(state.mode==='orbit'?'orbit':'fly');
    if(state.mode==='orbit')void controls.setLookAt(...state.position,...state.target,false);
    else{
      walkPosition.fromArray(state.position);walkDirection.fromArray(state.target).sub(walkPosition).normalize();
      yaw=Math.atan2(-walkDirection.x,-walkDirection.z);pitch=Math.asin(THREE.MathUtils.clamp(walkDirection.y,-.99,.99));
      if(state.mode==='walk'){
        const orientation={yaw,pitch};
        await transition.run(()=>landingAt(state.position[0],state.position[2],state.position[1]-eyeHeight,true),point=>commitMode('walk',point,orientation),'共有視点の床と壁を確認しています');
      }else applyWalkingCamera();
    }
    if(state.release!==manifest.release&&!transition.error)groundNotice='共有時からモデルが更新されています';
    requestRender();lastSchedule=0;
  }
  async function loadGround(){
    if(groundLoading||!manifest?.colliders||destroyed)return;
    groundLoading=true;groundFailed=false;groundNotice='歩行データを準備しています';
    try{
      const loaded=await ColliderNavigation.create(manifest.colliders,manifest.source.sha256,abort.signal);
      if(destroyed){loaded.dispose();return;}
      ground?.dispose();ground=loaded;navigationPolicy=loaded.spec.policy;groundNotice='';restoreSharedView();
      // First open starts walking at the default place unless a shared view or the visitor already moved the camera.
      if(!sharedView&&!startedAtDefault&&lastInput===0&&mode==='orbit'){startedAtDefault=true;void goTo(walking().defaultPlaceId);}
    }catch(cause){if(!destroyed){console.warn('Navigation load failed',cause);groundFailed=true;groundNotice='歩行データの読み込みに失敗しました。再試行できます';}}
    finally{groundLoading=false;if(!destroyed){requestRender(false);report(performance.now());}}
  }
  async function loadManifest() {
    if (loadingManifest || destroyed) return;
    loadingManifest=true;error='';manifestFailed=false;
    try {
      const response=await fetch(candidatePreview?`/viewer/candidate-${candidateName}.json`:'/viewer/current.json',{cache:'no-store',signal:abort.signal});
      if (!response.ok) throw new Error('Manifest unavailable');
      const next=resolveManifestAssets(await response.json(),location.origin);
      if (next.schema!=='tempaku-viewer-1' || !next.chunks.length) throw new Error('Invalid model manifest');
      if (destroyed) return;
      await loadSavedEnvironment(next);
      if(destroyed)return;
      manifest=next;
      resize();
      // Temporarily exclude interiors from Web loading, rendering and destinations.
      tiles=next.chunks.filter(spec=>spec.kind!=='interior').map((spec)=>{const box=toBox(spec.bounds);return {spec,box,sphere:box.getBoundingSphere(new THREE.Sphere()),desired:null,loading:new Set(),failures:new Set()};});
      for(const tile of tiles)occlusion.add(tile.spec.id,tile.box);
      canvas.dataset.rendererBackend=backend.name;
      canvas.dataset.modelRevision=next.revision;canvas.dataset.modelRelease=next.release;
      controls.setBoundary(toBox(next.bounds).expandByScalar(1000));
      home();const review=new URLSearchParams(location.search).get('view');if(review)reviewView(review);lastSchedule=0;requestRender();
      restoreSharedView();
      if(next.colliders)void loadGround();
    } catch { if (!destroyed) {manifestFailed=true;error='モデルを読み込めませんでした';} }
    finally {loadingManifest=false;}
  }
  async function checkModelUpdate(){
    if(!manifest||candidatePreview||destroyed||document.hidden||checkingUpdate)return;
    checkingUpdate=true;
    try{
      const response=await fetch('/viewer/current.json',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])});
      if(response.ok&&!destroyed){modelUpdateAvailable=newerRelease(await response.json(),manifest.release);if(!destroyed)report(performance.now());}
    }catch{/* Keep the current working model when an update check is offline. */}
    finally{checkingUpdate=false;}
  }
  const updateTimer=window.setInterval(()=>void checkModelUpdate(),60_000);
  function report(now:number) {
    const loaded=tiles.filter((tile)=>LOD_LEVELS.some(level=>tile[level])).length;
    const wanted=tiles.filter((tile)=>tile.desired).length;
    const pending=tiles.filter((tile)=>tile.desired&&!tile[tile.desired]).length;
    const phase=error||groundFailed||transition.error||ground?.failedTileCount?'error':(!manifest||!loaded||transition.pending?'loading':'ready');
    let message=error||transition.error||transition.message||groundNotice||(!manifest?'モデルを読み込んでいます':pending?`周辺を読み込み中 · ${Math.max(0,wanted-pending)} / ${wanted}`:'表示中');
    if (phase==='ready'&&!groundNotice&&!pending&&meanFrame>42&&options.trees!=='off'&&now-lastInput<2500) message='樹木をOFFにすると動作が軽くなります';
    notify({phase,message,loaded,total:tiles.length,revision:manifest?.revision??'',azimuth:mode === 'orbit' ? controls.azimuthAngle : yaw,distance:controls.distance,fps:meanFrame && now-lastMeasured<900 ? 1000/meanFrame:0,mode,effectiveQuality:quality(),groundReady:!!ground,treesAvailable:!!manifest?.trees,
      renderWidth:drawingSize.x,renderHeight:drawingSize.y,drawCalls:backend.metrics().calls,triangles:backend.metrics().triangles,residentMiB,
      release:manifest?.release??'',sourceFilename:manifest?.source.filename??'',modelUpdateAvailable,navigationPolicy,navigationLoading:groundLoading||transition.pending,walkingPlaces:walking().places.map(p=>({id:p.id,label:p.label})),
      navigationMiB:ground?.residentMiB??0,
      rendererBackend:backend.name,rendererFallback:backend.fallback,occlusionDeferred,compressedTextures:[...keptTextures].filter(t=>t instanceof THREE.CompressedTexture).length,lightmappedMeshes:lightmappedCount(),bakedLightingMode:manifest?.lightmaps?.mode,
      destinations:tiles.filter(t=>(t.spec.kind==='exterior'||t.spec.kind==='interior')&&(!t.spec.navigationGroup||t.spec.navigationGroup===t.spec.id)).map(t=>({id:t.spec.id,label:t.spec.label??t.spec.id.replace(/^EXT_/,''),interior:t.spec.kind==='interior'})),
      benchmarking:benchmark.running,benchmarkRemaining:Math.max(0,Math.ceil((benchmark.durationMs-benchmark.elapsed)/1000)),benchmarkResults,benchmarkMessage});
    canvas.dataset.groundReady=String(!!ground);canvas.dataset.compressedTextures=String([...keptTextures].filter(t=>t instanceof THREE.CompressedTexture).length);canvas.dataset.lightmappedMeshes=String(lightmappedCount());
    canvas.dataset.daylightEnabled=String((options.lightmaps!==false||manifest?.lightmaps?.mode==='combined-diffuse')&&lightmappedCount()>0);
    canvas.dataset.activeLods=JSON.stringify(Object.fromEntries(LOD_LEVELS.map(level=>[level,tiles.filter(t=>t[level]?.object.visible).length])));
    canvas.dataset.requestedQuality=options.quality;
    canvas.dataset.streaming=JSON.stringify({pending:activeLoads,visible:tiles.filter(t=>LOD_LEVELS.some(l=>t[l]?.object.visible)).map(t=>({id:t.spec.id,assets:LOD_LEVELS.filter(l=>t[l]?.object.visible).map(l=>t[l]!.assetSha256),wanted:t.desired?lightingAsset(t.spec,t.desired,quality(),manifest?.source.sha256??'',backend.maxTextureSize)?.sha256:null}))});
    canvas.dataset.treeLods=JSON.stringify(Object.fromEntries(['light','medium','detailed'].map(level=>[level,treeVariants[level as keyof typeof treeVariants]?.[0]?.count??0])));
    canvas.dataset.frameMs=meanFrame.toFixed(2);canvas.dataset.drawCalls=String(backend.metrics().calls);canvas.dataset.renderedTriangles=String(backend.metrics().triangles);
    canvas.dataset.camera=JSON.stringify({position:camera.position.toArray(),target:(mode==='orbit'?controls.getTarget(new THREE.Vector3()):camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()),10)).toArray()});
    canvas.dataset.collision=JSON.stringify({modelSha256:manifest?.colliders?.sourceModelSha256,loadedTiles:ground?.loadedTileCount??0,pendingTiles:ground?.pendingTileCount??0,failedTiles:ground?.failedTileCount??0,grounded:ground?.grounded??false,feet:ground?.active?ground.feet():null,blocked:ground?.blockedByStreaming??false,pending:transition.pending,edge:ground?.blockedByEdge??false});
    if(!firstReady&&loaded>=Math.min(4,wanted)&&loaded>0&&!groundLoading){firstReady={milliseconds:now-startTime,...transferMetrics(startTime)};}
    canvas.dataset.performance=JSON.stringify({startTime,firstReady,transfer:transferMetrics(startTime),drawSize:[drawingSize.x,drawingSize.y],devicePixelRatio:devicePixelRatio,
      modelResidentMiB:residentMiB,colliderDecodedMiB:ground?.residentMiB??0,colliderDownloadedBytes:ground?.downloadedBytes??0,benchmarks:benchmarkResults});
  }
  function frame(now:number) {
    if (destroyed) return;
    frameId=requestAnimationFrame(frame);
    const interval=now-lastTime;const delta=Math.min(.25,interval/1000);lastTime=now;
    if (document.hidden||contextLost) return;
    occlusion.beginFrame(now,options.occlusion!==false);
    const moved=mode === 'orbit' ? controls.update(delta) : updateWalking(delta);
    const interacting = moved || (lookPointer !== null && now-lastInput<180);
    if (manifest && (now-lastSchedule>250) && (moved||dirty||activeLoads>0||lastSchedule===0||occlusion.needsUpdate(now))) {schedule(now);lastSchedule=now;}
    if (dirty||moved||benchmark.running) {
      if (benchmark.running) requestRender(false);
      updateSun();renderer.toneMappingExposure=options.exposure*(manifest?.environment?manifest.environment.exposure/daylight.exposure:1);
      try{renderer.info.reset();backend.render(delta);}catch(cause){
        console.warn('3D rendering interrupted',cause);contextLost=true;clearMovement();
        error='3D表示が中断されました。「再試行」をお試しください';report(now);return;
      }
      // Count animation frame intervals during camera movement. CPU submission
      // duration alone is not browser frame rate, and idle gaps are not frames.
      if ((interacting || benchmark.running) && wasRendering && interval>0) {renderTime+=interval;renderedFrames++;lastMeasured=now;}
      if (renderedFrames>=20) {meanFrame=renderTime/renderedFrames;renderedFrames=0;renderTime=0;}
      const result=benchmark.sample(now);
      if(result && benchmarkConfig) {
        benchmarkResults=[{...benchmarkConfig,...result},...benchmarkResults].slice(0,6);benchmarkConfig=null;
        benchmarkMessage='計測が完了しました';
      }
      dirty=false;
      wasRendering=true;
    } else wasRendering=false;
    if (now-lastStatus>400) {report(now);lastStatus=now;}
  }
  if(!(renderer instanceof THREE.WebGLRenderer)){renderer.onDeviceLost=()=>{contextLost=true;clearMovement();error='GPUとの接続が切れました。再試行でWebGL2に戻します';report(performance.now());};}
  try{resize();void loadManifest();frameId=requestAnimationFrame(frame);}catch(cause){destroy();throw cause;}
  function reviewView(id:string){
    const view=[...reviewViews,...pilotViews].find(v=>v.id===id);if(!view)return;
    setView(view.position as [number,number,number],view.target as [number,number,number]);
  }
  function setView(position:[number,number,number],target:[number,number,number]){
    void setMode('orbit');camera.fov=42;camera.updateProjectionMatrix();
    void controls.setLookAt(...position,...target,false);
    lastSchedule=0;requestRender();
  }
  return {
    home,top,north,zoom,setMode,goTo,startBenchmark,stopBenchmark,goToChunk,recover,shareView,lockPointer,pause:clearMovement,reviewView,setView,
    jump(){if(mode==='walk'&&!transition.pending)ground?.jump();},
    move(x,forward,up=0) { if(!transition.pending)moveInput.set(THREE.MathUtils.clamp(x,-1,1),THREE.MathUtils.clamp(forward,-1,1),THREE.MathUtils.clamp(up,-1,1)); },
    setOptions(next) {
      if (options.quality!==next.quality || options.shadows!==next.shadows || options.trees!==next.trees || options.exposure!==next.exposure || options.lightmaps!==next.lightmaps) stopBenchmark('表示設定が変わったため計測を中止しました');
      const qualityChanged=options.quality!==next.quality;options={...next};
      for(const material of materialCache.values())setBakedDaylightEnabled(material,options.lightmaps!==false);
      if (qualityChanged) for(const tile of tiles)tile.failures.clear();
      resize();treeGroup.visible=options.trees!=='off';lastSchedule=0;requestRender();
    },
    retry() { if(contextLost){restart();return;} if(groundFailed)void loadGround();ground?.retry();transition.retry(); if (manifestFailed) void loadManifest();else {error='';for (const tile of tiles) tile.failures.clear();treeMode='off';treeFailed=false;lastSchedule=0;requestRender();} },
    destroy,
  };
  function destroy() {
      if(destroyed)return;
      destroyed=true;window.clearInterval(updateTimer);transition.cancel();abort.abort();if(document.pointerLockElement===canvas)document.exitPointerLock();cancelAnimationFrame(frameId);observer.disconnect();controls.dispose();
      canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerUp);canvas.removeEventListener('dblclick',doubleClick);canvas.removeEventListener('contextmenu',contextMenu);canvas.removeEventListener('wheel',input);canvas.removeEventListener('webglcontextlost',lost);window.removeEventListener('keydown',key);
      canvas.removeEventListener('pointermove',pointerMove);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',clearMovement);document.removeEventListener('visibilitychange',visibility);clearMovement();
      document.removeEventListener('mousemove',lockedLook);canvas.removeEventListener('lostpointercapture',lostCapture);
      document.removeEventListener('pointerlockchange',lockChanged);
      disposeObject(group);disposeObject(treeGroup);
      for (const material of materialCache.values()) material.dispose();for (const texture of keptTextures) texture.dispose();
      materialCache.clear();materialRefs.clear();materialKeys.clear();textureRefs.clear();keptTextures.clear();
      sharedTextures.clear();sharedTextureKeys.clear();
      savedEnvironmentTarget?.dispose();savedEnvironmentTexture?.dispose();savedDiffuseFill?.removeFromParent();
      ground?.dispose();occlusion.dispose();ktx.dispose();sun.shadow.dispose();sky.dispose();backend.dispose();canvas.remove();
    }
}
