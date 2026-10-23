/** Build only; no upload, DNS change or publication. Blender is never invoked. */
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,rename,access} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {root,web,loadRelease,releaseAssets,checkLocalAssets,sha256,assetOrigin,verifyRemoteAssets} from './viewer_release.mjs';
import {verifyWalkingReceipt} from './viewer_walking.mjs';
import {siteSchema,writeSeoPages} from './site_seo.mjs';
const {manifest,text:original,absolute}=await loadRelease();
const frontendOnly=process.argv.includes('--frontend-only');
const origin=assetOrigin(process.env.ASSET_BASE_URL??manifest.assetBaseUrl);
if(frontendOnly&&!origin)throw new Error('ASSET_BASE_URL is required for the frontend-only build');
const production=process.env.SITE_ENV==='production';
let siteOrigin='';
if(production){siteOrigin=assetOrigin(process.env.SITE_ORIGIN);if(!siteOrigin)throw new Error('Production SITE_ORIGIN must be explicit');}
const dist=path.join(root,'dist');
await mkdir(path.join(root,'outputs'),{recursive:true});
async function run(args){await new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`Build failed: ${code}`)));
});}
let assets;
if(frontendOnly){
  await verifyWalkingReceipt(manifest,original);
  const audit=JSON.parse(await readFile(path.join(root,'data/viewer/release-receipt.json'),'utf8'));
  if(audit.manifestSha256!==sha256(original)||audit.sourceModelSha256!==manifest.source.sha256||audit.validation!=='passed')throw new Error('Model manifest has no matching local validation receipt');
  assets=releaseAssets(manifest);
  if(sha256(JSON.stringify(assets))!==audit.assetListSha256)throw new Error('Release resource inventory differs');
  if(process.argv.includes('--verify-remote'))await verifyRemoteAssets(manifest,origin);
}else{
  await run(['scripts/validate_viewer_v3.mjs','--manifest',path.relative(web,absolute)]);
  await run(['scripts/audit_viewer_walking.mjs','--manifest',path.relative(web,absolute)]);
  assets=await checkLocalAssets(manifest);
}
try{await access(dist);await rename(dist,path.join(root,'outputs','site-build-before-'+Date.now()));}catch(e){if(e.code!=='ENOENT')throw e;}
const viteEntry=path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')),'bin/vite.js');
await run([viteEntry,'build','--config','vite.release.config.ts']);
async function copy(relative){const target=path.join(dist,relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(web,relative),target);}
if(!frontendOnly)for(const asset of assets)await copy(asset.url.slice(1));
// An already open page pins its release. Keep the previous release's immutable
// resources available while the newly deployed page starts using new assets.
let previousRelease=null,retainedAssets=0;
if(!frontendOnly){
 let previous=null;
 try{previous=await loadRelease('viewer/previous.json');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(previous){
  if(previous.manifest.release!==manifest.release){
   const oldAssets=await checkLocalAssets(previous.manifest),current=new Set(assets.map(a=>a.url));
   for(const asset of oldAssets)if(!current.has(asset.url)){await copy(asset.url.slice(1));retainedAssets++;}
   await mkdir(path.join(dist,'viewer/releases'),{recursive:true});
   await writeFile(path.join(dist,'viewer/releases',previous.manifest.release+'.json'),previous.text);
   await writeFile(path.join(dist,'viewer/previous.json'),previous.text);previousRelease=previous.manifest.release;
  }
 }
}
for(const relative of ['favicon.svg','favicon-96.png','apple-touch-icon.png','icon-192.png','icon-512.png','site.webmanifest','credits.txt','campus-preview.webp','campus-og.jpg','viewer/basis/basis_transcoder.js','viewer/basis/basis_transcoder.wasm'])await copy(relative);
const deployed={...manifest,assetBaseUrl:frontendOnly?origin:''};
await mkdir(path.join(dist,'viewer/releases'),{recursive:true});
await writeFile(path.join(dist,'viewer/current.json'),JSON.stringify(deployed));
await writeFile(path.join(dist,'viewer/releases',manifest.release+'.json'),JSON.stringify(deployed));
let html=await readFile(path.join(dist,'index.html'),'utf8');
if(production)html=html.replace('content="noindex, nofollow"','content="index, follow, max-image-preview:large"');
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const social=siteOrigin?`${siteOrigin}/campus-og.jpg`:'/campus-og.jpg';
const schema=siteSchema(siteOrigin,social);
const metadata=`<meta property="og:image" content="${escape(social)}" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:alt" content="制作中の天白キャンパス3Dモデル。タワー75前の広場からタワー75を見上げた画像" /><meta name="twitter:image" content="${escape(social)}" />`+
  (siteOrigin?`<link rel="canonical" href="${escape(siteOrigin)}/" /><meta property="og:url" content="${escape(siteOrigin)}/" /><script type="application/ld+json">${JSON.stringify(schema).replaceAll('<','\\u003c')}</script>`:'');
html=html.replace('</head>',metadata+'</head>');await writeFile(path.join(dist,'index.html'),html);
await writeFile(path.join(dist,'robots.txt'),production?`User-agent: *\nAllow: /\nSitemap: ${siteOrigin}/sitemap.xml\n`:'User-agent: *\nDisallow: /\n');
const styleHref=html.match(/<link[^>]+href="([^"\s]+\.css)"[^>]*>/)?.[1];
if(!styleHref)throw new Error('Missing shared page stylesheet');
await writeSeoPages(dist,{origin:siteOrigin,production,styleHref});
await writeFile(path.join(dist,'_headers'),`/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n${production?'':'  X-Robots-Tag: noindex, nofollow\n'}/viewer/current.json\n  Cache-Control: no-cache\n/viewer/releases/*\n  Cache-Control: public, max-age=31536000, immutable\n/viewer/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/viewer/assets/*.hdr\n  Content-Type: image/vnd.radiance\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
if(await readFile(absolute,'utf8')!==original)throw new Error('Release changed during build');
const receipt={revision:manifest.revision,release:manifest.release,sourceModelSha256:manifest.source.sha256,manifestSha256:sha256(original),frontendOnly,
  assetBaseUrl:deployed.assetBaseUrl,assets:assets.length,previousRelease,retainedAssets,uniqueAssetBytes:assets.reduce((n,a)=>n+a.bytes,0),production,indexable:production,output:'dist',published:false,generatedAt:new Date().toISOString()};
await writeFile(path.join(root,'outputs/site-release-build.json'),JSON.stringify(receipt,null,2));
console.log('SITE_BUILD_READY',JSON.stringify(receipt));
