/** Abortable readiness polling; never inspect a program after GPU disposal. */
export function waitForShaderPrograms(ready:()=>boolean,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);};
    const cancel=()=>{clean();reject(new DOMException('Shader preparation cancelled','AbortError'));};
    const poll=()=>{
      if(signal.aborted){cancel();return;}
      try{if(ready()){clean();resolve();}else timer=setTimeout(poll,10);}catch(cause){clean();reject(cause);}
    };
    signal.addEventListener('abort',cancel,{once:true});poll();
  });
}
