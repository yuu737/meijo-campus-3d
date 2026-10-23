import RAPIER, { type Collider, type Vector } from '@dimforge/rapier3d-compat';

export const WALK_STEP=1/60;
export const WALK_HEIGHT=1.7,WALK_RADIUS=.2,WALK_EYE_HEIGHT=1.65;
// On slopes the capsule's lowest point sits above the floor at its centre.
const SUPPORT_CLEARANCE=WALK_RADIUS*(1/Math.cos(50*Math.PI/180)-1)+.04;
export interface Landing { x:number; z:number; height:number }
let initialization:Promise<void>|undefined;
export async function initializePhysics(){await (initialization??=RAPIER.init());}

/** Gravity and capsule movement in metres, independent of rendering LOD or frame rate. */
export class RapierWalkWorld {
  readonly world=new RAPIER.World({x:0,y:0,z:0});
  readonly controller=this.world.createCharacterController(.02);
  readonly body=this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  readonly character=this.world.createCollider(RAPIER.ColliderDesc.capsule(WALK_HEIGHT/2-WALK_RADIUS,WALK_RADIUS),this.body);
  private supports=new Set<number>();
  private accumulator=0;
  private jumpRequested=false;
  private verticalSpeed=0;
  grounded=false;
  active=false;
  lastSafe:Landing|null=null;
  blockedByStreaming=false;
  blockedByEdge=false;
  droppedSeconds=0;
  constructor(){
    this.world.timestep=WALK_STEP;
    this.controller.enableAutostep(.38,.22,false);
    this.controller.setMaxSlopeClimbAngle(50*Math.PI/180);
    this.controller.setMinSlopeSlideAngle(50*Math.PI/180);
    this.controller.setSlideEnabled(true);
    this.world.step();
  }
  addGeometry(positions:Float32Array,support:Uint32Array,blockers:Uint32Array):Collider[]{
    const result:Collider[]=[];
    for(const [indices,isSupport] of [[support,true],[blockers,false]] as const){
      if(!indices.length)continue;
      const collider=this.world.createCollider(RAPIER.ColliderDesc.trimesh(positions,indices,RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES));
      result.push(collider);if(isSupport)this.supports.add(collider.handle);
    }
    this.world.step();return result;
  }
  removeGeometry(colliders:Collider[]){for(const collider of colliders){this.supports.delete(collider.handle);this.world.removeCollider(collider,true);}}
  feet():Landing {const p=this.body.translation();return {x:p.x,z:p.z,height:p.y-WALK_HEIGHT/2};}
  sample(x:number,z:number,reference:number,up=.5,down=4):number|null {
    const ray=new RAPIER.Ray({x,y:reference+up,z},{x:0,y:-1,z:0});
    const hit=this.world.castRayAndGetNormal(ray,up+down,true,undefined,undefined,this.character,undefined,c=>this.supports.has(c.handle));
    if(!hit||hit.normal.y<Math.cos(50*Math.PI/180))return null;
    return ray.origin.y-hit.timeOfImpact;
  }
  /** A capsule can straddle a narrow tile joint. Require support on opposite
   * sides, so a single floor behind the player cannot carry them over a cliff. */
  private hasFootSupport(x:number,z:number,height:number):boolean {
    if(this.sample(x,z,height,.4,.6)!==null)return true;
    const radius=WALK_RADIUS*.65;
    for(const [dx,dz] of [[radius,0],[0,radius]]){
      const a=this.sample(x+dx,z+dz,height,.4,.6),b=this.sample(x-dx,z-dz,height,.4,.6);
      if(a!==null&&b!==null&&Math.abs(a-b)<=.38)return true;
    }
    return false;
  }
  canStand(x:number,z:number,height:number):boolean {
    let free=true;
    const shape=new RAPIER.Capsule(WALK_HEIGHT/2-WALK_RADIUS,WALK_RADIUS-.008);
    const position={x,y:height+WALK_HEIGHT/2+.035,z},rotation={x:0,y:0,z:0,w:1};
    this.world.intersectionsWithShape(position,rotation,shape,collider=>{
      const contact=collider.contactShape(shape,position,rotation,0);
      if(contact&&contact.distance<-.005){free=false;return false;}return true;
    },undefined,undefined,this.character);
    return free;
  }
  findNearby(x:number,z:number,reference:number,limits?:{radius:number;up:number;down:number}):Landing|null {
    const spacing=limits ? .25 : 1;
    for(let ring=0;ring<=Math.floor((limits?.radius??12)/spacing);ring++)for(let index=0;index<(ring?12:1);index++){
      const angle=index*Math.PI/6,px=x+Math.cos(angle)*ring*spacing,pz=z+Math.sin(angle)*ring*spacing;
      const height=this.sample(px,pz,reference,limits?.up??(ring?2:.65),limits?.down??5);
      if(height!==null&&this.canStand(px,pz,height))return {x:px,z:pz,height};
    }
    return null;
  }
  teleport(point:Landing){
    this.body.setTranslation({x:point.x,y:point.height+WALK_HEIGHT/2+.025,z:point.z},true);
    this.body.setNextKinematicTranslation(this.body.translation());
    this.world.step();this.verticalSpeed=0;this.accumulator=0;this.jumpRequested=false;this.grounded=true;this.active=true;
    this.lastSafe={...point};
    this.blockedByEdge=this.blockedByStreaming=false;
  }
  jump(){if(this.active&&this.grounded)this.jumpRequested=true;}
  pause(){this.accumulator=0;this.jumpRequested=false;}
  update(delta:number,velocityX:number,velocityZ:number,canTraverse:(x:number,z:number,radius:number)=>boolean):boolean {
    if(!this.active)return false;
    const before=this.body.translation();
    this.accumulator+=Math.max(0,Math.min(delta,.25));
    let steps=0;this.blockedByStreaming=false;this.blockedByEdge=false;
    while(this.accumulator>=WALK_STEP&&steps++<5){
      this.accumulator-=WALK_STEP;
      if(this.jumpRequested&&this.grounded){this.verticalSpeed=5.2;this.grounded=false;}
      this.jumpRequested=false;
      // A slight downward displacement keeps snap/steps stable; strong downward
      // pressure cancels Rapier's autostep at a riser (covered by the stair fixture).
      this.verticalSpeed=this.grounded?-.06:Math.max(-25,this.verticalSpeed-9.81*WALK_STEP);
      const point=this.body.translation();
      const nearFloor=this.verticalSpeed<=0&&this.sample(point.x,point.z,point.y-WALK_HEIGHT/2,.08,SUPPORT_CLEARANCE)!==null;
      let dx=velocityX*WALK_STEP,dz=velocityZ*WALK_STEP;
      if(!canTraverse(point.x+dx,point.z+dz,WALK_RADIUS+.06)){dx=dz=0;this.blockedByStreaming=true;}
      // The campus contains unfinished ground. Walking stops at an unsupported
      // edge; an explicit jump still has normal airborne motion and gravity.
      if((this.grounded||nearFloor)&&(dx||dz)&&!this.hasFootSupport(point.x+dx,point.z+dz,point.y-WALK_HEIGHT/2)){
        dx=dz=0;this.blockedByEdge=true;
      }
      if(this.grounded&&this.verticalSpeed<=0)this.controller.enableSnapToGround(.25);
      else this.controller.disableSnapToGround();
      const desired:Vector={x:dx,y:this.verticalSpeed*WALK_STEP,z:dz};
      this.controller.computeColliderMovement(this.character,desired,undefined,undefined,c=>c.handle!==this.character.handle);
      let movement=this.controller.computedMovement();
      // Collision sliding/autostep may redirect the requested motion into an
      // unloaded cell. Check the actual capsule destination as well.
      if(!canTraverse(point.x+movement.x,point.z+movement.z,WALK_RADIUS+.06)){
        this.controller.computeColliderMovement(this.character,{x:0,y:desired.y,z:0},undefined,undefined,c=>c.handle!==this.character.handle);
        movement=this.controller.computedMovement();this.blockedByStreaming=true;
      }
      // Wall sliding can deflect the capsule outside the requested path.
      if(nearFloor&&!this.hasFootSupport(point.x+movement.x,point.z+movement.z,point.y-WALK_HEIGHT/2)){
        this.controller.computeColliderMovement(this.character,{x:0,y:desired.y,z:0},undefined,undefined,c=>c.handle!==this.character.handle);
        movement=this.controller.computedMovement();this.blockedByEdge=true;
      }
      // Stop upward velocity on a ceiling, keeping the horizontal slide.
      if(this.verticalSpeed>0&&movement.y<desired.y-.0001)this.verticalSpeed=0;
      this.body.setNextKinematicTranslation({x:point.x+movement.x,y:point.y+movement.y,z:point.z+movement.z});
      this.world.step();
      const foot=this.feet(),support=this.verticalSpeed<=0?this.sample(foot.x,foot.z,foot.height,.04,SUPPORT_CLEARANCE):null;
      let footContact=false;
      for(let i=0;this.verticalSpeed<=0&&i<this.controller.numComputedCollisions();i++){
        const contact=this.controller.computedCollision(i);
        if(contact&&contact.normal1.y>=Math.cos(50*Math.PI/180)&&Math.abs(contact.witness1.y-foot.height)<.25&&this.hasFootSupport(foot.x,foot.z,foot.height))footContact=true;
      }
      this.grounded=this.verticalSpeed<=0&&(this.controller.computedGrounded()||footContact||(support!==null&&Math.abs(foot.height-support)<SUPPORT_CLEARANCE));
      if(this.grounded){this.verticalSpeed=0;this.lastSafe=this.feet();}
    }
    if(this.accumulator>=WALK_STEP){this.droppedSeconds+=this.accumulator;this.accumulator=0;}
    const after=this.body.translation();
    return Math.hypot(after.x-before.x,after.y-before.y,after.z-before.z)>.00001;
  }
  dispose(){this.world.free();}
}
