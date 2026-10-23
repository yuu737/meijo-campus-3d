export interface ViewState {
  version:1; release:string; mode:'orbit'|'walk'|'fly';
  position:[number,number,number]; target:[number,number,number];
}
export function parseView(hash:string):ViewState|null {
  if(!hash||hash.length>2048)return null;
  try {
    const value=JSON.parse(new URLSearchParams(hash.replace(/^#/, '')).get('view')??'null');
    if(!value||value.version!==1||!['orbit','walk','fly'].includes(value.mode))return null;
    if(typeof value.release!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value.release))return null;
    const valid=(p:unknown)=>Array.isArray(p)&&p.length===3&&p.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<10000);
    if(!valid(value.position)||!valid(value.target))return null;
    if(Math.hypot(...value.position.map((n:number,i:number)=>n-value.target[i]))<.001)return null;
    return {version:1,release:value.release,mode:value.mode,position:value.position,target:value.target};
  } catch {return null;}
}
export function serializeView(state:ViewState):string {
  const clean={...state,position:state.position.map(n=>Number(n.toFixed(3))),target:state.target.map(n=>Number(n.toFixed(3)))};
  const result='#view='+encodeURIComponent(JSON.stringify(clean));
  if(!parseView(result))throw new Error('Invalid view state');
  return result;
}
