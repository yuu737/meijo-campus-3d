import sys,json,time
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'.tooling/xatlas'))
import xatlas
directory=Path(sys.argv[1]);size=int(sys.argv[2]);started=time.perf_counter()
meta=json.loads((directory/'input.json').read_text('utf8'))
positions=np.fromfile(directory/'positions.bin',dtype='<f4').reshape(-1,3)
materials=np.fromfile(directory/'materials.bin',dtype='<u4')
assert len(positions)==len(materials) and len(positions)%3==0
keys=np.empty(len(positions),dtype=[('position','<f4',(3,)),('material','<u4')]);keys['position']=positions;keys['material']=materials
unique,inverse=np.unique(keys,return_inverse=True);points=unique['position'].copy();indices=inverse.reshape(-1,3).astype(np.uint32)
assert np.array_equal(points[indices].reshape(-1,3),positions)
# With very many small charts the 4 px padding can fill most of a small atlas; pack again at twice the size.
for attempt in range(3):
    atlas=xatlas.Atlas();atlas.add_mesh(points,indices)
    packing=xatlas.PackOptions();packing.resolution=size;packing.padding=4;packing.bilinear=True;packing.blockAlign=True;packing.max_chart_size=512
    charts=xatlas.ChartOptions();charts.max_chart_area=256.;charts.max_boundary_length=128.
    atlas.generate(chart_options=charts,pack_options=packing)
    assert atlas.atlas_count==1
    mapping,packed_indices,uv=atlas[0];assert np.array_equal(mapping[packed_indices],indices)
    corners=uv[packed_indices];a,b=corners[:,1]-corners[:,0],corners[:,2]-corners[:,0]
    coverage=float(np.abs(a[:,0]*b[:,1]-a[:,1]*b[:,0]).sum()/2)
    if coverage>.05 or attempt==2:break
    print('REPACK_SPARSE',size,coverage,flush=True);size*=2
assert .05<coverage<1.01
resolution=[int((atlas.width+3)//4*4),int((atlas.height+3)//4*4)];assert max(resolution)<=8192
corners.astype('<f4').tofile(directory/'new-uv.bin')
stats={'uvCoverage':coverage,'atlasUtilization':float(atlas.utilization),'originalUVVertices':meta['vertices'],'lightAtlasVertices':len(points),'chartCount':int(atlas.chart_count),'atlasPackingSize':[atlas.width,atlas.height],'bakeResolution':resolution,'atlasAlgorithm':'xatlas-0.0.11','geometryCornersPreserved':True,'seconds':time.perf_counter()-started}
(directory/'plan.json').write_text(json.dumps(stats,indent=2),'utf8');print(json.dumps(stats),flush=True)
