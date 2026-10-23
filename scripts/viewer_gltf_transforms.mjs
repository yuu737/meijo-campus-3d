/** Retain exact node transforms when the glTF writer omits near-default values. */
export function preserveExactNodeTransformsJSON(json,document){
 const nodes=document.getRoot().listNodes();
 // NodeIO writes nodes in root.listNodes() order. Keep that correspondence
 // explicit and reject unexpected writer output before touching its transforms.
 if((json.nodes?.length??0)!==nodes.length)throw Error('Serialized node count differs');
 nodes.forEach((node,index)=>{
  const target=json.nodes[index];
  if((target.name??'')!==node.getName())throw Error('Serialized node order differs');
  delete target.matrix;
  for(const [key,value,identity]of [['translation',node.getTranslation(),[0,0,0]],['rotation',node.getRotation(),[0,0,0,1]],['scale',node.getScale(),[1,1,1]]]){
   if(!value.every(Number.isFinite))throw Error('Nonfinite node transform');
   // The library uses a tolerance here. A scale such as 1.00000739 is an
   // authored transform, and must not be silently replaced with 1.
   if(value.every((v,i)=>v===identity[i]))delete target[key];else target[key]=[...value];
  }
 });
 return json;
}

export function preserveExactNodeTransforms(binary,document){
 const bytes=Buffer.from(binary.buffer,binary.byteOffset,binary.byteLength);
 if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a)throw Error('Expected a complete glTF 2 binary');
 const jsonLength=bytes.readUInt32LE(12),tailStart=20+jsonLength;
 if(jsonLength%4||tailStart>bytes.length)throw Error('Invalid glTF JSON chunk');
 const json=preserveExactNodeTransformsJSON(JSON.parse(bytes.subarray(20,tailStart).toString('utf8')),document);
 const encoded=Buffer.from(JSON.stringify(json)),paddedLength=Math.ceil(encoded.length/4)*4;
 const result=Buffer.alloc(20+paddedLength+bytes.length-tailStart);
 bytes.copy(result,0,0,20);result.writeUInt32LE(result.length,8);result.writeUInt32LE(paddedLength,12);
 result.fill(0x20,20,20+paddedLength);encoded.copy(result,20);
 // Retain every binary/resource chunk byte-for-byte.
 bytes.copy(result,20+paddedLength,tailStart);
 return result;
}
