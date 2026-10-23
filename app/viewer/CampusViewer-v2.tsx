'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { ViewerAPI, ViewerOptions, ViewerStatus } from './types-v2';
import { MANUAL_QUALITIES, QUALITY_PROFILES } from './quality';
import { MEMORY_CHOICES, detectMemoryMiB, storedMemoryMiB, storeMemoryMiB } from './memory-budget';
import reviewViews from '../../data/viewer/review-views.json';
import daylight from '../../data/viewer/daylight.json';
import './viewer.css';

function initialOptions():ViewerOptions {
  // Choose a starting value once. Only explicit user actions change it later.
  const light=typeof window!=='undefined'&&(window.matchMedia('(pointer: coarse)').matches||
    ((navigator as Navigator & {deviceMemory?:number}).deviceMemory??8)<=4||navigator.hardwareConcurrency<=4);
  return {quality:light?'low':'balanced',trees:'off',shadows:true,exposure:daylight.exposure,interiors:false,walkSpeed:3.2,lookSensitivity:1,occlusion:false,lightmaps:true,memoryMiB:storedMemoryMiB()??autoMemoryMiB};
}
const autoMemoryMiB=detectMemoryMiB();
const memoryLabel=(miB:number)=>miB>=1024?`${miB/1024}GB`:`${miB}MB`;
const initialStatus: ViewerStatus = { phase: 'loading', message: 'モデルを読み込んでいます', loaded: 0, total: 0, revision: '', azimuth: 0, distance: 0, fps: 0, mode: 'orbit', effectiveQuality: 'balanced', groundReady: false, treesAvailable: false,
  renderWidth:0,renderHeight:0,drawCalls:0,triangles:0,residentMiB:0,benchmarking:false,benchmarkRemaining:30,benchmarkResults:[],benchmarkMessage:'',release:'',sourceFilename:'',navigationPolicy:'pending',navigationLoading:false,navigationMiB:0,destinations:[] };
type IconName = 'home' | 'top' | 'plus' | 'minus' | 'settings' | 'expand' | 'help' | 'close' | 'navigation';
function Icon({ name }: { name: IconName }) {
  const paths = {
    home: <><path d="m3 11 9-8 9 8M6 9v11h12V9"/><path d="M10 20v-6h4v6"/></>,
    top: <path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4"/>,
    plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6M16 9v6M10 15v6"/></>,
    expand: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16v.1"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    navigation: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Tool({icon,label,onClick,expanded}:{icon:IconName;label:string;onClick:()=>void;expanded?:boolean}) {
  return <button type="button" title={label} aria-label={label} aria-expanded={expanded} onClick={onClick}><Icon name={icon}/></button>;
}

export default function CampusViewer({onExit}:{onExit?:()=>void}) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const api = useRef<ViewerAPI | null>(null);
  const [options, setOptions] = useState(initialOptions);
  const optionsRef = useRef(options);
  const [status, setStatus] = useState({...initialStatus,effectiveQuality:options.quality});
  const [panel, setPanel] = useState<'display' | 'help' | null>(null);
  const [navigationOpen,setNavigationOpen]=useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const stickPointer = useRef<number | null>(null);
  const movement = useRef({ x: 0, y: 0, up: 0 });
  const lastMode = useRef(initialStatus.mode);
  const [generation,setGeneration]=useState(0);
  const recoveryView=useRef<string|undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let instance: ViewerAPI | undefined;
    setStatus({...initialStatus,effectiveQuality:optionsRef.current.quality,message:'3D表示を準備しています'});
    const restart=()=>{
      if(cancelled)return;
      recoveryView.current=instance?.shareView?.()??recoveryView.current;
      setGeneration(n=>n+1);
    };
    import('./engine-v2').then(async ({ createViewer }) => {
      if (cancelled || !host.current) return;
      instance = await createViewer(host.current, optionsRef.current, (next) => {
        if (cancelled) return;
        if (lastMode.current !== next.mode) {
          lastMode.current = next.mode; movement.current = { x: 0, y: 0, up: 0 };
          stickPointer.current = null; setStick({x:0,y:0});
        }
        setStatus(next);
      },restart,recoveryView.current);
      if (cancelled) instance.destroy(); else { api.current = instance; instance.setOptions(optionsRef.current); }
    }).catch((cause) => {
      if (!cancelled){
        console.warn('3D initialization failed',cause);
        setStatus({ ...initialStatus,effectiveQuality:optionsRef.current.quality,phase:'error',message:'3D表示を準備できませんでした。「再試行」か「軽量に戻す」をお試しください。' });
      }
    });
    return () => { cancelled = true;instance?.destroy(); api.current = null; };
  }, [generation]);
  useEffect(() => { optionsRef.current = options; api.current?.setOptions(options); }, [options]);
  useEffect(()=>{if(panel){api.current?.pause?.();movement.current={x:0,y:0,up:0};stickPointer.current=null;setStick({x:0,y:0});}},[panel]);
  useEffect(()=>{
    const reset=()=>{api.current?.pause?.();movement.current={x:0,y:0,up:0};stickPointer.current=null;setStick({x:0,y:0});};
    const visibility=()=>{if(document.hidden)reset();};
    window.addEventListener('blur',reset);document.addEventListener('visibilitychange',visibility);
    return ()=>{window.removeEventListener('blur',reset);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  useEffect(()=>{if(status.navigationLoading){movement.current={x:0,y:0,up:0};stickPointer.current=null;setStick({x:0,y:0});}},[status.navigationLoading]);
  useEffect(() => {
    const change = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const update = <K extends keyof ViewerOptions>(key: K, value: ViewerOptions[K]) => setOptions((old) => ({ ...old, [key]: value }));
  const retry=()=>{if(api.current)api.current.retry();else setGeneration(n=>n+1);};
  const resetToLight=()=>{
    const next={...optionsRef.current,quality:'low' as const};optionsRef.current=next;setOptions(next);
    if(!api.current||status.phase==='error')setGeneration(n=>n+1);
  };
  const full = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.current?.requestFullscreen(); } catch { /* Optional browser capability. */ }
  };
  const sendMovement = () => { const m = movement.current; api.current?.move(m.x,m.y,m.up); };
  const dragStick = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerId !== stickPointer.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    let x = (event.clientX-rect.left-rect.width/2)/43, y = (event.clientY-rect.top-rect.height/2)/43;
    const length = Math.hypot(x,y); if (length > 1) { x/=length; y/=length; }
    setStick({x,y});movement.current.x=x;movement.current.y=-y;sendMovement();
  };
  const stopStick = () => { stickPointer.current=null;setStick({x:0,y:0});movement.current.x=movement.current.y=0;sendMovement(); };
  const vertical = (value: number, event?: ReactPointerEvent<HTMLButtonElement>) => {
    if (event) { event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId); }
    movement.current.up=value;sendMovement();
  };
  const profile = QUALITY_PROFILES[options.quality];
  const qualityLabel = profile.label;
  const copyResults = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({revision:status.revision,backend:status.rendererBackend,viewport:[window.innerWidth,window.innerHeight],devicePixelRatio:window.devicePixelRatio,results:status.benchmarkResults},null,2));
      setCopyMessage('結果をコピーしました');
    } catch { setCopyMessage('コピーできませんでした。結果は下の表で確認できます'); }
  };

  return <main className="viewer-app" ref={root} aria-label="天白キャンパス 3Dビューア">
    <div className="viewer-canvas" ref={host}/>
    <header className="viewer-title viewer-surface"><span className="viewer-mark" aria-hidden="true">M<span>3D</span></span><div><h1>天白キャンパス</h1><p>非公式 3Dプロトタイプ <span>·</span> 制作中</p></div>{onExit&&<button type="button" className="viewer-intro-back" onClick={onExit} aria-label="説明と建物情報へ戻る">←</button>}</header>
    {navigationOpen && <div className="viewer-navigation viewer-surface" aria-label="移動方法と移動先">
      <div className="viewer-navigation-heading"><span>移動メニュー</span><Tool icon="close" label="移動メニューを閉じる" onClick={()=>setNavigationOpen(false)}/></div>
      <div className="viewer-segments">{([['walk','歩く'],['fly','自由移動'],['orbit','俯瞰']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={status.mode===value} onClick={()=>value==='orbit'?api.current?.home():api.current?.setMode(value)}>{label}</button>)}</div>
      <label className="viewer-destination"><span>移動先</span>
        <select aria-label="移動先" value="" disabled={!status.groundReady} onChange={event=>api.current?.goTo(event.target.value as Parameters<ViewerAPI['goTo']>[0])}>
          <option value="" disabled>場所を選ぶ</option>
          {status.walkingPlaces?.map(p=><option value={p.id} key={p.id}>{p.label}</option>)}
        </select>
      </label>
      {(status.destinations?.some(d=>d.interior)) && <label className="viewer-destination"><span>棟・階</span>
        <select aria-label="棟・階へ移動" value="" onChange={e=>{api.current?.goToChunk?.(e.target.value);e.currentTarget.value='';}}>
          <option value="" disabled>場所を選ぶ</option>
          {status.destinations.filter(d=>d.interior).map(d=><option value={d.id} key={d.id}>{d.label}</option>)}
        </select>
      </label>}
      <label className="viewer-destination"><span>画質</span>
        <select aria-label="画質を選ぶ" value={options.quality} onChange={event=>update('quality',event.target.value as ViewerOptions['quality'])}>
          {MANUAL_QUALITIES.map(value=><option value={value} key={value}>{QUALITY_PROFILES[value].label}</option>)}
        </select>
      </label>
      {(status.phase==='error'||options.quality!=='low') && <button type="button" className="viewer-light-reset" onClick={resetToLight}>軽量に戻す</button>}
      {status.treesAvailable && <label className="viewer-tree-toggle"><span>樹木</span><span className="viewer-tree-state">{options.trees === 'off' ? 'OFF' : 'ON'}</span><input type="checkbox" role="switch" aria-label="樹木を表示" checked={options.trees !== 'off'} onChange={event=>update('trees',event.target.checked?'light':'off')}/></label>}
      <div className="viewer-quick-actions"><button type="button" onClick={()=>api.current?.recover?.()}>安全な床へ戻る</button><button type="button" onClick={async()=>{try{const u=api.current?.shareView?.();if(u){await navigator.clipboard.writeText(u);setCopyMessage('視点URLをコピーしました');}}catch{setCopyMessage('コピーできませんでした。ブラウザーの権限を確認してください');}}}>視点URLをコピー</button></div>
      {copyMessage&&<p className="viewer-note" role="status">{copyMessage}</p>}
      {status.modelUpdateAvailable&&<div className="viewer-model-update" role="status"><span>モデルが更新されました</span><button type="button" onClick={()=>window.location.reload()}>最新版を表示</button></div>}
    </div>}
    <div className="viewer-tools viewer-surface" role="toolbar" aria-label="視点操作">
      <Tool icon="navigation" label="移動メニュー" expanded={navigationOpen} onClick={()=>setNavigationOpen(!navigationOpen)}/>
      <Tool icon="home" label="全体を表示（Home）" onClick={() => api.current?.home()}/>
      <Tool icon="top" label="真上から見る（T）" onClick={() => api.current?.top()}/>
      <span className="viewer-tool-divider"/>
      <Tool icon="plus" label="拡大（＋）" onClick={() => api.current?.zoom(1)}/>
      <Tool icon="minus" label="縮小（－）" onClick={() => api.current?.zoom(-1)}/>
      <span className="viewer-tool-divider"/>
      <Tool icon="settings" label="表示設定" onClick={() => setPanel(panel === 'display' ? null : 'display')} expanded={panel === 'display'}/>
      <Tool icon="help" label="操作ガイド" onClick={() => setPanel(panel === 'help' ? null : 'help')} expanded={panel === 'help'}/>
      <Tool icon="expand" label={fullscreen ? '全画面表示を終了' : '全画面表示'} onClick={full}/>
    </div>
    {panel && <section className="viewer-panel viewer-surface" aria-label={panel === 'display' ? '表示設定' : '操作ガイド'}>
      <div className="viewer-panel-heading"><h2>{panel === 'display' ? '表示設定' : '操作ガイド'}</h2><Tool icon="close" label="パネルを閉じる" onClick={() => setPanel(null)}/></div>
      {panel === 'display' ? <>
        <fieldset><legend>画質</legend><div className="viewer-quality-grid">{MANUAL_QUALITIES.map(value=><button type="button" key={value} aria-pressed={options.quality===value} onClick={()=>update('quality',value)}>{QUALITY_PROFILES[value].label}</button>)}</div>
          <p className="viewer-note">{profile.description} 選んだ画質で固定します。</p>
          <p className="viewer-note">現在の描画解像度：{status.renderWidth} × {status.renderHeight}。光と材質は共通です。</p>
          {status.rendererFallback&&<p className="viewer-note" role="status">{status.rendererFallback}</p>}
        </fieldset>
        {status.treesAvailable && <label className="viewer-tree-toggle"><span>樹木</span><span className="viewer-tree-state">{options.trees === 'off' ? 'OFF' : 'ON'}</span><input type="checkbox" role="switch" aria-label="樹木を表示" checked={options.trees !== 'off'} onChange={event=>update('trees',event.target.checked?'light':'off')}/></label>}
        <p className="viewer-note">{status.bakedLightingMode==='combined-diffuse'?'材質色と昼光を一体にした試験用の照明画像を表示しています。':(status.lightmappedMeshes??0)>0&&options.lightmaps!==false?'計算済みの昼光と接地影を適用しています。':'太陽光と、空・地面からの環境光で表示しています。'}</p>
        {(status.lightmappedMeshes??0)>0&&<label className="viewer-checkbox"><span>計算済みの昼光を表示</span><input type="checkbox" disabled={status.bakedLightingMode==='combined-diffuse'} checked={status.bakedLightingMode==='combined-diffuse'||options.lightmaps!==false} onChange={e=>update('lightmaps',e.target.checked)}/></label>}
        <label className="viewer-destination"><span>読み込んだモデルを保つ量</span><select aria-label="読み込んだモデルを保つ量" value={storedMemoryMiB()===null?'auto':String(options.memoryMiB)} onChange={e=>{const v=e.target.value==='auto'?null:Number(e.target.value);storeMemoryMiB(v);update('memoryMiB',v??autoMemoryMiB);}}>
          <option value="auto">自動（この端末の推定：{memoryLabel(autoMemoryMiB)}）</option>{MEMORY_CHOICES.map(v=><option key={v} value={v}>{memoryLabel(v)}</option>)}</select></label>
        <p className="viewer-note">多いほど一度読み込んだ場所を消さずに保ち、見回したときの読み直しが減ります。端末のメモリが足りないと重くなったり表示が止まったりします。現在 {status.residentMiB.toFixed(0)}MB 使用中。</p>
        <label className="viewer-checkbox"><span>遮蔽された遠景の詳細読込を抑制</span><input type="checkbox" checked={options.occlusion!==false} onChange={e=>update('occlusion',e.target.checked)}/></label>
        <label className="viewer-destination"><span>比較視点</span><select aria-label="比較視点" value="" onChange={e=>api.current?.reviewView?.(e.target.value)}><option value="">視点を選択</option>{reviewViews.map(view=><option key={view.id} value={view.id}>{view.label}</option>)}</select></label>
        <label className="viewer-checkbox"><span>樹木などの追加の影を表示</span><input type="checkbox" checked={options.shadows} onChange={(event) => update('shadows', event.target.checked)}/></label>
        <label className="viewer-range"><span>歩行速度 <output>{(options.walkSpeed??3.2).toFixed(1)} m/s</output></span><input type="range" min="1" max="5" step="0.2" value={options.walkSpeed??3.2} onChange={e=>update('walkSpeed',Number(e.target.value))}/></label>
        <label className="viewer-range"><span>見回す速さ <output>{(options.lookSensitivity??1).toFixed(1)}倍</output></span><input type="range" min="0.3" max="2" step="0.1" value={options.lookSensitivity??1} onChange={e=>update('lookSensitivity',Number(e.target.value))}/></label>
        <label className="viewer-range"><span>明るさ <output>{Math.round(options.exposure * 100)}%</output></span><input type="range" min="0.65" max="1.5" step="0.05" value={options.exposure} onChange={(event) => update('exposure', Number(event.target.value))}/></label>
        <section className="viewer-performance" aria-label="性能の計測">
          <h3>性能を比べる</h3>
          <dl className="viewer-metrics"><div><dt>FPS</dt><dd>{status.fps>0?status.fps.toFixed(1):'—'}</dd></div><div><dt>描画解像度</dt><dd>{status.renderWidth} × {status.renderHeight}</dd></div><div><dt>モデル常駐量（概算）</dt><dd>{Math.round(status.residentMiB)} MiB</dd></div><div><dt>描画回数 / 三角形</dt><dd>{status.drawCalls.toLocaleString()} / {(status.triangles/10_000).toFixed(1)}万</dd></div></dl>
          <button type="button" className="viewer-benchmark-button" disabled={!status.benchmarking && status.phase!=='ready'} onClick={()=>status.benchmarking?api.current?.stopBenchmark():api.current?.startBenchmark()}>{status.benchmarking?`計測を中止 · 残り${status.benchmarkRemaining}秒`:'30秒計測する'}</button>
          {status.benchmarking && <progress aria-label="性能計測の進行" value={30-status.benchmarkRemaining} max={30}/>}
          <p className="viewer-note">手動の画質を選び、読み込み完了後に計測します。同じ視点で30秒間連続描画すると比較しやすくなります。</p>
          {status.benchmarkMessage && <p className="viewer-note" role="status">{status.benchmarkMessage}</p>}
          {status.benchmarkResults.length>0 && <>
            <table className="viewer-benchmark-results"><caption>このページでの計測 · 最新6件</caption><thead><tr><th>画質 / 解像度</th><th>平均FPS</th><th>p95 ms</th><th>停止</th></tr></thead><tbody>{status.benchmarkResults.map(result=><tr key={result.id}><td>{QUALITY_PROFILES[result.quality].label}<small>{result.width} × {result.height}</small></td><td>{result.fps.toFixed(1)}</td><td>{result.p95FrameMs.toFixed(1)}</td><td>{result.freezes}</td></tr>)}</tbody></table>
            <p className="viewer-note">p95は95%のフレームが収まる時間。停止は200msを超えた回数です。</p>
            <button type="button" className="viewer-copy-results" onClick={copyResults}>結果をコピー</button>
            {copyMessage && <p className="viewer-note" role="status">{copyMessage}</p>}
          </>}
        </section>
      </> : <>
        <dl className="viewer-guide"><div><dt>歩く・自由移動</dt><dd>WASD・矢印キー ／ 左下のスティック</dd></div><div><dt>見回す</dt><dd>画面をドラッグ</dd></div><div><dt>ジャンプ</dt><dd>Space ／ 右下のジャンプボタン</dd></div><div><dt>マウスで見回す</dt><dd>ダブルクリックで視点を固定、Escで解除</dd></div><div><dt>速く移動</dt><dd>Shiftを押しながら移動</dd></div><div><dt>自由移動で上下へ</dt><dd>E / Q ／ 右下の上下ボタン</dd></div><div><dt>移動方法を切り替え</dt><dd><kbd>F</kbd> で歩行・自由移動</dd></div><div><dt>全体へ戻る</dt><dd><kbd>Home</kbd> ／「俯瞰」</dd></div><div><dt>俯瞰の操作</dt><dd>ドラッグで回転、右ドラッグで移動、ホイール・ピンチで拡大</dd></div><div><dt>俯瞰の注目位置</dt><dd>ダブルクリック ／ ダブルタップ</dd></div></dl>
        <p className="viewer-note">道路・階段の高さに沿って歩けます。壁や大きな段差では止まります。離れた場所には「移動先」、上空からの確認には「自由移動」を使ってください。</p>
        <p className="viewer-note"><a href="/credits.txt" target="_blank" rel="noreferrer">使用素材・ソフトウェア</a></p>
      </>}
    </section>}
    {status.mode !== 'orbit' && !panel && <>
      <div className="viewer-walk-crosshair" aria-hidden="true">＋</div>
      <div className="viewer-stick-wrap"><button type="button" className="viewer-stick" aria-label="移動スティック。ドラッグで前後左右へ移動" onPointerDown={event=>{event.preventDefault();stickPointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);dragStick(event);}} onPointerMove={dragStick} onPointerUp={stopStick} onPointerCancel={stopStick} onLostPointerCapture={stopStick}><span className="viewer-stick-axis" aria-hidden="true"/><span className="viewer-stick-thumb" style={{transform:`translate(${stick.x*38}px,${stick.y*38}px)`}} aria-hidden="true"/></button><span>移動</span></div>
      {status.mode === 'fly' && <div className="viewer-elevation"><button type="button" aria-label="上へ移動" onPointerDown={e=>vertical(1,e)} onPointerUp={()=>vertical(0)} onPointerCancel={()=>vertical(0)} onLostPointerCapture={()=>vertical(0)}>↑<span>上へ</span></button><button type="button" aria-label="下へ移動" onPointerDown={e=>vertical(-1,e)} onPointerUp={()=>vertical(0)} onPointerCancel={()=>vertical(0)} onLostPointerCapture={()=>vertical(0)}>↓<span>下へ</span></button></div>}
      <div className="viewer-look-hint">画面をドラッグして見回す</div>
      {status.mode==='walk'&&!panel&&<button type="button" className="viewer-jump" onPointerDown={e=>{e.preventDefault();api.current?.jump();}} onClick={e=>{if(e.detail===0)api.current?.jump();}} aria-label="ジャンプ">↑<span>ジャンプ</span></button>}
    </>}
    <div className={`viewer-status viewer-surface ${status.phase === 'error' ? 'is-error' : ''}`} role="status" aria-live="polite">{status.phase === 'loading' && <span className="viewer-spinner" aria-hidden="true"/>}<span>{status.message}</span>{status.phase === 'error' && <button type="button" onClick={retry}>再試行</button>}</div>
    <footer className="viewer-footer"><span className="viewer-hint">{status.mode==='orbit'?'ドラッグで回転 · ホイールで拡大':'WASDで移動 · Shiftで速く · Fで自由移動'}</span><span className="viewer-version">{status.revision && `${status.revision} · `}{qualityLabel}{status.fps>0 && ` · ${Math.round(status.fps)} FPS`}{status.benchmarking && ` · 計測中 ${status.benchmarkRemaining}秒`}</span></footer>
    <button type="button" className="viewer-compass viewer-surface" title="北を上にする（N）" aria-label="北を上にする" onClick={() => api.current?.north()}><span className="viewer-compass-dial" style={{ '--bearing': `${-status.azimuth}rad` } as CSSProperties}><span className="viewer-north">N</span><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 5 26 27 20 23 14 27Z" fill="currentColor"/><path d="m20 35-6-8 6-4 6 4Z" fill="currentColor" opacity=".25"/></svg></span></button>
  </main>;
}
