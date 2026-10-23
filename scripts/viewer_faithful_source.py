"""Source-preserving helpers for the October campus Web export.

These functions run only inside the disposable background Blender process.
"""
import bpy
import collections
import numpy as np
from mathutils import Matrix

LIGHT_TREE_SOURCES = {'QUALITY7_DenseBroadleafTree', 'ARENA_V5_PH_jacaranda_tree',
                      'ARENA_V5_PH_island_tree_01', 'ARENA_V4_PH_tree_small_02_LOD1'}

def memberships():
    result = collections.defaultdict(list)
    for collection in bpy.data.collections:
        for obj in collection.objects:
            result[obj.name].append(collection)
    return result

def lightweight_tree(obj):
    return obj.get('treeLighteningOriginalMesh') in LIGHT_TREE_SOURCES

def vegetation(obj):
    return bool(obj.get('treeLighteningRevision') or obj.get('webGeneratedGrass') or
                (obj.get('assetSource') == 'https://polyhaven.com/a/shrub_04' and obj.get('assetLicense') == 'CC0-1.0'))

def materialize_grass(scene, depsgraph, visible_names, membership):
    roots = {o.name for o in scene.objects if not o.hide_render and
             any(c.name in visible_names for c in membership[o.name]) and
             any(m.type == 'NODES' for m in o.modifiers) and
             ('grass' in o.name.lower() or 'lawn' in o.name.lower())}
    # The saved editor deliberately hides expensive grass in the viewport.
    # The export evaluates render-visible roots in this disposable process.
    for name in roots:
        obj=scene.objects[name]
        obj.hide_viewport=False;obj.hide_set(False)
        for collection in membership[name]:collection.hide_viewport=False
        for modifier in obj.modifiers:
            if modifier.show_render:modifier.show_viewport=True
    bpy.context.view_layer.update();depsgraph.update()
    instances = [];prototypes={}
    for entry in depsgraph.object_instances:
        if not entry.is_instance or not entry.parent or entry.parent.original.name not in roots:
            continue
        source = entry.object
        if source.type == 'MESH' and len(source.data.polygons):
            # Geometry Nodes' evaluated instance object can report the point
            # cloud as .original. Its evaluated mesh is the actual tuft.
            key=source.data.as_pointer()
            if key not in prototypes:
                prototypes[key]=source.data.copy()
            instances.append((prototypes[key], entry.matrix_world.copy()))
    if roots and not instances:
        raise RuntimeError('Visible procedural grass produced no exported instances')
    if not instances:
        return []
    collection = bpy.data.collections.new('WEB_GENERATED_GRASS')
    scene.collection.children.link(collection)
    visible_names.add(collection.name)
    output = []
    for index, (mesh, matrix) in enumerate(instances):
        obj = bpy.data.objects.new(f'WebGrass_{index:05d}', mesh)
        collection.objects.link(obj)
        obj.matrix_world = matrix
        obj['webGeneratedGrass'] = True
        membership[obj.name] = [collection]
        output.append(obj)
    print('GRASS_INSTANCES_READY',len(output),flush=True)
    return output

def positions(mesh):
    data = np.empty(len(mesh.vertices)*3, dtype=np.float32)
    mesh.vertices.foreach_get('co', data)
    return data.reshape(-1,3).astype(np.float64)

def tree_local_transforms(trees):
    """Prove the four lightweight tree meshes differ only by affine scaling.

    Retains the model's local root, size and per-object placement while sharing
    one portable mesh. Fails rather than substituting a different tree shape.
    """
    base = trees[0].data
    vertices = positions(base)
    minimum = vertices.min(0)
    span = np.ptp(vertices,axis=0)
    if np.any(span <= 0):
        raise RuntimeError('Degenerate tree prototype')
    loops = np.empty(len(base.loops),dtype=np.int32)
    base.loops.foreach_get('vertex_index',loops)
    result = {base.name:Matrix.Identity(4)}
    for tree in trees:
        mesh = tree.data
        if mesh.name in result:
            continue
        if len(mesh.vertices)!=len(base.vertices) or len(mesh.loops)!=len(base.loops):
            raise RuntimeError('Tree prototype topology differs: '+mesh.name)
        indices=np.empty(len(mesh.loops),dtype=np.int32)
        mesh.loops.foreach_get('vertex_index',indices)
        if not np.array_equal(indices,loops) or list(mesh.materials)!=list(base.materials):
            raise RuntimeError('Tree prototype connectivity/materials differ: '+mesh.name)
        actual=positions(mesh)
        scale=np.ptp(actual,axis=0)/span
        offset=actual.min(0)-minimum*scale
        error=float(np.abs(vertices*scale+offset-actual).max())
        if error>1e-5:
            raise RuntimeError(f'Tree shape cannot be shared losslessly within 0.01 mm: {mesh.name} {error}')
        matrix=Matrix.Diagonal((*scale,1.0))
        matrix.translation=offset
        result[mesh.name]=matrix
    return result
