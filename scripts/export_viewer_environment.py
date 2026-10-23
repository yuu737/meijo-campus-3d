"""Render the saved Blender World into an immutable linear HDR environment."""
import bpy
import hashlib
import json
import math
import os
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/os.environ.get('VIEWER_WORKSPACE','outputs/viewer')
reference_file=WORK/'export/lighting-reference.json'
if not reference_file.exists():reference_file=WORK/'export/source-manifest.json'
source=json.loads(reference_file.read_text(encoding='utf-8'))
reference=source['renderReference']
lighting=ROOT/reference['raw']
assert hashlib.sha256(lighting.read_bytes()).hexdigest()==reference['sha256']
bpy.ops.wm.read_factory_settings(use_empty=True)
with bpy.data.libraries.load(str(lighting),link=False) as (src,dst):
    dst.worlds=[reference['world']]
scene=bpy.context.scene
scene.world=dst.worlds[0]
scene.render.engine='CYCLES'
scene.cycles.samples=8
scene.cycles.use_denoising=False
scene.render.threads_mode='FIXED';scene.render.threads=4
camera_data=bpy.data.cameras.new('WebEnvironmentCamera')
camera_data.type='PANO';camera_data.panorama_type='EQUIRECTANGULAR'
camera=bpy.data.objects.new(camera_data.name,camera_data)
scene.collection.objects.link(camera);scene.camera=camera
# Image centre is Web +X, image right is Web +Z, image top is Web +Y.
camera.rotation_euler=(math.pi/2,0,-math.pi/2)
scene.render.resolution_x=4096;scene.render.resolution_y=2048
scene.render.resolution_percentage=100
scene.render.film_transparent=False
scene.render.use_compositing=False
scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
scene.view_settings.exposure=0;scene.view_settings.gamma=1
scene.render.image_settings.file_format='HDR'
output=WORK/'environment';output.mkdir(parents=True,exist_ok=True)
rendered=output/'saved-world.hdr'
scene.render.filepath=str(rendered)
bpy.ops.render.render(write_still=True)
payload=rendered.read_bytes();sha=hashlib.sha256(payload).hexdigest()
asset=ROOT/'web-public/viewer/assets'/f'{sha}.hdr'
if not asset.exists():asset.write_bytes(payload)
# The authored World adds this constant light only to diffuse rays. Keep it
# separate from reflections and the visible sky, just as the saved shader does.
fill=scene.world.node_tree.nodes.get('QUALITY_ShadedCourtyardSkyFill')
diffuse=[float(v)*float(fill.inputs['Strength'].default_value) for v in fill.inputs['Color'].default_value[:3]] if fill else [0,0,0]
record={'schema':'tempaku-environment-1','sourceModelSha256':source['source']['sha256'],
        'lightingSignature':reference['signature'],'world':reference['world'],
        'image':{'url':f'/viewer/assets/{sha}.hdr','sha256':sha,'bytes':len(payload)},
        'resolution':[4096,2048],'exposure':2**reference['exposure'],
        'viewTransform':reference['viewTransform'],'look':reference['look'],
        'diffuseFill':diffuse,'sunIntensity':0,'savedLightCount':len(reference['lights'])}
(WORK/'environment.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
print('SAVED_ENVIRONMENT_READY',json.dumps(record,ensure_ascii=False),flush=True)
