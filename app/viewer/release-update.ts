/** A live session stays on one release until the visitor explicitly reloads. */
export function newerRelease(value:unknown,current:string):boolean {
  if(!value||typeof value!=='object')return false;
  const m=value as {schema?:string;release?:string;source?:{sha256?:string};colliders?:{sourceModelSha256?:string}};
  return m.schema==='tempaku-viewer-1'&&typeof m.release==='string'&&/^[a-f0-9]{20}$/.test(m.release)&&m.release!==current&&
    typeof m.source?.sha256==='string'&&/^[a-f0-9]{64}$/.test(m.source.sha256)&&m.colliders?.sourceModelSha256===m.source.sha256;
}
