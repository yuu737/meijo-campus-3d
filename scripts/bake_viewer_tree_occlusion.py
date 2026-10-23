"""Bake front/back self visibility on a derived tree; read only the input GLB."""
import bpy, json, sys, time
from pathlib import Path

args = sys.argv[sys.argv.index('--') + 1:]
def argument(name): return args[args.index(name) + 1]
source, destination = Path(argument('--input')), Path(argument('--output'))
destination.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 256
scene.cycles.use_denoising = False
scene.render.threads_mode = 'FIXED'
scene.render.threads = 4
bpy.ops.import_scene.gltf(filepath=str(source))
objects = [o for o in scene.objects if o.type == 'MESH']
assert objects, 'Missing tree mesh'
scene.world = bpy.data.worlds.new('Tree visibility world')
scene.world.use_nodes = True
scene.render.bake.target = 'VERTEX_COLORS'
originals = {}
for obj in objects:
    assert not obj.data.color_attributes, 'Do not overwrite authored vertex colours'
    attribute = obj.data.color_attributes.new(name='TreeSelfVisibility', type='FLOAT_COLOR', domain='CORNER')
    obj.data.color_attributes.active_color = attribute
    originals[obj.name] = list(obj.data.materials)
    for slot, original in enumerate(originals[obj.name]):
        material = original.copy()
        obj.data.materials[slot] = material
        nodes, links = material.node_tree.nodes, material.node_tree.links
        output = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
        surface = output.inputs['Surface'].links[0].from_socket
        geometry = nodes.new('ShaderNodeNewGeometry')
        inverse = nodes.new('ShaderNodeVectorMath')
        inverse.operation = 'SCALE'
        inverse.inputs['Scale'].default_value = -1
        links.new(geometry.outputs['Normal'], inverse.inputs[0])
        channels = nodes.new('ShaderNodeCombineXYZ')
        channels.inputs['Z'].default_value = 1
        for component, normal in (('X', geometry.outputs['Normal']), ('Y', inverse.outputs['Vector'])):
            ao = nodes.new('ShaderNodeAmbientOcclusion')
            ao.inputs['Distance'].default_value = max(obj.dimensions) * 2
            ao.samples = 64
            links.new(normal, ao.inputs['Normal'])
            links.new(ao.outputs['AO'], channels.inputs[component])
        emission = nodes.new('ShaderNodeEmission')
        links.new(channels.outputs['Vector'], emission.inputs['Color'])
        lightpath = nodes.new('ShaderNodeLightPath')
        mix = nodes.new('ShaderNodeMixShader')
        links.new(lightpath.outputs['Is Shadow Ray'], mix.inputs[0])
        links.new(emission.outputs[0], mix.inputs[1])
        links.new(surface, mix.inputs[2])
        links.new(mix.outputs[0], output.inputs['Surface'])
        # Receivers stay opaque during the emission bake; shadow rays retain
        # the source leaf cut-outs. Front/back visibility are separate channels.
bpy.ops.object.select_all(action='DESELECT')
for obj in objects: obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
started = time.perf_counter()
bpy.ops.object.bake(type='EMIT')
for obj in objects:
    for slot, material in enumerate(originals[obj.name]):
        obj.data.materials[slot] = material
bpy.ops.export_scene.gltf(filepath=str(destination), export_format='GLB', use_selection=True,
                          export_extras=True, export_yup=True, export_vertex_color='ACTIVE')
print('TREE_SELF_VISIBILITY', json.dumps({'seconds': time.perf_counter() - started,
      'corners': sum(len(o.data.loops) for o in objects), 'samples': 256, 'aoSamples': 64}), flush=True)
