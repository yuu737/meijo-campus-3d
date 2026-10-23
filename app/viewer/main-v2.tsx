import {observePageExperience} from './performance-metrics';
observePageExperience();
const introduction=document.getElementById('campus-introduction')!;
const host=document.getElementById('root')!;
const button=document.getElementById('start-3d') as HTMLButtonElement;
let started=false;
async function start(){
  if(started)return;started=true;button.disabled=true;button.setAttribute('aria-busy','true');
  document.getElementById('start-error')!.textContent='';performance.mark('campus-3d-start');
  try{
    const [{createRoot},{createElement},{default:CampusViewer}]=await Promise.all([import('react-dom/client'),import('react'),import('./CampusViewer-v2')]);
    const root=createRoot(host);host.hidden=false;introduction.hidden=true;
    root.render(createElement(CampusViewer,{onExit:()=>{
      root.unmount();host.hidden=true;introduction.hidden=false;started=false;button.disabled=false;button.removeAttribute('aria-busy');button.focus();
    }}));
  }catch{
    started=false;button.disabled=false;button.removeAttribute('aria-busy');
    document.getElementById('start-error')!.textContent='3Dを開始できませんでした。画像と建物情報は引き続きご覧いただけます。';
  }
}
button.addEventListener('click',()=>void start());
if(new URLSearchParams(location.search).get('start')==='1'||location.hash.startsWith('#view='))void start();
export {};
