import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { BenchmarkResult, Chunk, Manifest, Trees, NavigationMode, QualityLevel, ViewerAPI, ViewerOptions, ViewerStatus } from './types';
import { AdaptiveQuality, GroundField, WalkMesh, type GroundData, type WalkMeshData } from './navigation';
import type { WalkPlace } from './types';
import { FrameBenchmark, QUALITY_PROFILES, renderSize, type FrameSummary } from './quality';

CameraControls.install({ THREE });
type Level = 'full' | 'coarse';
type Resident = { object: THREE.Group; bytes: number; lastUsed: number };
type Tile = { spec: Chunk; box: THREE.Box3; sphere: THREE.Sphere; full?: Resident; coarse?: Resident; desired: Level | null; loading: Set<Level>; failures: Set<Level> };
const toBox = (bounds: Manifest['bounds']) => new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));

/** Camera controls and physically based glTF display; no procedural campus model. */
export async function createViewer(host: HTMLElement, initial: ViewerOptions, notify: (status: ViewerStatus) => void): Promise<ViewerAPI> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce5ec');
  scene.fog = new THREE.Fog('#dce5ec', 1500, 4200);
  const camera = new THREE.PerspectiveCamera(42, 1, .035, 6000);
  camera.position.set(300, 340, 430);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
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

  const environment = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromScene(environment, .035);
  scene.environment = environmentTarget.texture;
  scene.environmentIntensity = .65;
  environment.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xd8e9ff, 0x8a8878, .65));
  const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.normalBias = .025; sun.shadow.bias = -.00008;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 1700;
  scene.add(sun, sun.target);

  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.blendIntensity = .48;
  ao.updateGtaoMaterial({ radius: 1.7, thickness: 1.2, distanceFallOff: 1, scale: .65, samples: 8, screenSpaceRadius: false });
  ao.updatePdMaterial({ samples: 8, radius: 4 });
  composer.addPass(ao);
  const output = new OutputPass(); composer.addPass(output);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const abort = new AbortController();
  const group = new THREE.Group(); scene.add(group);
  const treeGroup = new THREE.Group(); scene.add(treeGroup);
  const materialCache = new Map<string, THREE.Material>();
  const materialRefs = new Map<THREE.Material, number>();
  const materialKeys = new Map<THREE.Material, string>();
  const textureRefs = new Map<THREE.Texture, number>();
  const keptTextures = new Set<THREE.Texture>();
  const adaptive = new AdaptiveQuality();
  const benchmark = new FrameBenchmark();
  let benchmarkConfig: Omit<BenchmarkResult, keyof FrameSummary> | null = null;
  let benchmarkResults: BenchmarkResult[] = [], benchmarkMessage = '', benchmarkSequence = 0;
  let residentMiB = 0, wasRendering = false, lastMeasured = 0;
  let appliedQuality: QualityLevel | null = null;
  const drawingSize = new THREE.Vector2();
  let options = { ...initial };
  let mode: NavigationMode = 'orbit', ground: GroundField | WalkMesh | null = null;
  let walkGroundHeight=0;
  let yaw = 0, pitch = 0, groundNotice = '';
  const held = new Set<string>();
  const moveInput = new THREE.Vector3();
  const walkPosition = new THREE.Vector3(), walkDirection = new THREE.Vector3();
  const eyeHeight = 1.65;
  let lookPointer: number | null = null, lookX = 0, lookY = 0;
  let lastAdaptive = 0;
  let manifest: Manifest | null = null;
  let tiles: Tile[] = [];
  let destroyed = false, dirty = true, loadingManifest = false;
  let activeLoads = 0, frameId = 0, lastTime = performance.now(), lastSchedule = 0, lastStatus = 0, lastInput = 0;
  let error = '', manifestFailed = false;
  let renderedFrames = 0, renderTime = 0, meanFrame = 0;
  let treeMode: Trees = 'off', treeLoading = false, treeFailed = false;
  const treeVariants: Partial<Record<'detailed' | 'light', THREE.InstancedMesh[]>> = {};
  const treeSpheres: THREE.Sphere[] = [];
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4(), focus = new THREE.Vector3(), temp = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const activePointers = new Set<number>();
  let down = { x: 0, y: 0, time: 0 }, lastTap = { x: 0, y: 0, time: 0 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const quality = (): QualityLevel => options.quality === 'auto' ? adaptive.level : options.quality;

  function requestRender(shadow = true) { dirty = true; if (shadow) renderer.shadowMap.needsUpdate = true; }
  const materialTextures = (material: THREE.Material) => Object.values(material).filter((value): value is THREE.Texture => value instanceof THREE.Texture);
  function prepareMaterials(object: THREE.Object3D, namespace = '') {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const list = Array.isArray(child.material) ? child.material : [child.material];
      const canonical = list.map((material) => {
        const key = `${namespace}|${material.name || material.uuid}`;
        const previous = materialCache.get(key);
        if (previous) {
          if (previous !== material) {
            for (const texture of materialTextures(material)) if (!keptTextures.has(texture)) texture.dispose();
            material.dispose();
          }
          return previous;
        }
        for (const texture of materialTextures(material)) { texture.anisotropy = Math.min(QUALITY_PROFILES[quality()].anisotropy, renderer.capabilities.getMaxAnisotropy()); keptTextures.add(texture); }
        for (const texture of new Set(materialTextures(material))) textureRefs.set(texture, (textureRefs.get(texture) ?? 0) + 1);
        materialCache.set(key, material);
        materialKeys.set(material, key);
        return material;
      });
      for (const material of canonical) materialRefs.set(material, (materialRefs.get(material) ?? 0) + 1);
      child.material = Array.isArray(child.material) ? canonical : canonical[0];
      child.userData.webMaterialsReady = true;
      child.castShadow = !canonical.some((m) => (m instanceof THREE.MeshPhysicalMaterial && m.transmission > .1) || m.transparent);
      child.receiveShadow = true;
      child.frustumCulled = true;
      child.geometry.computeBoundingSphere();
      child.matrixAutoUpdate = false;
      child.updateMatrix();
    });
    object.updateMatrixWorld(true);
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
            else { textureRefs.delete(texture); keptTextures.delete(texture); texture.dispose(); }
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
      const source = texture.image as { width?: number; height?: number } | undefined;
      if (source?.width && source.height) total += source.width * source.height * 4 * (texture.generateMipmaps ? 4/3 : 1);
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
    if (tile.loading.has(level) || tile.failures.has(level) || tile[level]) return;
    const asset = level === 'coarse' ? tile.spec.coarse : tile.spec.full;
    if (!asset) return;
    tile.loading.add(level); activeLoads++;
    try {
      const gltf = await loader.loadAsync(asset.url);
      if (destroyed) { disposeObject(gltf.scene, true); return; }
      prepareMaterials(gltf.scene, level);
      gltf.scene.visible = false;
      group.add(gltf.scene);
      tile[level] = { object: gltf.scene, bytes: geometryBytes(gltf.scene), lastUsed: performance.now() };
      requestRender();
    } catch {
      if (!destroyed) { tile.failures.add(level); error = '一部のモデルを読み込めませんでした'; }
    } finally { tile.loading.delete(level); activeLoads--; lastSchedule = 0; }
  }

  async function loadTrees() {
    if (!manifest?.trees || treeLoading || treeFailed || options.trees === 'off') return;
    const mode = options.trees;
    treeLoading = true;
    try {
      // Both levels are available for detailed trees; distant trees stay light.
      for (const level of (mode === 'detailed' ? ['light', 'detailed'] : ['light']) as ('light' | 'detailed')[]) {
        if (treeVariants[level]) continue;
        const gltf = await loader.loadAsync(manifest.trees[level].url);
        if (destroyed) { disposeObject(gltf.scene, true); return; }
        prepareMaterials(gltf.scene, `trees-${level}`);
        const meshes: THREE.InstancedMesh[] = [];
        const transforms = manifest.trees.transforms;
        gltf.scene.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const instanced = new THREE.InstancedMesh(child.geometry, child.material, transforms.length);
          instanced.userData.localMatrix = child.matrixWorld.clone();
          instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          instanced.castShadow = true; instanced.receiveShadow = true;
          // Individual instances are culled and compacted below, including a
          // margin for shadows, rather than relying on one campus-wide bound.
          instanced.frustumCulled = false;
          instanced.count = 0; treeGroup.add(instanced); meshes.push(instanced);
        });
        treeVariants[level] = meshes;
        if (!treeSpheres.length) {
          const box = new THREE.Box3().setFromObject(gltf.scene);
          for (const transform of transforms) treeSpheres.push(box.clone().applyMatrix4(new THREE.Matrix4().fromArray(transform)).getBoundingSphere(new THREE.Sphere()));
        }
      }
      treeMode = mode; requestRender();
    } catch { treeFailed = true; error = '樹木を読み込めませんでした'; }
    finally { treeLoading = false; lastSchedule = 0; requestRender(); }
  }
  function updateTrees() {
    treeGroup.visible = options.trees !== 'off';
    if (!manifest?.trees || !treeGroup.visible) return;
    const matrices = { light: [] as THREE.Matrix4[], detailed: [] as THREE.Matrix4[] };
    for (const [i, transform] of manifest.trees.transforms.entries()) {
      const sphere = treeSpheres[i]; if (!sphere) continue;
      const distance = camera.position.distanceTo(sphere.center);
      const margin = sphere.clone(); margin.radius += 18;
      if (distance > 1000 || (!frustum.intersectsSphere(margin) && distance > controls.distance + 100)) continue;
      const level = options.trees === 'detailed' && distance < 160 && treeVariants.detailed ? 'detailed' : 'light';
      matrices[level].push(new THREE.Matrix4().fromArray(transform));
    }
    for (const level of ['light', 'detailed'] as const) for (const mesh of treeVariants[level] ?? []) {
      mesh.count = matrices[level].length;
      for (const [i, matrix] of matrices[level].entries()) mesh.setMatrixAt(i, matrix.clone().multiply(mesh.userData.localMatrix));
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function schedule(now: number) {
    if (!manifest) return;
    const profile = QUALITY_PROFILES[quality()];
    camera.updateMatrixWorld(); projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(projection);
    const queue: { tile: Tile; level: Level; score: number }[] = [];
    let memory = textureBytes();
    for (const tile of tiles) {
      const distance = Math.max(0, camera.position.distanceTo(tile.sphere.center) - tile.sphere.radius);
      const visible = frustum.intersectsBox(tile.box);
      const isInterior = tile.spec.kind === 'interior';
      const near = distance < (mode === 'orbit' ? 100 : 48);
      const relevant = tile.spec.kind === 'context' || isInterior ? false : (visible && distance < (mode === 'orbit' ? 1800 : 550)) || near;
      const pixels = tile.sphere.radius * host.clientHeight / Math.max(1, camera.position.distanceTo(tile.sphere.center) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const full = profile.allFull || distance < profile.fullDistance * (mode === 'orbit' ? 1.5 : 1) || pixels > profile.fullPixels;
      tile.desired = relevant ? (full || !tile.spec.coarse ? 'full' : 'coarse') : null;
      const desired = tile.desired;
      const active = desired ? (tile[desired] ?? tile.full ?? tile.coarse) : null;
      for (const level of ['full', 'coarse'] as const) {
        const resident = tile[level]; if (!resident) continue;
        resident.object.visible = resident === active;
        if (resident === active) resident.lastUsed = now;
        memory += resident.bytes;
      }
      if (desired && !tile[desired]) {
        // A small coarse mesh fills the view while the complete mesh is fetched.
        if (desired === 'full' && tile.spec.coarse && !tile.coarse && !tile.full) queue.push({ tile, level: 'coarse', score: distance - 250 + (isInterior ? 300 : 0) });
        queue.push({ tile, level: desired, score: distance + (isInterior ? 300 : 0) - (tile.spec.kind === 'terrain' ? 1000 : 0) });
      }
    }
    const budget = profile.memoryMiB * 1024 * 1024;
    if (memory > budget) {
      const unused = tiles.flatMap((tile) => (['full','coarse'] as const).flatMap((level) => tile[level] && !tile[level]!.object.visible ? [{ tile, level, resident: tile[level]! }] : [])).sort((a,b) => a.resident.lastUsed - b.resident.lastUsed);
      for (const entry of unused) {
        if (memory <= budget) break;
        if (now - entry.resident.lastUsed < 1500) continue;
        const beforeTextures = textureBytes();
        disposeObject(entry.resident.object); memory -= entry.resident.bytes + beforeTextures - textureBytes(); delete entry.tile[entry.level];
      }
    }
    queue.sort((a,b) => a.score - b.score);
    for (const item of queue) {
      if (activeLoads >= profile.loads) break;
      void loadTile(item.tile, item.level);
    }
    if (!treeLoading && options.trees !== 'off' && treeMode !== options.trees && activeLoads < 3) void loadTrees();
    updateTrees();
    canvas.dataset.loadedChunks = String(tiles.filter((tile) => tile.full || tile.coarse).length);
    residentMiB = memory / 1024 / 1024;
    canvas.dataset.residentMb = residentMiB.toFixed(1);
    requestRender();
  }

  function updateSun() {
    if (mode === 'orbit') controls.getTarget(focus); else focus.copy(camera.position).addScaledVector(camera.getWorldDirection(temp), 22);
    const span = mode === 'orbit' ? THREE.MathUtils.clamp(controls.distance * .72, 18, 480) : 65;
    sun.target.position.copy(focus);
    sun.position.copy(focus).add(temp.set(-.6, 1.2, .8).normalize().multiplyScalar(800));
    const shadow = sun.shadow.camera;
    shadow.left = -span; shadow.right = span; shadow.top = span; shadow.bottom = -span;
    shadow.updateProjectionMatrix(); sun.target.updateMatrixWorld();
  }
  function resize() {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    const q = quality(), profile = QUALITY_PROFILES[q];
    const gl = renderer.getContext();
    const limit = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    const { ratio, width: renderWidth, height: renderHeight } = renderSize(q,width,height,window.devicePixelRatio,limit);
    if (benchmark.running && (drawingSize.x !== renderWidth || drawingSize.y !== renderHeight)) stopBenchmark('画面サイズが変わったため計測を中止しました');
    const samples = Math.min(profile.antialiasSamples, renderer.capabilities.maxSamples);
    for (const buffer of [composer.renderTarget1, composer.renderTarget2]) {
      if (buffer.samples !== samples) { buffer.samples = samples; buffer.dispose(); }
    }
    renderer.setPixelRatio(ratio); renderer.setSize(width, height, false);
    composer.setPixelRatio(ratio); composer.setSize(width, height);
    renderer.getDrawingBufferSize(drawingSize);
    camera.aspect = width / height; camera.updateProjectionMatrix(); requestRender(); lastSchedule = 0;
    renderer.shadowMap.enabled = options.shadows && profile.shadowSize > 0; sun.castShadow = renderer.shadowMap.enabled;
    const mapSize = Math.min(profile.shadowSize || 1024, renderer.capabilities.maxTextureSize);
    if (sun.shadow.mapSize.x !== mapSize) { sun.shadow.mapSize.set(mapSize, mapSize); sun.shadow.dispose(); }
    ao.enabled = profile.aoSamples > 0;
    if (appliedQuality !== q) {
      if (profile.aoSamples) ao.updateGtaoMaterial({samples:profile.aoSamples});
      for (const texture of keptTextures) {
        texture.anisotropy = Math.min(profile.anisotropy,renderer.capabilities.getMaxAnisotropy());texture.needsUpdate = true;
      }
      appliedQuality = q;
      meanFrame = renderTime = renderedFrames = 0; wasRendering = false;
    }
    canvas.dataset.quality=q;canvas.dataset.renderResolution=`${drawingSize.x}x${drawingSize.y}`;
  }
  function startBenchmark() {
    if (!manifest || options.quality === 'auto') { benchmarkMessage = '手動の画質を選んでから計測してください'; return; }
    const profile = QUALITY_PROFILES[quality()];
    benchmarkConfig = { id:++benchmarkSequence, quality:quality(), width:drawingSize.x, height:drawingSize.y,
      shadowSize:renderer.shadowMap.enabled ? sun.shadow.mapSize.x : 0, aoSamples:profile.aoSamples,
      antialiasSamples:composer.renderTarget1.samples, revision:manifest.revision, position:camera.position.toArray() };
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
  function clearMovement() { held.clear(); moveInput.set(0,0,0); lookPointer = null; }
  function setMode(next: NavigationMode) {
    if (next === mode) return;
    if(next==='walk'&&!ground) { groundNotice='歩行用データを読み込んでいます';report(performance.now());return; }
    clearMovement();
    if (next === 'orbit') {
      camera.getWorldDirection(walkDirection);
      const target = camera.position.clone().addScaledVector(walkDirection, 20);
      controls.enabled = true;
      void controls.setLookAt(camera.position.x,camera.position.y,camera.position.z,target.x,target.y,target.z,false);
      camera.fov = 42;
    } else {
      if (mode === 'orbit') {
        camera.getWorldDirection(walkDirection);
        yaw = Math.atan2(-walkDirection.x, -walkDirection.z);
        pitch = Math.asin(THREE.MathUtils.clamp(walkDirection.y, -.9, .9));
        walkPosition.copy(camera.position);
        if (next === 'walk') {
          const target = controls.getTarget(new THREE.Vector3());
          walkPosition.set(target.x, target.y + eyeHeight, target.z);
          const surface = ground?.findNearby(target.x,target.z,target.y);
          if (surface) walkPosition.set(surface.x,surface.height+eyeHeight,surface.z);
          pitch = -.08;
        }
      } else if (next === 'walk') {
        const surface = ground?.sample(walkPosition.x,walkPosition.z,walkPosition.y-eyeHeight);
        if (surface != null) walkPosition.y = surface + eyeHeight;
      }
      controls.enabled = false; camera.fov = 65;
    }
    mode = next;
    if(next==='walk')walkGroundHeight=walkPosition.y-eyeHeight;
    camera.updateProjectionMatrix();
    canvas.dataset.navigationMode = mode;
    if (mode !== 'orbit') applyWalkingCamera();
    lastSchedule = 0; requestRender(); report(performance.now());
  }
  function goTo(place: WalkPlace) {
    if (!manifest||!ground) return;
    let x = -114, z = 172, facingX = -111, facingZ = 120, reference = 18;
    const building = place === 'gate' ? null : tiles.find(tile=>tile.spec.id === `EXT_${place === 'arena' ? 'lions-arena' : place === 'tower' ? 'tower75' : 'library'}`);
    if (building) {
      const center = building.box.getCenter(new THREE.Vector3());
      x = center.x; z = building.box.max.z + 9; facingX = center.x; facingZ = center.z; reference = building.box.min.y;
    }
    // Fixed, checked exterior entry points in the model's calibrated UV axes.
    const places:Partial<Record<WalkPlace,[number,number,number,number,number]>>={
      'east-road':[152,-34,11.39,88,-44],
      sunken:[2,0,25.6368,-5,-5],
      'grand-stair':[59,37,22.85,42,37],
      research:[140.9,-70.6,13.14865,118,-62],
    };
    const selected=places[place];
    if(selected) {
      const [u,v,h,tu,tv]=selected;
      x=.8862035792312147*u+.4632960351198617*v;
      z=.4632960351198617*u-.8862035792312147*v;
      facingX=.8862035792312147*tu+.4632960351198617*tv;
      facingZ=.4632960351198617*tu-.8862035792312147*tv;reference=h;
    }
    setMode('walk');
    const surface=ground?.findNearby(x,z,reference);
    if(surface) { x=surface.x;z=surface.z; }
    walkPosition.set(x, (surface?.height ?? reference) + eyeHeight, z);
    walkGroundHeight=walkPosition.y-eyeHeight;
    yaw = Math.atan2(x-facingX,z-facingZ); pitch = -.05;
    clearMovement(); applyWalkingCamera(); lastSchedule = 0;
  }
  function updateWalking(delta: number) {
    if (mode === 'orbit') return false;
    let x = moveInput.x + Number(held.has('d') || held.has('arrowright')) - Number(held.has('a') || held.has('arrowleft'));
    let forward = moveInput.y + Number(held.has('w') || held.has('arrowup')) - Number(held.has('s') || held.has('arrowdown'));
    const up = mode === 'fly' ? moveInput.z + Number(held.has('e') || held.has(' ')) - Number(held.has('q')) : 0;
    const length = Math.hypot(x,forward); if (length > 1) { x /= length; forward /= length; }
    if (!x && !forward && !up) return false;
    const speed = (mode === 'fly' ? 9 : 3.2) * (held.has('shift') ? 2.6 : 1);
    const dx=(Math.cos(yaw)*x - Math.sin(yaw)*forward)*speed*delta;
    const dz=(-Math.sin(yaw)*x - Math.cos(yaw)*forward)*speed*delta;
    if (mode === 'fly') {
      walkPosition.x+=dx;walkPosition.z+=dz;
      walkPosition.y += (up + Math.sin(pitch)*forward)*speed*delta;
    } else if(ground) {
      if(ground instanceof WalkMesh) {
        const next=ground.advance(walkPosition.x,walkPosition.z,walkGroundHeight,dx,dz);
        walkPosition.x=next.x;walkPosition.z=next.z;walkGroundHeight=next.height;
      } else {
        const surface=ground.sample(walkPosition.x+dx,walkPosition.z+dz,walkGroundHeight);
        if(surface!==null&&Math.abs(surface-walkGroundHeight)<.65) {
          walkPosition.x+=dx;walkPosition.z+=dz;walkGroundHeight=surface;
        }
      }
      walkPosition.y=Math.max(walkGroundHeight+1.2,THREE.MathUtils.lerp(walkPosition.y,walkGroundHeight+eyeHeight,1-Math.exp(-delta*20)));
    }
    if (manifest) {
      walkPosition.x = THREE.MathUtils.clamp(walkPosition.x,manifest.bounds[0][0]-65,manifest.bounds[1][0]+65);
      walkPosition.z = THREE.MathUtils.clamp(walkPosition.z,manifest.bounds[0][2]-65,manifest.bounds[1][2]+65);
    }
    walkPosition.y = THREE.MathUtils.clamp(walkPosition.y,-10,240);
    applyWalkingCamera(); return true;
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
    if (mode !== 'orbit') {
      camera.getWorldDirection(walkDirection);
      if(mode==='walk'&&ground instanceof WalkMesh) {
        const point=ground.advance(walkPosition.x,walkPosition.z,walkGroundHeight,walkDirection.x*direction*2,walkDirection.z*direction*2);
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
    const code = event.key.toLowerCase();
    if (code === 'escape') { clearMovement(); return; }
    if (mode !== 'orbit' && ['w','a','s','d','arrowleft','arrowright','arrowup','arrowdown','q','e',' ','shift'].includes(code)) {
      if (event.target instanceof HTMLButtonElement && (code === ' ' || code === 'enter')) return;
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
    if (mode === 'orbit' || event.pointerId !== lookPointer) return;
    yaw -= (event.clientX-lookX)*.004;
    pitch = THREE.MathUtils.clamp(pitch-(event.clientY-lookY)*.004,-Math.PI*.46,Math.PI*.46);
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
  const doubleClick=(event:MouseEvent)=>focusAt(event.clientX,event.clientY);
  const contextMenu=(event:Event)=>event.preventDefault();
  const input=()=>{lastInput=performance.now();};
  const keyUp=(event:KeyboardEvent)=>held.delete(event.key.toLowerCase());
  const visibility=()=>{if(document.hidden) { clearMovement();wasRendering=false;stopBenchmark('ページが非表示になったため計測を中止しました'); }};
  const restored=()=>{requestRender();resize();};
  const lost=(event:Event)=>{event.preventDefault();stopBenchmark('3D表示が中断されたため計測を中止しました');error='3D表示が中断されました。再読み込みしてください';};
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);
  canvas.addEventListener('pointermove',pointerMove);
  canvas.addEventListener('dblclick',doubleClick);canvas.addEventListener('contextmenu',contextMenu);canvas.addEventListener('wheel',input,{passive:true});
  canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',restored);
  window.addEventListener('keydown',key); window.addEventListener('keyup',keyUp); window.addEventListener('blur',clearMovement); document.addEventListener('visibilitychange',visibility); controls.addEventListener('update',()=>requestRender());
  const observer=new ResizeObserver(resize);observer.observe(host);

  async function loadManifest() {
    if (loadingManifest || destroyed) return;
    loadingManifest=true;error='';manifestFailed=false;
    try {
      const response=await fetch('/viewer/current.json',{cache:'no-store',signal:abort.signal});
      if (!response.ok) throw new Error('Manifest unavailable');
      const next:Manifest=await response.json();
      if (next.schema!=='tempaku-viewer-1' || !next.chunks.length) throw new Error('Invalid model manifest');
      if (destroyed) return;
      manifest=next;
      tiles=next.chunks.map((spec)=>{const box=toBox(spec.bounds);return {spec,box,sphere:box.getBoundingSphere(new THREE.Sphere()),desired:null,loading:new Set(),failures:new Set()};});
      canvas.dataset.modelRevision=next.revision;canvas.dataset.modelRelease=next.release;
      controls.setBoundary(toBox(next.bounds).expandByScalar(1000));
      home();lastSchedule=0;requestRender();
      if (next.navigation) {
        try {
          const response = await fetch(next.navigation.url,{signal:abort.signal});
          if (!response.ok) throw new Error('Ground field unavailable');
          const bytes=new Uint8Array(await response.arrayBuffer());
          const compressed=bytes[0]===31&&bytes[1]===139;
          const text=compressed
            ?await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
            :new TextDecoder().decode(bytes);
          const data:GroundData|WalkMeshData=JSON.parse(text);
          if (destroyed) return;
          ground = data.schema==='tempaku-walk-2'?new WalkMesh(data):new GroundField(data); groundNotice = '';
          goTo(data.schema==='tempaku-walk-2'?'east-road':'gate');
        } catch { if (!destroyed) groundNotice = '地面データを読み込めません。自由移動で確認できます'; }
      }
    } catch { if (!destroyed) {manifestFailed=true;error='モデルを読み込めませんでした';} }
    finally {loadingManifest=false;}
  }
  function report(now:number) {
    const loaded=tiles.filter((tile)=>tile.full||tile.coarse).length;
    const wanted=tiles.filter((tile)=>tile.desired).length;
    const pending=tiles.filter((tile)=>tile.desired&&!tile[tile.desired]).length;
    const phase=error?'error':(!manifest||!loaded?'loading':'ready');
    let message=error||groundNotice||(!manifest?'モデルを読み込んでいます':pending?`周辺を読み込み中 · ${Math.max(0,wanted-pending)} / ${wanted}`:'表示中');
    if (!error && !pending && meanFrame>42 && options.trees!=='off' && now-lastInput<2500) message='樹木を「なし」にすると動作が軽くなります';
    notify({phase,message,loaded,total:tiles.length,revision:manifest?.revision??'',azimuth:mode === 'orbit' ? controls.azimuthAngle : yaw,distance:controls.distance,fps:meanFrame && now-lastMeasured<900 ? 1000/meanFrame:0,mode,effectiveQuality:quality(),groundReady:!!ground,treesAvailable:!!manifest?.trees,
      renderWidth:drawingSize.x,renderHeight:drawingSize.y,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,residentMiB,
      benchmarking:benchmark.running,benchmarkRemaining:Math.max(0,Math.ceil((benchmark.durationMs-benchmark.elapsed)/1000)),benchmarkResults,benchmarkMessage});
    canvas.dataset.frameMs=meanFrame.toFixed(2);canvas.dataset.drawCalls=String(renderer.info.render.calls);canvas.dataset.renderedTriangles=String(renderer.info.render.triangles);
    canvas.dataset.camera=JSON.stringify({position:camera.position.toArray(),target:controls.getTarget(new THREE.Vector3()).toArray()});
  }
  function frame(now:number) {
    if (destroyed) return;
    frameId=requestAnimationFrame(frame);
    const interval=now-lastTime;const delta=Math.min(.05,interval/1000);lastTime=now;
    if (document.hidden) return;
    const moved=mode === 'orbit' ? controls.update(delta) : updateWalking(delta);
    const interacting = moved || (lookPointer !== null && now-lastInput<180);
    if (manifest && (now-lastSchedule>250) && (moved||dirty||activeLoads>0||lastSchedule===0)) {schedule(now);lastSchedule=now;}
    if (dirty||moved||benchmark.running) {
      if (benchmark.running) renderer.shadowMap.needsUpdate=true;
      updateSun();renderer.toneMappingExposure=options.exposure;
      renderer.info.reset();composer.render(delta);
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
    if (options.quality==='auto' && interacting && meanFrame && now-lastAdaptive>400) {
      if (adaptive.update(meanFrame,Math.min(1,(now-lastAdaptive)/1000))) resize();
      lastAdaptive=now;
    } else if (!interacting) { adaptive.reset(); lastAdaptive=now; }
    if (now-lastStatus>400) {report(now);lastStatus=now;}
  }
  resize();void loadManifest();frameId=requestAnimationFrame(frame);
  return {
    home,top,north,zoom,setMode,goTo,startBenchmark,stopBenchmark,
    move(x,forward,up=0) { moveInput.set(THREE.MathUtils.clamp(x,-1,1),THREE.MathUtils.clamp(forward,-1,1),THREE.MathUtils.clamp(up,-1,1)); },
    setOptions(next) {
      if (options.quality!==next.quality || options.shadows!==next.shadows || options.trees!==next.trees || options.exposure!==next.exposure) stopBenchmark('表示設定が変わったため計測を中止しました');
      const qualityChanged=options.quality!==next.quality;options={...next};
      if (qualityChanged) adaptive.reset();
      resize();treeGroup.visible=options.trees!=='off';lastSchedule=0;requestRender();
    },
    retry() { if (manifestFailed) void loadManifest();else {error='';for (const tile of tiles) tile.failures.clear();treeMode='off';treeFailed=false;lastSchedule=0;requestRender();} },
    destroy() {
      destroyed=true;abort.abort();cancelAnimationFrame(frameId);observer.disconnect();controls.dispose();
      canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerUp);canvas.removeEventListener('dblclick',doubleClick);canvas.removeEventListener('contextmenu',contextMenu);canvas.removeEventListener('wheel',input);canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored);window.removeEventListener('keydown',key);
      canvas.removeEventListener('pointermove',pointerMove);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',clearMovement);document.removeEventListener('visibilitychange',visibility);clearMovement();
      disposeObject(group);disposeObject(treeGroup);
      for (const material of materialCache.values()) material.dispose();for (const texture of keptTextures) texture.dispose();
      materialCache.clear();materialRefs.clear();materialKeys.clear();textureRefs.clear();keptTextures.clear();
      ao.dispose();output.dispose();composer.dispose();environmentTarget.dispose();sun.shadow.dispose();renderer.dispose();canvas.remove();
    },
  };
}
