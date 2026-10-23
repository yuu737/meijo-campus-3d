import * as THREE from 'three';

/** Names are only resolved within their glTF document; the URI is content-addressed. */
export function tagTextureSources(scene:THREE.Object3D,json:{images?:{name?:string;uri?:string}[];textures?:{name?:string;source?:number;extensions?:{KHR_texture_basisu?:{source:number}}}[]}) {
  const names=new Map<string,Set<string>>();
  const add=(name:string|undefined,uri:string|undefined)=>{
    if(!name||!uri||!/(?:^|\/)[a-f0-9]{64}\.ktx2$/.test(uri))return;
    const entries=names.get(name)??new Set<string>();entries.add(uri);names.set(name,entries);
  };
  for(const image of json.images??[]){add(image.name,image.uri);add(image.uri,image.uri);}
  for(const texture of json.textures??[]){
    const index=texture.extensions?.KHR_texture_basisu?.source??texture.source;
    if(index!==undefined)add(texture.name,json.images?.[index]?.uri);
  }
  scene.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return;
    for(const material of Array.isArray(object.material)?object.material:[object.material])
      for(const texture of Object.values(material))if(texture instanceof THREE.Texture){
        const matches=names.get(texture.name);
        if(matches?.size===1)texture.userData.campusContentURI=[...matches][0];
      }
  });
}

/** Never share images across different UV channels, transforms, sampling or colour spaces. */
export function textureSharingKey(texture:THREE.Texture):string|null {
  const uri=texture.userData.campusContentURI;
  if(typeof uri!=='string'||!/(?:^|\/)[a-f0-9]{64}\.ktx2$/.test(uri))return null;
  return JSON.stringify([uri,texture.channel,texture.colorSpace,texture.mapping,texture.wrapS,texture.wrapT,
    texture.minFilter,texture.magFilter,texture.flipY,texture.premultiplyAlpha,texture.format,texture.type,
    texture.generateMipmaps,texture.offset.toArray(),texture.repeat.toArray(),texture.center.toArray(),
    texture.rotation,texture.matrixAutoUpdate,texture.matrixAutoUpdate?null:texture.matrix.toArray()]);
}
