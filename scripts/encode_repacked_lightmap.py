import sys,json,struct,zlib,hashlib
from pathlib import Path
import numpy as np
from scipy.ndimage import distance_transform_edt
directory=Path(sys.argv[1]);meta=json.loads((directory/'plan.json').read_text('utf8'));width,height=meta['bakeResolution']
rgba=np.fromfile(directory/'projected.rgba32f',dtype='<f4').reshape(height,width,4)
assert np.isfinite(rgba).all();valid=rgba[:,:,3]>.5;assert valid.any()
nearest=distance_transform_edt(~valid,return_distances=False,return_indices=True)
rgb=np.clip(rgba[:,:,:3][tuple(nearest)],0,1)
encoded=np.where(rgb<=.0031308,12.92*rgb,1.055*rgb**(1/2.4)-.055)
pixels=np.rint(np.dstack((encoded,np.ones((height,width),dtype=np.float32)))*255).astype(np.uint8)
def block(kind,payload):return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload)&0xffffffff)
raw=b''.join(b'\x00'+row.tobytes() for row in pixels)
out=directory/'repacked.png';out.write_bytes(b'\x89PNG\r\n\x1a\n'+block(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+block(b'sRGB',b'\x00')+block(b'IDAT',zlib.compress(raw,6))+block(b'IEND',b''))
stats={'bakedAlphaCoverage':float(valid.mean()),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'padding':'nearest-valid-texel','paddingPreservesDenoisedTexels':True,'denoise':{'method':'inherited-from-full'},'sourceUvSampling':'linear-srgb-decoded','rows':'gltf-upper-left'}
(directory/'encoding.json').write_text(json.dumps(stats,indent=2),'utf8');print(json.dumps(stats))
