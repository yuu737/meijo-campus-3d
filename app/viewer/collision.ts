// Capsule/triangle distance tests. Independent of rendering and external libraries.
type V = readonly [number, number, number];
const sub = (a:V,b:V):V => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot = (a:V,b:V) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const add = (a:V,b:V,t:number):V => [a[0]+b[0]*t,a[1]+b[1]*t,a[2]+b[2]*t];
const cross = (a:V,b:V):V => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const distance = (a:V,b:V) => { const d=sub(a,b);return dot(d,d); };
const clamp = (x:number) => Math.max(0,Math.min(1,x));
function pointTriangle(p:V,a:V,b:V,c:V):number {
  const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
  if(d1<=0&&d2<=0)return distance(p,a);
  const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
  if(d3>=0&&d4<=d3)return distance(p,b);
  const vc=d1*d4-d3*d2;
  if(vc<=0&&d1>=0&&d3<=0)return distance(p,add(a,ab,d1/(d1-d3)));
  const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
  if(d6>=0&&d5<=d6)return distance(p,c);
  const vb=d5*d2-d1*d6;
  if(vb<=0&&d2>=0&&d6<=0)return distance(p,add(a,ac,d2/(d2-d6)));
  const va=d3*d6-d5*d4;
  if(va<=0&&d4-d3>=0&&d5-d6>=0)return distance(p,add(b,sub(c,b),(d4-d3)/(d4-d3+d5-d6)));
  const den=va+vb+vc;
  if(Math.abs(den)<1e-20)return Math.min(distance(p,a),distance(p,b),distance(p,c));
  return distance(p,add(add(a,ab,vb/den),ac,vc/den));
}
function segmentSegment(p:V,q:V,a:V,b:V):number {
  const d1=sub(q,p),d2=sub(b,a),r=sub(p,a),aa=dot(d1,d1),ee=dot(d2,d2),f=dot(d2,r);
  let s=0,t=0;
  if(aa<=1e-12&&ee<=1e-12)return distance(p,a);
  if(aa<=1e-12)t=clamp(f/ee);
  else {
    const c=dot(d1,r);
    if(ee<=1e-12)s=clamp(-c/aa);
    else {
      const bb=dot(d1,d2),den=aa*ee-bb*bb;
      s=den>1e-12?clamp((bb*f-c*ee)/den):0;
      t=(bb*s+f)/ee;
      if(t<0){t=0;s=clamp(-c/aa);}
      else if(t>1){t=1;s=clamp((bb-c)/aa);}
    }
  }
  return distance(add(p,d1,s),add(a,d2,t));
}
export function capsuleHitsTriangle(p:V,q:V,radius:number,a:V,b:V,c:V):boolean {
  const direction=sub(q,p),ab=sub(b,a),ac=sub(c,a),h=cross(direction,ac),det=dot(ab,h);
  if(Math.abs(det)>1e-12){
    const s=sub(p,a),u=dot(s,h)/det,tvec=cross(s,ab),v=dot(direction,tvec)/det,t=dot(ac,tvec)/det;
    if(u>=0&&v>=0&&u+v<=1&&t>=0&&t<=1)return true;
  }
  const rr=radius*radius;
  return pointTriangle(p,a,b,c)<rr || pointTriangle(q,a,b,c)<rr ||
    segmentSegment(p,q,a,b)<rr || segmentSegment(p,q,b,c)<rr || segmentSegment(p,q,c,a)<rr;
}
