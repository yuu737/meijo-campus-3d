import {createViewer} from './engine-v2';
import type {ViewerAPI,ViewerOptions,ViewerStatus,Quality,Vec3,NavigationMode} from './types-v2';
import daylight from '../../data/viewer/daylight.json';

if(!['127.0.0.1','localhost'].includes(location.hostname))throw new Error('Local model preview is available on loopback only');
const query=new URLSearchParams(location.search);query.set('candidate','local-preview');history.replaceState(null,'',location.pathname+'?'+query+location.hash);
const host=document.querySelector<HTMLElement>('#preview')!;
const status=document.querySelector<HTMLElement>('#status')!;
const error=document.querySelector<HTMLElement>('#preview-error')!;
let api:ViewerAPI|undefined;
let mode='orbit';
let placesSignature='';
let sourceLabel='保存モデル';
let options:ViewerOptions={quality:'balanced',trees:'off',shadows:true,exposure:daylight.exposure,interiors:false,occlusion:false,lightmaps:false};
const views:Record<string,{position:Vec3;target:Vec3}>={
 terrain:{position:[-410,140,285],target:[-160,16,162]},
 lab2:{position:[225,96,345],target:[132,12,246]},
 lab4:{position:[230,90,235],target:[134,23,140]},
 building13:{position:[220,58,130],target:[164,17,77]},
 building14:{position:[-139,43,152],target:[-129,31,112]},
};
function notify(next:ViewerStatus){
 mode=next.mode;
 status.textContent=next.phase==='ready'&&next.message==='表示中'?`表示中 · ${sourceLabel}\n${next.loaded} / ${next.total} 読み込み完了`:next.message;
 error.textContent=next.phase==='error'?next.message:'';
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')){
  button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  if(button.dataset.mode==='walk')button.disabled=!next.groundReady||next.navigationLoading===true;
 }
 const destination=document.querySelector<HTMLSelectElement>('#destination')!;
 destination.disabled=!next.groundReady||next.navigationLoading===true;
 const places=next.walkingPlaces??[],signature=JSON.stringify(places);
 if(signature!==placesSignature){
  destination.replaceChildren(new Option('歩く場所を選ぶ',''),...places.map(p=>new Option(p.label,p.id)));placesSignature=signature;
 }
 document.querySelector<HTMLButtonElement>('#recover')!.disabled=!next.groundReady;
 document.querySelector<HTMLElement>('#movement-help')!.textContent=mode==='walk'?'W/A/S/Dで歩く、ドラッグで見回す。Spaceでジャンプ、Shiftで速く移動。':mode==='fly'?'W/A/S/Dで移動、Q/Eで上下移動。ドラッグで見回す。':'ドラッグで回転、右ドラッグで移動、ホイールで拡大';
}
async function start(){
 api?.destroy();api=undefined;error.textContent='';status.textContent='モデルを読み込んでいます';
 try{
  const manifest=await fetch('/viewer/candidate-local-preview.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('保存モデルの書き出しがまだ完了していません');return r.json();});
  sourceLabel=manifest.source.filename.replace(/\.blend$/,'');
  options={...options,exposure:manifest.environment?.exposure??daylight.exposure};
  api=await createViewer(host,options,notify,()=>void start());
 }catch(cause){error.textContent=String(cause);status.textContent='読み込み待ちです。「再試行」を押してください';}
}
document.querySelector<HTMLSelectElement>('#view')!.addEventListener('change',e=>{
 const key=(e.target as HTMLSelectElement).value;const view=views[key];if(view)api?.setView?.(view.position,view.target);else api?.home();
});
document.querySelector<HTMLSelectElement>('#quality')!.addEventListener('change',e=>{options={...options,quality:(e.target as HTMLSelectElement).value as Quality};api?.setOptions(options);});
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))button.addEventListener('click',()=>{
 const next=button.dataset.mode as NavigationMode;
 if(next==='orbit')api?.home();else api?.setMode(next);
 host.querySelector('canvas')?.focus({preventScroll:true});
});
document.querySelector<HTMLSelectElement>('#destination')!.addEventListener('change',e=>{
 const select=e.currentTarget as HTMLSelectElement;if(select.value)api?.goTo(select.value);select.value='';
 host.querySelector('canvas')?.focus({preventScroll:true});
});
document.querySelector('#recover')!.addEventListener('click',()=>api?.recover?.());
document.querySelector('#home')!.addEventListener('click',()=>api?.home());
document.querySelector('#retry')!.addEventListener('click',()=>void start());
window.addEventListener('pagehide',()=>api?.destroy());
void start();
