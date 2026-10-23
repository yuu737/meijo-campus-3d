import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { DisplayRenderer } from './display-backend';
type Entry={proxy:THREE.Mesh;query:WebGLQuery|null;pending:boolean;hidden:number;last:number};
/** Occlusion gates only distant refinement. Coarse geometry and collision remain available. */
export class OcclusionStreaming {
  private entries=new Map<string,Entry>();
  private geometry=new THREE.BoxGeometry(1,1,1);
  private material=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,depthTest:true,transparent:true});
  private gl:WebGL2RenderingContext|null=null;
  private gpu:WebGPURenderer|null=null;
  private pose=new THREE.Matrix4();private changedAt=0;private budget=0;private enabled=true;
  readonly group=new THREE.Group();
  constructor(private renderer:DisplayRenderer,private camera:THREE.Camera){
    if(renderer instanceof THREE.WebGLRenderer)this.gl=renderer.getContext() as WebGL2RenderingContext;
    else this.gpu=renderer;
    this.material.blending=THREE.NoBlending;this.material.toneMapped=false;
  }
  add(id:string,box:THREE.Box3){
    const proxy=new THREE.Mesh(this.geometry,this.material);
    box.getCenter(proxy.position);box.getSize(proxy.scale).addScalar(.04);
    proxy.renderOrder=1e8;proxy.castShadow=false;proxy.receiveShadow=false;
    proxy.visible=false;proxy.matrixAutoUpdate=false;proxy.updateMatrix();
    const entry:Entry={proxy,query:null,pending:false,hidden:0,last:0};
    if(this.gpu)proxy.occlusionTest=true;
    if(this.gl){
      const gl=this.gl;
      proxy.onBeforeRender=(_r,scene,camera)=>{
        if(camera!==this.camera||scene.overrideMaterial||entry.pending||this.budget<=0)return;
        const now=performance.now();if(now-entry.last<300)return;
        entry.query??=gl.createQuery();if(!entry.query)return;
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,entry.query);
        proxy.userData.queryActive=true;entry.last=now;this.budget--;
      };
      proxy.onAfterRender=()=>{
        if(proxy.userData.queryActive){gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);proxy.userData.queryActive=false;entry.pending=true;}
      };
    }
    this.entries.set(id,entry);this.group.add(proxy);
  }
  beginFrame(now:number,enabled:boolean){
    this.enabled=enabled;this.group.visible=enabled;this.budget=8;
    this.camera.updateMatrixWorld();
    if(!this.pose.equals(this.camera.matrixWorld)){
      this.pose.copy(this.camera.matrixWorld);this.changedAt=now;
      for(const e of this.entries.values())e.hidden=0;
    }
  }
  test(id:string,relevant:boolean,distance:number,now:number):boolean {
    const e=this.entries.get(id);if(!e)return false;
    e.proxy.visible=this.enabled&&relevant&&distance>80&&distance<800;
    if(!e.proxy.visible||now-this.changedAt<500){e.hidden=0;return false;}
    if(this.gl&&e.query&&e.pending&&this.gl.getQueryParameter(e.query,this.gl.QUERY_RESULT_AVAILABLE)){
      const hidden=!this.gl.getQueryParameter(e.query,this.gl.QUERY_RESULT);
      e.hidden=hidden&&e.last>=this.changedAt?e.hidden+1:0;e.pending=false;
    }else if(this.gpu)e.hidden=this.gpu.isOccluded(e.proxy)?e.hidden+1:0;
    return e.hidden>=2;
  }
  needsUpdate(now:number){return this.enabled&&now-this.changedAt<1800;}
  dispose(){for(const e of this.entries.values())if(e.query)this.gl?.deleteQuery(e.query);this.entries.clear();this.geometry.dispose();this.material.dispose();this.group.removeFromParent();}
}
