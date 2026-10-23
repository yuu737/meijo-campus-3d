"""Portable thin-pane glass plus exact saved shaders for Cycles light baking."""
import bpy, math

GLASS_SUFFIX='_WebThinGlass'

def authored_thin_glass(material):
    return bool(material and (material.get('glassModel')=='Single thin pane; Fresnel reflection, neutral transmitted daylight, no opaque diffuse lobe.' or material.name=='NorthEntryV3_Skylight'))

def glass_recipe(material):
    assert authored_thin_glass(material),material.name
    nodes=material.node_tree.nodes
    if material.name=='NorthEntryV3_Skylight':
        output=next(n for n in nodes if n.type=='OUTPUT_MATERIAL' and n.is_active_output)
        lobes=[]
        def visit(node,weight):
            if node.type=='MIX_SHADER':
                assert not node.inputs[0].is_linked,'Varying translucent mixture requires a texture bake'
                factor=float(node.inputs[0].default_value)
                visit(node.inputs[1].links[0].from_node,weight*(1-factor));visit(node.inputs[2].links[0].from_node,weight*factor)
            else:
                assert node.type in ('BSDF_TRANSPARENT','BSDF_TRANSLUCENT','BSDF_PRINCIPLED'),node.type
                color=node.inputs['Base Color' if node.type=='BSDF_PRINCIPLED' else 'Color']
                assert not color.is_linked
                lobes.append((node,weight,list(color.default_value)))
        visit(output.inputs['Surface'].links[0].from_node,1)
        shader,opaque,_=next(lobe for lobe in lobes if lobe[0].type=='BSDF_PRINCIPLED')
        transmission=sum(w for n,w,c in lobes if n.type=='BSDF_TRANSPARENT')
        color=[sum(w*c[i] for n,w,c in lobes) for i in range(3)]+[1]
        ior=float(shader.inputs['IOR'].default_value);f0=((ior-1)/(ior+1))**2
        return {'source':material.name,'portable':material.name+GLASS_SUFFIX,'transmissionColor':color,'reflectionColor':[1,1,1,1],
                'roughness':float(shader.inputs['Roughness'].default_value),'f0':f0,'reflectionBoost':1,'effectiveF0':f0*opaque,'ior':ior,
                'transmissionFactor':transmission,'specularIORLevel':float(shader.inputs['Specular IOR Level'].default_value)*opaque,
                'approximation':'constant transparent/translucent mixture represented by PBR transmission',
                'sourceLobes':[{'type':n.type,'weight':w,'color':c} for n,w,c in lobes]}
    transparent=next(n for n in nodes if n.type=='BSDF_TRANSPARENT')
    glossy=next(n for n in nodes if n.type=='BSDF_GLOSSY')
    schlick=next(n for n in nodes if n.type=='MATH' and n.operation=='MULTIPLY_ADD')
    assert all(not s.is_linked for s in [transparent.inputs['Color'],glossy.inputs['Color'],glossy.inputs['Roughness'],schlick.inputs[1],schlick.inputs[2]])
    f0=float(schlick.inputs[2].default_value)
    assert 0<f0<1 and abs(float(schlick.inputs[1].default_value)-(1-f0))<1e-6
    boost=next(n for n in nodes if n.type=='MATH' and n.operation=='MULTIPLY' and n.use_clamp)
    assert not boost.inputs[1].is_linked
    reflection_boost=float(boost.inputs[1].default_value)
    effective_f0=f0*reflection_boost
    assert 0<effective_f0<1
    # Match the saved normal-incidence reflectance. glTF's physical Fresnel
    # curve approximates the source's boosted/clamped Schlick at grazing angles.
    return {'source':material.name,'portable':material.name+GLASS_SUFFIX,'transmissionColor':list(transparent.inputs['Color'].default_value),
            'reflectionColor':list(glossy.inputs['Color'].default_value),'roughness':float(glossy.inputs['Roughness'].default_value),'f0':f0,
            'reflectionBoost':reflection_boost,'effectiveF0':effective_f0,'ior':(1+math.sqrt(effective_f0))/(1-math.sqrt(effective_f0))}

def portable_glass(material):
    recipe=glass_recipe(material)
    result=bpy.data.materials.new(recipe['portable']);result.use_nodes=True
    shader=result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value=recipe['transmissionColor']
    shader.inputs['Roughness'].default_value=recipe['roughness']
    shader.inputs['Metallic'].default_value=0
    shader.inputs['IOR'].default_value=recipe['ior']
    shader.inputs['Specular Tint'].default_value=recipe['reflectionColor']
    shader.inputs['Transmission Weight'].default_value=recipe.get('transmissionFactor',1)
    shader.inputs['Specular IOR Level'].default_value=recipe.get('specularIORLevel',.5)
    shader.inputs['Alpha'].default_value=1
    if 'Thin Wall' in shader.inputs:shader.inputs['Thin Wall'].default_value=True
    result.use_backface_culling=material.use_backface_culling
    result['webLightingDynamic']=True
    result['webThinGlassSource']=material.name
    return result
