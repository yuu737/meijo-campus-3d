'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { ViewerAPI, ViewerOptions, ViewerStatus } from './types';
import { MANUAL_QUALITIES, QUALITY_PROFILES } from './quality';
import './viewer.css';

const initialOptions: ViewerOptions = { quality: 'auto', trees: 'off', shadows: true, exposure: 1 };
const initialStatus: ViewerStatus = { phase: 'loading', message: 'モデルを読み込んでいます', loaded: 0, total: 0, revision: '', azimuth: 0, distance: 0, fps: 0, mode: 'orbit', effectiveQuality: 'balanced', groundReady: false, treesAvailable: false,
  renderWidth:0,renderHeight:0,drawCalls:0,triangles:0,residentMiB:0,benchmarking:false,benchmarkRemaining:30,benchmarkResults:[],benchmarkMessage:'' };
type IconName = 'home' | 'top' | 'plus' | 'minus' | 'settings' | 'expand' | 'help' | 'close';
function Icon({ name }: { name: IconName }) {
  const paths = {
    home: <><path d="m3 11 9-8 9 8M6 9v11h12V9"/><path d="M10 20v-6h4v6"/></>,
    top: <path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4"/>,
    plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6M16 9v6M10 15v6"/></>,
    expand: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16v.1"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Tool({icon,label,onClick,expanded}:{icon:IconName;label:string;onClick:()=>void;expanded?:boolean}) {
  return <button type="button" title={label} aria-label={label} aria-expanded={expanded} onClick={onClick}><Icon name={icon}/></button>;
}

export default function CampusViewer() {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const api = useRef<ViewerAPI | null>(null);
  const optionsRef = useRef(initialOptions);
  const [options, setOptions] = useState(initialOptions);
  const [status, setStatus] = useState(initialStatus);
  const [panel, setPanel] = useState<'display' | 'help' | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const stickPointer = useRef<number | null>(null);
  const movement = useRef({ x: 0, y: 0, up: 0 });
  const lastMode = useRef(initialStatus.mode);

  useEffect(() => {
    let cancelled = false;
    let instance: ViewerAPI | undefined;
    import('./engine').then(async ({ createViewer }) => {
      if (cancelled || !host.current) return;
      instance = await createViewer(host.current, initialOptions, (next) => {
        if (cancelled) return;
        if (lastMode.current !== next.mode) {
          lastMode.current = next.mode; movement.current = { x: 0, y: 0, up: 0 };
          stickPointer.current = null; setStick({x:0,y:0});
        }
        setStatus(next);
      });
      if (cancelled) instance.destroy(); else { api.current = instance; instance.setOptions(optionsRef.current); }
    }).catch(() => {
      if (!cancelled) setStatus({ ...initialStatus, phase: 'error', message: '3D表示を開始できませんでした。ページを再読み込みしてください。' });
    });
    return () => { cancelled = true; instance?.destroy(); api.current = null; };
  }, []);
  useEffect(() => { optionsRef.current = options; api.current?.setOptions(options); }, [options]);
  useEffect(() => {
    const change = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const update = <K extends keyof ViewerOptions>(key: K, value: ViewerOptions[K]) => setOptions((old) => ({ ...old, [key]: value }));
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
  const profile = QUALITY_PROFILES[status.effectiveQuality];
  const qualityLabel = profile.label;
  const copyResults = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({revision:status.revision,viewport:[window.innerWidth,window.innerHeight],devicePixelRatio:window.devicePixelRatio,results:status.benchmarkResults},null,2));
      setCopyMessage('結果をコピーしました');
    } catch { setCopyMessage('コピーできませんでした。結果は下の表で確認できます'); }
  };

  return <main className="viewer-app" ref={root} aria-label="天白キャンパス 3Dビューア">
    <div className="viewer-canvas" ref={host}/>
    <header className="viewer-title viewer-surface"><span className="viewer-mark" aria-hidden="true">M<span>3D</span></span><div><h1>天白キャンパス</h1><p>名城大学 <span>·</span> キャンパスを歩く</p></div></header>
    <div className="viewer-navigation viewer-surface" aria-label="移動方法と移動先">
      <div className="viewer-segments">{([['walk','歩く'],['fly','自由移動'],['orbit','俯瞰']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={status.mode===value} onClick={()=>value==='orbit'?api.current?.home():api.current?.setMode(value)}>{label}</button>)}</div>
      <label className="viewer-destination"><span>移動先</span>
        <select aria-label="移動先" value="" disabled={!status.groundReady} onChange={event=>api.current?.goTo(event.target.value as Parameters<ViewerAPI['goTo']>[0])}>
          <option value="" disabled>場所を選ぶ</option>
          <option value="gate">正門</option><option value="arena">アリーナ</option>
          <option value="library">図書館</option><option value="tower">タワー75</option>
          <option value="east-road">東棟沿いの道路</option><option value="sunken">サンクスガーデン</option>
          <option value="grand-stair">中央広場の大階段</option><option value="research">研究棟側の庭</option>
        </select>
      </label>
      <label className="viewer-destination"><span>画質</span>
        <select aria-label="画質を選ぶ" value={options.quality} onChange={event=>update('quality',event.target.value as ViewerOptions['quality'])}>
          <option value="auto">自動</option>{MANUAL_QUALITIES.map(value=><option value={value} key={value}>{QUALITY_PROFILES[value].label}</option>)}
        </select>
      </label>
      {options.quality!=='auto' && options.quality!=='low' && <button type="button" className="viewer-light-reset" onClick={()=>update('quality','low')}>軽量に戻す</button>}
    </div>
    <div className="viewer-tools viewer-surface" role="toolbar" aria-label="視点操作">
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
        <fieldset><legend>画質</legend><div className="viewer-quality-grid"><button type="button" aria-pressed={options.quality==='auto'} onClick={()=>update('quality','auto')}>自動</button>{MANUAL_QUALITIES.map(value=><button type="button" key={value} aria-pressed={options.quality===value} onClick={()=>update('quality',value)}>{QUALITY_PROFILES[value].label}</button>)}</div>
          <p className="viewer-note">{options.quality==='auto'?`動作に合わせて画質を調整します。現在：${qualityLabel}`:profile.description}</p>
          {options.quality!=='auto' && <p className="viewer-note">手動の画質は固定です。再読み込みすると「自動」に戻ります。</p>}
        </fieldset>
        {status.treesAvailable && <fieldset><legend>樹木</legend><div className="viewer-segments">{([['detailed', '精細'], ['light', '軽量'], ['off', 'なし']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={options.trees === value} onClick={() => update('trees', value)}>{label}</button>)}</div></fieldset>}
        <label className="viewer-checkbox"><span>影を表示</span><input type="checkbox" checked={options.shadows} onChange={(event) => update('shadows', event.target.checked)}/></label>
        <label className="viewer-range"><span>明るさ <output>{Math.round(options.exposure * 100)}%</output></span><input type="range" min="0.65" max="1.5" step="0.05" value={options.exposure} onChange={(event) => update('exposure', Number(event.target.value))}/></label>
        <section className="viewer-performance" aria-label="性能の計測">
          <h3>性能を比べる</h3>
          <dl className="viewer-metrics"><div><dt>FPS</dt><dd>{status.fps>0?status.fps.toFixed(1):'—'}</dd></div><div><dt>描画解像度</dt><dd>{status.renderWidth} × {status.renderHeight}</dd></div><div><dt>モデル常駐量（概算）</dt><dd>{Math.round(status.residentMiB)} MiB</dd></div><div><dt>描画回数 / 三角形</dt><dd>{status.drawCalls.toLocaleString()} / {(status.triangles/10_000).toFixed(1)}万</dd></div></dl>
          <button type="button" className="viewer-benchmark-button" disabled={!status.benchmarking && (options.quality==='auto'||status.phase!=='ready')} onClick={()=>status.benchmarking?api.current?.stopBenchmark():api.current?.startBenchmark()}>{status.benchmarking?`計測を中止 · 残り${status.benchmarkRemaining}秒`:'30秒計測する'}</button>
          {status.benchmarking && <progress aria-label="性能計測の進行" value={30-status.benchmarkRemaining} max={30}/>}
          <p className="viewer-note">手動の画質を選び、読み込み完了後に計測します。同じ視点で30秒間連続描画すると比較しやすくなります。</p>
          {status.benchmarkMessage && <p className="viewer-note" role="status">{status.benchmarkMessage}</p>}
          {status.benchmarkResults.length>0 && <>
            <table className="viewer-benchmark-results"><caption>このページでの計測 · 最新6件</caption><thead><tr><th>画質 / 解像度</th><th>平均FPS</th><th>1% Low</th></tr></thead><tbody>{status.benchmarkResults.map(result=><tr key={result.id}><td>{QUALITY_PROFILES[result.quality].label}<small>{result.width} × {result.height}</small></td><td>{result.fps.toFixed(1)}</td><td>{result.lowFps.toFixed(1)}</td></tr>)}</tbody></table>
            <p className="viewer-note">1% Lowは、最も遅い1%のフレームから計算したFPSです。</p>
            <button type="button" className="viewer-copy-results" onClick={copyResults}>結果をコピー</button>
            {copyMessage && <p className="viewer-note" role="status">{copyMessage}</p>}
          </>}
        </section>
      </> : <>
        <dl className="viewer-guide"><div><dt>歩く・自由移動</dt><dd>WASD・矢印キー ／ 左下のスティック</dd></div><div><dt>見回す</dt><dd>画面をドラッグ</dd></div><div><dt>速く移動</dt><dd>Shiftを押しながら移動</dd></div><div><dt>自由移動で上下へ</dt><dd>E / Q ／ 右下の上下ボタン</dd></div><div><dt>移動方法を切り替え</dt><dd><kbd>F</kbd> で歩行・自由移動</dd></div><div><dt>全体へ戻る</dt><dd><kbd>Home</kbd> ／「俯瞰」</dd></div><div><dt>俯瞰の操作</dt><dd>ドラッグで回転、右ドラッグで移動、ホイール・ピンチで拡大</dd></div><div><dt>俯瞰の注目位置</dt><dd>ダブルクリック ／ ダブルタップ</dd></div></dl>
        <p className="viewer-note">道路・階段の高さに沿って歩けます。壁や大きな段差では止まります。離れた場所には「移動先」、上空からの確認には「自由移動」を使ってください。</p>
        <p className="viewer-note"><a href="/credits.txt" target="_blank" rel="noreferrer">使用素材・ソフトウェア</a></p>
      </>}
    </section>}
    {status.mode !== 'orbit' && <>
      <div className="viewer-walk-crosshair" aria-hidden="true">＋</div>
      <div className="viewer-stick-wrap"><button type="button" className="viewer-stick" aria-label="移動スティック。ドラッグで前後左右へ移動" onPointerDown={event=>{event.preventDefault();stickPointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);dragStick(event);}} onPointerMove={dragStick} onPointerUp={stopStick} onPointerCancel={stopStick} onLostPointerCapture={stopStick}><span className="viewer-stick-axis" aria-hidden="true"/><span className="viewer-stick-thumb" style={{transform:`translate(${stick.x*38}px,${stick.y*38}px)`}} aria-hidden="true"/></button><span>移動</span></div>
      {status.mode === 'fly' && <div className="viewer-elevation"><button type="button" aria-label="上へ移動" onPointerDown={e=>vertical(1,e)} onPointerUp={()=>vertical(0)} onPointerCancel={()=>vertical(0)} onLostPointerCapture={()=>vertical(0)}>↑<span>上へ</span></button><button type="button" aria-label="下へ移動" onPointerDown={e=>vertical(-1,e)} onPointerUp={()=>vertical(0)} onPointerCancel={()=>vertical(0)} onLostPointerCapture={()=>vertical(0)}>↓<span>下へ</span></button></div>}
      <div className="viewer-look-hint">画面をドラッグして見回す</div>
    </>}
    <div className={`viewer-status viewer-surface ${status.phase === 'error' ? 'is-error' : ''}`} role="status" aria-live="polite">{status.phase === 'loading' && <span className="viewer-spinner" aria-hidden="true"/>}<span>{status.message}</span>{status.phase === 'error' && <button type="button" onClick={() => api.current ? api.current.retry() : window.location.reload()}>再試行</button>}</div>
    <footer className="viewer-footer"><span className="viewer-hint">{status.mode==='orbit'?'ドラッグで回転 · ホイールで拡大':'WASDで移動 · Shiftで速く · Fで自由移動'}</span><span className="viewer-version">{status.revision && `${status.revision} · `}{qualityLabel}{status.fps>0 && ` · ${Math.round(status.fps)} FPS`}{status.benchmarking && ` · 計測中 ${status.benchmarkRemaining}秒`}</span></footer>
    <button type="button" className="viewer-compass viewer-surface" title="北を上にする（N）" aria-label="北を上にする" onClick={() => api.current?.north()}><span className="viewer-compass-dial" style={{ '--bearing': `${-status.azimuth}rad` } as CSSProperties}><span className="viewer-north">N</span><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 5 26 27 20 23 14 27Z" fill="currentColor"/><path d="m20 35-6-8 6-4 6 4Z" fill="currentColor" opacity=".25"/></svg></span></button>
  </main>;
}
