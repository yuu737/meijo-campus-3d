/** Compare triangle surfaces across independently UV-packed lighting assets. */
import {createHash} from 'node:crypto';

export function geometryIdentity(document){
  const faces=[];
  for(const node of document.getRoot().listNodes()){
    const mesh=node.getMesh();if(!mesh)continue;
    if(node.getExtension('EXT_mesh_gpu_instancing'))throw new Error('Static lighting geometry must not contain GPU instances');
    const m=node.getWorldMatrix();
    for(const primitive of mesh.listPrimitives()){
      if(primitive.getMode()!==4)throw new Error('Expected triangle geometry');
      const positions=primitive.getAttribute('POSITION'),indices=primitive.getIndices();
      if(!positions)throw new Error('Missing positions');
      const count=indices?.getCount()??positions.getCount();
      if(count%3)throw new Error('Incomplete triangle');
      const point=index=>{
        const p=positions.getElement(index,[]),[x,y,z]=p;
        // Float32 is the authored/exported position precision. Keep every bit;
        // do not snap thin surfaces onto a tolerance grid.
        const result=new Float32Array([m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]]);
        for(let j=0;j<3;j++){if(!Number.isFinite(result[j]))throw new Error('Nonfinite position');if(Object.is(result[j],-0))result[j]=0;}
        return Buffer.from(result.buffer).toString('hex');
      };
      for(let i=0;i<count;i+=3){
        const corners=[0,1,2].map(j=>point(indices?indices.getScalar(i+j):i+j));
        // Rotation preserves winding; UV seams and index ordering may differ.
        faces.push([corners.join(''),[corners[1],corners[2],corners[0]].join(''),[corners[2],corners[0],corners[1]].join('')].sort()[0]);
      }
    }
  }
  faces.sort();
  return {algorithm:'world-float32-oriented-triangles-v1',triangles:faces.length,sha256:createHash('sha256').update(faces.join('\n')).digest('hex')};
}
