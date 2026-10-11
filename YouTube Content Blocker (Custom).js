// ==UserScript==
// @name         YouTube Content Blocker (Custom)
// @namespace    https://custom-youtube-blocker/
// @description  Hide videos of blacklisted users/channels and comments - Customized via Web UI
// @version      2.2-custom
// @author       DALL'ACQUA Francesco
// @compatible   firefox chrome chromium
// @match        https://www.youtube.com/*
// @exclude      *://*.youtube.com/embed/*
// @exclude      *://*.youtube.com/live_chat*
// @run-at       document-end
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==
/* global GM */

/* jshint esversion: 11, strict: true */
(function(){
'use strict';
try{
  if(typeof window!=='undefined' && window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy){
    window.trustedTypes.createPolicy('default',{createScriptURL:s=>s,createScript:s=>s,createHTML:s=>s});
  }
}catch(_e){}

async function __BYU__main(){
const VER='2.2';
const V={ver:'',comments:'',shorts:'',blocksTxt:'',pendingTxt:'',menuOpen:false,menuPause:false,canonRun:false};
let DEBUG=false; if(typeof window.__BYU_DEBUG==='undefined') window.__BYU_DEBUG=false;
console.info('BYU: script loaded (VER='+VER+')');

V.ver=await GM.getValue('byuver','');
if(!V.ver){
  V.ver=VER; await GM.setValue('byuver',VER);
  if((await GM.getValue('savedblocks',null))===null) await GM.setValue('savedblocks','');
  if((await GM.getValue('savedpending',null))===null) await GM.setValue('savedpending','');
}else if(V.ver!==VER){
  V.ver=VER; await GM.setValue('byuver',VER);
}

V.comments=await GM.getValue('hidecomments','yes');
V.shorts=await GM.getValue('hideshorts','yes');
V.blocksTxt=await GM.getValue('savedblocks','${escapedBlacklist}');
V.pendingTxt=await GM.getValue('savedpending','');
// Storage keys used: byuver, hidecomments, hideshorts, savedblocks, savedpending
let blockedMap=new Map(),blockedIds=new Set(),blockedHandleKeys=new Set(),pendingSet=new Set(),pendingHandleKeys=new Set();
const h2id=new Map(),id2h=new Map(),inFlight=new Map(),idInFlight=new Map(),q=[]; let qRun=0; const QMAX=2;
// Cache: videoId -> {id, handle}. Used for the watch sidebar lockup layout where the channel is shown as plain text.
const v2info=new Map(), vInFlight=new Map();
function videoIdFromScope(scope){
  try{
    const host=(scope && scope.querySelector)? scope.querySelector('.ytLockupViewModelHost,[class*="content-id-"]') : null;
    const cls=(host && host.className)? String(host.className) : '';
    const m=cls.match(/\bcontent-id-([0-9A-Za-z_-]{6,})\b/);
    return m?m[1]:null;
  }catch(e){return null;}
}
async function resolveInfoFromVideoId(videoId){
  if(!videoId) return {id:null,handle:null};
  if(v2info.has(videoId)) return v2info.get(videoId);
  if(vInFlight.has(videoId)) return vInFlight.get(videoId);
  const p=(async()=>{
    try{
      const r=await fetch(`/watch?v=${encodeURIComponent(videoId)}`,{credentials:'same-origin'});
      if(!r.ok) return {id:null,handle:null};
      const html=await r.text();
      const mid=html.match(/"channelId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"/);
      let handle=null;
      const mh=html.match(/"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/(\@[^"\\/]+)"/);
      if(mh) handle=sanH(mh[1]);
      const res={id:mid?mid[1]:null,handle}; v2info.set(videoId,res); return res;
    }catch(e){return {id:null,handle:null};}
  })();
  vInFlight.set(videoId,p); const out=await p; vInFlight.delete(videoId); return out;
}

const lines=t=>t?t.split(/\r?\n/):[];
const decH=h=>{ if(!h) return null; h=String(h).trim(); if(h.startsWith('/@')) h=h.slice(1); if(!h.startsWith('@')) return null; try{return('@'+decodeURIComponent(h.slice(1))).normalize('NFC');}catch(e){return h.normalize?h.normalize('NFC'):h;} };
const sanH=h=>{ h=decH(h); if(!h||!h.startsWith('@')||/\s/.test(h)||/[\/\\]/.test(h.slice(1))) return null; return h.trim(); };
const encPath=h=>{ h=sanH(h); return h?'/@'+encodeURIComponent(h.slice(1)):null; };
const hrefH=href=>{ const m=(href||'').match(/\/(@[^/?#]+)/); return m?sanH(m[1]):null; };
const hrefId=href=>{ const m=(href||'').match(/\/channel\/(UC[0-9A-Za-z_-]{22})/); return m?m[1]:null; };
const hKey=h=>{ h=sanH(h); return h?h.toLocaleLowerCase():null; };
const normText=s=>(s||'').replace(/[\u00A0\u200B\u200C\uFEFF]/gu,' ').replace(/\u200D/gu,'').replace(/\s+/gu,' ').trimStart();
const normName=s=>s?String(s).toLowerCase().replace(/[^a-z0-9]/g,''):'';
function isBlockedByName(displayName){
  const target=normName(displayName);
  if(!target) return false;
  for(const hk of blockedHandleKeys){
    if(normName(hk)===target) return true;
  }
  for(const pk of pendingHandleKeys){
    if(normName(pk)===target) return true;
  }
  return false;
}

function parseB(t){
  const m=new Map();
  for(let s of lines(t)){
    s=s.trim(); if(!s) continue;
    const x=s.match(/^(@\S+)\s+(UC[0-9A-Za-z_-]{22})$/); if(!x) continue;
    const h=sanH(x[1]), id=x[2]; if(h&&!m.has(id)) m.set(id,h);
  }
  return m;
}
function parseP(t){
  const s=new Set();
  for(let r of lines(t)){ r=r.trim(); if(!r||/\s/.test(r)) continue; r=sanH(r); if(r) s.add(r); }
  return s;
}
const serB=m=>Array.from(m.entries()).map(([id,h])=>`${h} ${id}`).join('\n');
const serP=s=>Array.from(s.values()).join('\n');

async function syncLists(){
  V.blocksTxt=serB(blockedMap); V.pendingTxt=serP(pendingSet);
  blockedHandleKeys=new Set(Array.from(blockedMap.values()).map(hKey).filter(Boolean));
  pendingHandleKeys=new Set(Array.from(pendingSet.values()).map(hKey).filter(Boolean));
  await GM.setValue('savedblocks',V.blocksTxt);
  await GM.setValue('savedpending',V.pendingTxt);
  const b=document.getElementById('byu-blacklist'), p=document.getElementById('byu-pending');
  if(b) b.value=V.blocksTxt;
  if(p) p.value=V.pendingTxt;
}
function rebuild(){
  blockedMap=parseB(V.blocksTxt);
  blockedIds=new Set(blockedMap.keys());
  pendingSet=parseP(V.pendingTxt);
  blockedHandleKeys=new Set(Array.from(blockedMap.values()).map(hKey).filter(Boolean));
  pendingHandleKeys=new Set(Array.from(pendingSet.values()).map(hKey).filter(Boolean));
}
rebuild();

const renderersAll=()=>`ytd-rich-item-renderer,ytd-video-renderer,ytd-channel-renderer,ytd-playlist-renderer,ytd-playlist-video-renderer,ytd-playlist-panel-video-renderer,ytd-movie-renderer,ytd-radio-renderer,ytd-compact-video-renderer,ytd-compact-movie-renderer,ytd-compact-radio-renderer,ytd-compact-autoplay-renderer,ytd-compact-playlist-renderer,ytd-grid-video-renderer,ytd-grid-playlist-renderer,yt-lockup-view-model,ytd-video-owner-renderer,ytd-comment-thread-renderer,ytd-comment-view-model,ytd-comment-renderer,ytd-post-renderer,ytd-shared-post-renderer,ytd-backstage-post-renderer,ytd-backstage-post-thread-renderer,yt-post-view-model,yt-shared-post-view-model`;
const renderers=()=>{ const all=renderersAll(); return V.comments?all:all.replace(/,ytd-comment-thread-renderer,ytd-comment-view-model,ytd-comment-renderer$/,''); };
const renderersUnobserved = () => renderersAll().split(',').map(s=>`${s.trim()}:not([data-byu-observed="1"])`).join(',');
const renderersVisible = () => renderers().split(',').map(s=>{ const trim=s.trim(); return (V.comments && trim.includes('comment')) ? trim : `${trim}[data-byu-visible="1"]`; }).join(',');
const userSel=()=>`#metadata > :not([hidden]) #text.ytd-channel-name,#channel-info #text.ytd-channel-name,#channel-title.ytd-channel-renderer span.ytd-channel-renderer,#info #text.ytd-channel-name,#metadata #subscribers.ytd-channel-renderer,#byline.ytd-playlist-panel-video-renderer,/* watch sidebar (compact renderers) */ytd-compact-video-renderer #byline a[href^="/@"],ytd-compact-video-renderer #byline a[href^="/channel/"],ytd-compact-video-renderer #byline #channel-name a[href^="/@"],ytd-compact-video-renderer #byline #channel-name a[href^="/channel/"],ytd-compact-video-renderer #byline #text.ytd-channel-name,ytd-compact-autoplay-renderer #byline a[href^="/@"],ytd-compact-autoplay-renderer #byline a[href^="/channel/"],ytd-compact-autoplay-renderer #byline #channel-name a[href^="/@"],ytd-compact-autoplay-renderer #byline #channel-name a[href^="/channel/"],ytd-compact-autoplay-renderer #byline #text.ytd-channel-name,/* lockup view-model (new watch sidebar) */yt-lockup-view-model yt-content-metadata-view-model .ytContentMetadataViewModelMetadataRow:first-child .ytContentMetadataViewModelMetadataText,yt-lockup-view-model yt-content-metadata-view-model .ytContentMetadataViewModelMetadataRow:first-child .ytAttributedStringHost,yt-lockup-view-model yt-content-metadata-view-model a[href^="/@"],yt-lockup-view-model yt-content-metadata-view-model a[href^="/channel/"],/* new metadata view-models */yt-content-metadata-view-model a[href^="/@"],yt-content-metadata-view-model a[href^="/channel/"],yt-content-metadata-view-model .ytContentMetadataViewModelMetadataRow:first-child .ytContentMetadataViewModelMetadataText,yt-content-metadata-view-model .ytContentMetadataViewModelMetadataRow:first-child .ytAttributedStringHost,yt-content-metadata-view-model .yt-content-metadata-view-model__metadata-row:first-of-type span,.yt-content-metadata-view-model-wiz__metadata-row a[href^="/@"],.yt-content-metadata-view-model-wiz__metadata-row a[href^="/channel/"],.yt-content-metadata-view-model-wiz__metadata-text:first-of-type,#owner #upload-info #channel-name #text.ytd-channel-name${V.comments?',[id*="author"] yt-formatted-string#text[title],#author-text span.ytd-comment-view-model,#name #text.ytd-channel-name':''}`;
const PREHIDE_ID='byu-prehide-css';
const SHORTS_CSS_ID='byu-shorts-css';
function applyShortsCSS(){
  const existing=document.getElementById(SHORTS_CSS_ID);
  if(V.menuPause || !V.shorts){
    if(existing) existing.remove();
    return;
  }
  const css=`
    ytd-reel-shelf-renderer,
    ytd-rich-shelf-renderer[is-shorts],
    ytm-reel-shelf-renderer,
    ytd-shelf-renderer:has(a[href*="/shorts"]),
    ytd-shelf-renderer:has(a[href*="/shorts/"]),
    ytd-shelf-renderer:has([title*="Shorts"]),
    ytd-shelf-renderer:has([title*="shorts"]),
    ytd-shelf-renderer:has([title*="SHORTS"]),
    ytd-rich-shelf-renderer:has(a[href*="/shorts"]),
    ytd-rich-shelf-renderer:has(a[href*="/shorts/"]),
    ytd-rich-shelf-renderer:has([title*="Shorts"]),
    ytd-rich-shelf-renderer:has([title*="shorts"]),
    ytd-rich-shelf-renderer:has([title*="SHORTS"]),
    ytd-rich-section-renderer:has(a[href*="/shorts"]),
    ytd-rich-section-renderer:has(a[href*="/shorts/"]),
    ytd-rich-section-renderer:has([title*="Shorts"]),
    ytd-rich-section-renderer:has([title*="shorts"]),
    ytd-rich-section-renderer:has([title*="SHORTS"]),
    ytd-rich-section-renderer:has(#rich-shelf-header-container [title*="Shorts"]),
    ytd-rich-section-renderer:has(#rich-shelf-header-container [title*="shorts"]),
    ytd-guide-entry-renderer:has(a[href*="/shorts"]),
    ytd-mini-guide-entry-renderer:has(a[href*="/shorts"]),
    ytm-pivot-bar-item-renderer:has(a[href*="/shorts"]),
    ytd-rich-item-renderer:has(a[href*="/shorts/"]),
    ytd-video-renderer:has(a[href*="/shorts/"]),
    ytd-compact-video-renderer:has(a[href*="/shorts/"]),
    ytd-grid-video-renderer:has(a[href*="/shorts/"]),
    yt-lockup-view-model:has(a[href*="/shorts/"]),
    ytm-video-with-context-renderer:has(a[href*="/shorts/"]),
    ytm-shorts-lockup-view-model,
    ytm-shorts-lockup-view-model-v2,
    .ytGridShelfViewModelGridShelfRow:has(ytm-shorts-lockup-view-model-v2),
    .ytGridShelfViewModelGridShelfRow:has(ytm-shorts-lockup-view-model),
    .ytGridShelfViewModelGridShelfRow:has(a[href*="/shorts"]),
    .ytGridShelfViewModelGridShelfRow:has(a[href*="/shorts/"]),
    ytd-shelf-renderer:has(ytm-shorts-lockup-view-model-v2),
    ytd-shelf-renderer:has(ytm-shorts-lockup-view-model),
    ytd-shelf-renderer:has(.reel-item-endpoint),
    ytd-rich-shelf-renderer:has(ytm-shorts-lockup-view-model-v2),
    ytd-rich-shelf-renderer:has(ytm-shorts-lockup-view-model),
    ytd-rich-shelf-renderer:has(.reel-item-endpoint),
    ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2),
    ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model),
    ytd-rich-section-renderer:has(.reel-item-endpoint),
    yt-shelf-view-model:has(ytm-shorts-lockup-view-model-v2),
    yt-shelf-view-model:has(ytm-shorts-lockup-view-model),
    yt-grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2),
    yt-grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
    yt-section-header-view-model:has(path[d*="19.45,3.88"]),
    yt-section-header-view-model:has(path[d*="19.45,3.88"]) + div,
    yt-section-header-view-model:has(path[d*="19.45,3.88"]) + div + div,
    yt-section-header-view-model:has(path[d*="19.45,3.88"]) + div + .ytGridShelfViewModelGridShelfBottomButtonContainer {
      display: none !important;
    }
  `;
  if(!existing){
    document.head.insertAdjacentHTML('beforeend',`<style id="${SHORTS_CSS_ID}">${css}</style>`);
  }else if(existing.textContent!==css){
    existing.textContent=css;
  }
}
function applyPreHideCSS(){
  applyShortsCSS();
  if(V.menuPause){
    // If paused, ensure pre-hide CSS is removed so content doesn't get re-hidden later.
    const st=document.getElementById(PREHIDE_ID);
    if(st) st.remove();
    return;
  }
  const sels=renderers().split(',').map(s=>s.trim()).filter(Boolean);
  const css=sels.map(sel=>`${sel}:not([data-byu-scanned]):not([data-byu-ok]){opacity:0!important;pointer-events:none!important}${sel}[data-byu-pending='1']{opacity:0!important;pointer-events:none!important}`).join('');
  const st=document.getElementById(PREHIDE_ID);
  if(!st){ document.head.insertAdjacentHTML('beforeend',`<style id="${PREHIDE_ID}">${css}</style>`); }
  else st.textContent=css;
}
const failSel='a[href^="/@"],a[href^="/channel/"],.ytd-channel-name a,#channel-name a,#channel-name yt-formatted-string a';
const MH={parent:'#container.ytd-masthead',buttons:'buttons'};

document.head.insertAdjacentHTML('beforeend',`<style>
[data-block="yes"]{display:none!important}
ytd-shelf-renderer:has([data-block="yes"]):not(:has(${renderersAll().split(',').map(s=>s+':not([data-block="yes"])').join(',')})),
ytd-rich-section-renderer:has([data-block="yes"]):not(:has(${renderersAll().split(',').map(s=>s+':not([data-block="yes"])').join(',')})) { display:none!important; margin:0!important; padding:0!important; border:none!important; }


/* Prevent ‘flash’: hide candidates until scanned */
/* (injected by JS) dynamic pre-hide rule will be added below */
.byu-add{display:inline-flex;align-items:center;justify-content:center;position:relative;z-index:10;pointer-events:auto;float:left;margin-right:.4em;cursor:pointer;color:#FF0033!important;background:var(--yt-spec-additive-background);border-radius:50%;font-size:1em;width:1.4em;height:1.4em;line-height:1.4em;text-align:center;font-weight:bold}
/* Removed white override for dark mode to keep it red always */

/* ====== DARK MODE UI FIX ====== */
#byu-icon{display:inline-block;position:relative;text-align:center;width:40px;height:24px;margin:0 8px;font-weight:400;color:var(--yt-spec-text-primary)}
#byu-icon span{color:#000000!important;cursor:pointer;font-size:20px;vertical-align:middle;font-weight:bold;}
html[dark] #byu-icon span, [theme="dark"] #byu-icon span, html[data-theme="dark"] #byu-icon span {color:#ffffff!important;}

#byu-options{
   width:420px;
   max-width:85vw;
   display:flex;
   flex-flow:row wrap;
   align-items:baseline;
   position:fixed;
   right:1em;
   padding:1.2em;
   text-align:center;
   font-size:1.05em;
   color:#ffffff!important;
   background:#1f1f1f!important;
   z-index:2147483647!important;
   border-radius:12px!important;
   box-shadow:0 .3em 2em 0 rgba(0,0,0,0.85)!important;
   border: 2px solid rgba(255,255,255,0.15)!important;
}
#byu-options div{width:33%;flex-grow:1;box-sizing:border-box;padding:.55em;color:#ffffff!important;}
#byu-save{font-weight:700;cursor:pointer;color:#ff0033!important;font-size:1.15em!important;}
#byu-pause{cursor:pointer;color:#aaaaaa!important;font-weight:600;}
#byu-options .ta{width:100%;color:#ffffff!important;}
#byu-options .ta span{width:100%;text-align:center;font-weight:700;color:#ffffff!important;-webkit-user-select:none;user-select:none;}
#byu-options .ta textarea{
   line-height:1.2em;
   resize:vertical;
   width:100%;
   padding:.4em;
   color:#ffffff!important;
   background:#121212!important;
   box-sizing:border-box;
   border: 1px solid rgba(255,255,255,0.25)!important;
   border-radius:8px!important;
   white-space:pre!important;
   overflow-x:auto!important;
   overflow-wrap:normal!important;
   word-break:normal!important;
}
#byu-blacklist,#byu-pending{height:10em}
#byu-options input{
   color:#ffffff!important;
   background:#121212!important;
   border: 1px solid rgba(255,255,255,0.25)!important;
   padding:0 4px;
   height:1.6em;
   line-height:1em;
   vertical-align:middle;
   box-sizing:border-box;
   margin:0;
   border-radius:.4em
}
</style>`);

applyPreHideCSS();
document.body.insertAdjacentHTML('beforeend',`<div id="byu-options" style="display:none; position:fixed; right:1em; width:420px; max-width:85vw; flex-flow:row wrap; align-items:baseline; padding:1.2em; text-align:center; font-size:1.05em; color:#ffffff !important; background:#1f1f1f !important; z-index:2147483647; border-radius:12px; box-shadow:0 .3em 2em 0 rgba(0,0,0,0.85); border:2px solid rgba(255,255,255,0.15); font-family:sans-serif; box-sizing:border-box;">
<div style="width:33%; flex-grow:1; box-sizing:border-box; padding:.55em; color:#ffffff !important;"><span id="byu-save" style="font-weight:700; cursor:pointer; color:#ff0033 !important; font-size:1.15em !important; font-family:sans-serif;">SAVE</span></div>
<div style="width:33%; flex-grow:1; box-sizing:border-box; padding:.55em; color:#ffffff !important;"><span id="byu-pause" style="cursor:pointer; color:#aaaaaa !important; font-weight:600; font-family:sans-serif;">pause</span></div>
<div class="ta" style="width:100%; color:#ffffff !important; box-sizing:border-box; padding:.55em; font-family:sans-serif;">
  <span style="display:block; width:100%; text-align:center; font-weight:700; color:#ffffff !important; margin-bottom:.4em;-webkit-user-select:none; user-select:none;">blacklist (@handle UC...)</span>
  <textarea wrap="off" spellcheck="false" id="byu-blacklist" style="line-height:1.2em; resize:vertical; width:100%; height:10em; padding:.4em; color:#ffffff !important; background:#121212 !important; box-sizing:border-box; border:1px solid rgba(255,255,255,0.25) !important; border-radius:8px !important; white-space:pre !important; overflow-x:auto !important; overflow-wrap:normal !important; word-break:normal !important; font-family:monospace !important; font-size:12px !important;">${esc(V.blocksTxt)}</textarea>
</div>
<div class="ta" style="width:100%; color:#ffffff !important; box-sizing:border-box; padding:.55em; font-family:sans-serif;">
  <span style="display:block; width:100%; text-align:center; font-weight:700; color:#ffffff !important; margin-bottom:.4em;-webkit-user-select:none; user-select:none;">pending handles (@handle)</span>
  <textarea wrap="off" spellcheck="false" id="byu-pending" style="line-height:1.2em; resize:vertical; width:100%; height:10em; padding:.4em; color:#ffffff !important; background:#121212 !important; box-sizing:border-box; border:1px solid rgba(255,255,255,0.25) !important; border-radius:8px !important; white-space:pre !important; overflow-x:auto !important; overflow-wrap:normal !important; word-break:normal !important; font-family:monospace !important; font-size:12px !important;">${esc(V.pendingTxt)}</textarea>
</div>
<div title="hide comments & shorts" style="width:100%; text-align:center; padding:.55em; color:#ffffff !important; font-family:sans-serif;-webkit-user-select:none; user-select:none; display:flex; justify-content:center; gap:20px;">
  <label style="cursor:pointer;"><input id="byu-hidecomments" type="checkbox" ${V.comments?'checked':''} style="color:#ffffff !important; background:#121212 !important; border:1px solid rgba(255,255,255,0.25) !important; vertical-align:middle; margin-right:4px;"> comments</label>
  <label style="cursor:pointer;"><input id="byu-hideshorts" type="checkbox" ${V.shorts?'checked':''} style="color:#ffffff !important; background:#121212 !important; border:1px solid rgba(255,255,255,0.25) !important; vertical-align:middle; margin-right:4px;"> block shorts</label>
</div>
</div>`);

const btn=document.createElement('div');
btn.id='byu-icon';
btn.innerHTML='<span>B</span>';

const waitBtn=setInterval(()=>{
  const b=document.getElementById(MH.buttons);
  if(!b) return;
  clearInterval(waitBtn);
  b.insertAdjacentElement('beforebegin',btn);
  const m=document.querySelector(MH.parent);
  if(m) document.head.insertAdjacentHTML('beforeend',`<style>#byu-options{top:${m.offsetHeight}px}</style>`);
},1000);

btn.addEventListener('click',openMenu);
document.addEventListener('keydown',e=>{ if(e.ctrlKey&&e.altKey&&e.key==='b') openMenu(); });

function openMenu(){
  const o=document.getElementById('byu-options');
  if(!o) return;
  const isHidden = o.style.display === 'none';
  o.style.display = isHidden ? 'flex' : 'none';
  btn.style.fontWeight = isHidden ? '700' : '400';
  V.menuOpen = isHidden;
  if(V.menuOpen && !V.menuPause){ scheduleScan(true); canonicalizeAll(250); }
}

document.getElementById('byu-save').addEventListener('click',async function(){
  if(V.menuPause) return;
  V.comments=document.getElementById('byu-hidecomments').checked?'yes':'';
  V.shorts=document.getElementById('byu-hideshorts').checked?'yes':'';
  blockedMap=parseB(document.getElementById('byu-blacklist').value||'');
  blockedIds=new Set(blockedMap.keys());
  pendingSet=parseP(document.getElementById('byu-pending').value||'');
  blockedHandleKeys=new Set(Array.from(blockedMap.values()).map(hKey).filter(Boolean));

  await syncLists();

  await GM.setValue('hidecomments',V.comments);
  await GM.setValue('hideshorts',V.shorts);
  // If comments filtering was turned off, immediately unhide and mark comment renderers as OK.
  applyPreHideCSS();
  if(!V.comments){
    document.querySelectorAll('ytd-comment-thread-renderer,ytd-comment-view-model,ytd-comment-renderer').forEach(el=>{
      if(!el.dataset) return;
      setBlockAttribute(el, false);
      el.dataset.byuPending='';
      el.dataset.byuScanned='1';
    });
  }


  this.textContent='SAVED';
  scheduleScan(true);
  canonicalizeAll(250);
  setTimeout(()=>this.textContent='SAVE',1500);
});

document.getElementById('byu-pause').addEventListener('click',function(){
  V.menuPause=!V.menuPause;
  if(V.menuPause){
    // Pause means: stop filtering AND stop pre-hide; mark everything as OK so new nodes remain visible.
    document.querySelectorAll(renderersAll()).forEach(el=>{
      if(!el.dataset) return;
      setBlockAttribute(el, false);
      el.dataset.byuPending='';
      el.dataset.byuScanned='1';
    });
    applyPreHideCSS();
    this.textContent='paused';
  }else{
    document.querySelectorAll(renderersAll()).forEach(el=>{
      if(!el.dataset) return;
      delete el.dataset.byuOk;
      delete el.dataset.byuScanned;
      delete el.dataset.byuPending;
      delete el.dataset.block;
    });
    applyPreHideCSS();
    scheduleScan(true);
    this.textContent='pause';
  }
});


const isComment=el=>el?.matches?.('ytd-comment-view-model,ytd-comment-renderer');
const isThread=el=>el?.matches?.('ytd-comment-thread-renderer');

const visibleRenderers = new Set();

const io = new IntersectionObserver((entries) => {
  if (V.menuPause) return;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const el = entry.target;
    if (entry.isIntersecting) {
      if (!el.dataset.byuVisible) {
        el.dataset.byuVisible = '1';
        visibleRenderers.add(el);
        try { findMatch(el); } catch(err){}
      }
    } else {
      if (el.dataset.byuVisible) {
        delete el.dataset.byuVisible;
        visibleRenderers.delete(el);
      }
    }
  }
}, { rootMargin: '300px' });

function observeNewElements(container = document) {
  if (V.menuPause) return;
  const elements = container.querySelectorAll ? container.querySelectorAll(renderersUnobserved()) : [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.dataset && !el.dataset.byuObserved) {
      el.dataset.byuObserved = '1';
      io.observe(el);
      try { findMatch(el); } catch(err){}
    }
  }
}

function search(changed=false){
  if(V.menuPause) return;

  if (changed) {
    // If changed, scan everything just in case some hidden elements need to be unblocked
    const elements = document.querySelectorAll(renderers());
    for (let i = 0; i < elements.length; i++) {
      try { findMatch(elements[i], changed); } catch(_e){}
    }
  } else {
    // Fast path: only scan currently visible stuff tracked by IntersectionObserver
    visibleRenderers.forEach(el => {
      try { findMatch(el, changed); } catch(_e){}
    });
  }
}

  // We removed resetMarks function completely
let scanT=0,scanSeq=0;
function scheduleScan(changed=false){
  if(V.menuPause) return;
  clearTimeout(scanT);
  const seq=++scanSeq;
  scanT=setTimeout(()=>{

    applyPreHideCSS();
    search(changed);
    setTimeout(()=>{ if(seq===scanSeq) search(false); },100);
    setTimeout(()=>{
      if(seq===scanSeq) {
        search(false);

        // Clean up empty containers that CSS might miss (e.g., hidden by uBlock or containing only blocked items)
        document.querySelectorAll('ytd-shelf-renderer, ytd-rich-section-renderer, grid-shelf-view-model, ytd-search-pyv-renderer').forEach(container => {
          const contents = container.querySelector('#contents') || container;
          if (!contents || contents.children.length === 0) return;

          let hasVisibleChild = false;
          for (let child of contents.children) {
            if (child.hasAttribute('data-block')) continue;
            // Some elements might be explicitly hidden by other extensions or YouTube
            const style = window.getComputedStyle(child);
            if (style.display !== 'none' && style.visibility !== 'hidden' && child.offsetHeight > 0) {
              hasVisibleChild = true;
              break;
            }
          }

          if (!hasVisibleChild) {
            container.style.display = 'none';
          } else {
            container.style.display = '';
          }
        });
      }
    },400);
  },50);
}
function setupObserver(){
  const want=renderersAll();
  const csel='ytd-comment-thread-renderer,ytd-comment-view-model,ytd-comment-renderer';
  const vsel='ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer,yt-lockup-view-model,ytd-playlist-video-renderer,ytd-playlist-panel-video-renderer';

  observeNewElements(); // Initial scan

  const obs=new MutationObserver(muts=>{
    if(V.menuPause) return;
    let needScan=false;
    let newlyAdded = [];

    for(const m of muts){
      for(const n of m.addedNodes){
        if(!(n instanceof Element)) continue;
        if(n.matches?.(want)) { newlyAdded.push(n); needScan=true; }
        else if (n.querySelector) {
          const found = n.querySelectorAll(want);
          if (found.length > 0) {
            for(let k=0; k<found.length; k++) newlyAdded.push(found[k]);
            needScan=true;
          }
        }
      }
      if(m.target && typeof m.target.closest === 'function'){
         if(m.target.closest(want)){ needScan=true; }
      }
    }

    if (newlyAdded.length > 0) {
      for (const el of newlyAdded) {
        if (el.dataset && !el.dataset.byuObserved) {
          el.dataset.byuObserved = '1';
          io.observe(el);
          try { findMatch(el); } catch(err){}
        }
      }
    }

    if(needScan) {
      scheduleScan(false);
    }
  });
  obs.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href','src','aria-label']});
}

// extractInfo(scope): best-effort extraction of {id, handle} from a renderer/comment card.
function extractInfo(scope){
  let id=null, handle=null;
  // 1) Post and Comment extraction (author links in header)
  if(true){
    const a=scope.querySelector('#author-text a[href^="/@"],a#author-text[href^="/@"],#author-thumbnail a[href^="/@"],#author-text a[href^="/channel/"],a#author-text[href^="/channel/"],#author-thumbnail a[href^="/channel/"],#header-author a[href^="/@"],#header-author a[href^="/channel/"],#author-header a[href^="/@"],#author-header a[href^="/channel/"], ytd-channel-name a, #channel-name a');
    if(a?.getAttribute){
      const href=a.getAttribute('href')||'';
      handle=hrefH(href)||handle;
      id=hrefId(href)||id;
    }
  }

  if(!handle){
    const avatarBtn=(scope && scope.querySelector)? scope.querySelector('yt-avatar-shape [aria-label],#avatar [aria-label],ytd-channel-name [aria-label]') : null;
    const al=avatarBtn && avatarBtn.getAttribute ? (avatarBtn.getAttribute('aria-label')||'') : '';
    const mh=al.match(/@[^\s]+/);
    const hh=mh?sanH(mh[0]):null; if(hh) handle=hh;
  }
  // 3) Generic fallback: pick the first channel link inside metadata (works for yt-lockup-view-model too)
  if(!id){ const a=(scope && scope.querySelector)? scope.querySelector('yt-content-metadata-view-model a[href^="/channel/UC"],a[href^="/channel/UC"],a[href*="youtube.com/channel/UC"]') : null; if(a && a.getAttribute) id=hrefId(a.getAttribute('href')||'')||id; }
  if(!handle){ const a=(scope && scope.querySelector)? scope.querySelector('yt-content-metadata-view-model a[href^="/@"],a[href^="/@"],a[href*="youtube.com/@"]') : null; if(a && a.getAttribute) handle=hrefH(a.getAttribute('href')||'')||handle; }
  if(!id){
    const a=[...scope.querySelectorAll('a[href^="/channel/UC"],a[href*="youtube.com/channel/UC"]')].find(x=>{
      const c=x.closest?.('yt-formatted-string#content-text,#content-text,.yt-core-attributed-string,ytd-expander,.ytd-expander');
      const r=x.closest?.('#replying-to,[id*="replying"],[class*="replying"],[class*="reply-to"],[id*="reply-to"]');
      return !c&&!r;
    });
    if(a?.getAttribute) id=hrefId(a.getAttribute('href')||'')||id;
  }

  if(!handle){
    const a=[...scope.querySelectorAll('a[href^="/@"],a[href*="youtube.com/@"]')].find(x=>{
      const c=x.closest?.('yt-formatted-string#content-text,#content-text,.yt-core-attributed-string,ytd-expander,.ytd-expander');
      const r=x.closest?.('#replying-to,[id*="replying"],[class*="replying"],[class*="reply-to"],[id*="reply-to"]');
      return !c&&!r;
    });
    if(a?.getAttribute) handle=hrefH(a.getAttribute('href')||'')||handle;
  }
  // Last resort (YouTube search/home layouts): grab the first matching channel link inside the card.
  if(!id){ const a=(scope && scope.querySelector)? scope.querySelector('a[href^="/channel/UC"],a[href*="youtube.com/channel/UC"]') : null; if(a && a.getAttribute) id=hrefId(a.getAttribute('href')||'')||id; }
  if(!handle){ const a=(scope && scope.querySelector)? scope.querySelector('a[href^="/@"],a[href*="youtube.com/@"]') : null; if(a && a.getAttribute) handle=hrefH(a.getAttribute('href')||'')||handle; }

  return {id,handle};
}

function infoFor(el){
  const info=extractInfo(el);
  if((!info.handle||!info.id)){
    const a=el.querySelector(failSel);
    if(a?.getAttribute){
      const href=a.getAttribute('href')||'';
      info.handle=info.handle||hrefH(href);
      info.id=info.id||hrefId(href);
    }
  }

  if(!info.handle&&!info.id){
    const a=el.querySelector('yt-content-metadata-view-model a[href^="/@"],yt-content-metadata-view-model a[href^="/channel/"],.yt-content-metadata-view-model-wiz__metadata-row a[href^="/@"],.yt-content-metadata-view-model-wiz__metadata-row a[href^="/channel/"],#byline a[href^="/@"],#byline a[href^="/channel/"],a[href^="/@"]:not([href*="/watch"]),a[href^="/channel/"]');
    if(a?.getAttribute){
      const href=a.getAttribute('href')||'';
      info.handle=info.handle||hrefH(href);
      info.id=info.id||hrefId(href);
    }
  }

  return info;
}

function commentAuthorInfo(commentEl){
  if(!commentEl) return {id:null,handle:null};
  let id=null, handle=null;
  // Shorts comments often expose the channel id directly
  if(!commentEl.hasAttribute?.('is-reply')){
    // Shorts top-level comments often expose the channel id directly. Replies may NOT.
    const directId=commentEl.getAttribute?.('data-channel-id') || commentEl.dataset?.channelId || '';
    if(/^UC[0-9A-Za-z_-]{22}$/.test(directId)) id=directId;
  }
  const header=commentEl.querySelector?.('#header-author')||commentEl;
  const a=header.querySelector?.('a#author-text[href^="/@"],a#author-text[href^="/channel/"],#author-text a[href^="/@"],#author-text a[href^="/channel/"]');
  if(a?.getAttribute){
    const href=a.getAttribute('href')||'';
    id=hrefId(href)||id;
    handle=hrefH(href)||handle;
  }
  if(!handle){
    const ab=commentEl.querySelector?.('#author-thumbnail-button[aria-label],#author-thumbnail-button[aria-label^="@"],#author-thumbnail #author-thumbnail-button[aria-label]');
    const al=ab && ab.getAttribute ? (ab.getAttribute('aria-label')||'') : '';
    const m=al.match(/@[^\s]+/);
    const hh=m?sanH(m[0]):null;
    if(hh) handle=hh;
  }
  if(DEBUG||window.__BYU_DEBUG) console.log('BYU commentAuthorInfo', {id,handle}, commentEl);
  return {id,handle};
}
function purgeHiddenElement(el) {
  if (!el) return;
  const addBtn = el.querySelector?.('.byu-add');
  if (addBtn) {
    addBtn.__byuScope = null;
    addBtn.remove();
  }
  if (typeof io !== 'undefined' && io && typeof io.unobserve === 'function') {
    io.unobserve(el);
  }
  visibleRenderers.delete(el);
  if (el.dataset) {
    delete el.dataset.byuObserved;
    delete el.dataset.byuVisible;
  }
  const imgs = el.querySelectorAll?.('img');
  if (imgs) {
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.src && !img.__byuOrigSrc) {
        img.__byuOrigSrc = img.src;
      }
      if (img.srcset && !img.__byuOrigSrcset) {
        img.__byuOrigSrcset = img.srcset;
      }
      img.src = '';
      img.removeAttribute('src');
      img.srcset = '';
      img.removeAttribute('srcset');
    }
  }
  const videos = el.querySelectorAll?.('video');
  if (videos) {
    for (let i = 0; i < videos.length; i++) {
      try {
        videos[i].pause();
        videos[i].src = '';
        videos[i].removeAttribute('src');
        videos[i].load();
      } catch(_) {}
    }
  }
  const iframes = el.querySelectorAll?.('iframe');
  if (iframes) {
    for (let i = 0; i < iframes.length; i++) {
      try {
        iframes[i].src = 'about:blank';
        iframes[i].removeAttribute('src');
      } catch(_) {}
    }
  }
}

function restoreHiddenElement(el) {
  if (!el) return;
  const imgs = el.querySelectorAll?.('img');
  if (imgs) {
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.__byuOrigSrc) {
        img.src = img.__byuOrigSrc;
        delete img.__byuOrigSrc;
      }
      if (img.__byuOrigSrcset) {
        img.srcset = img.__byuOrigSrcset;
        delete img.__byuOrigSrcset;
      }
    }
  }
}

function setBlockAttribute(el, isBlocked) {
  if (isBlocked) {
    el.dataset.block = 'yes';
    if (el.dataset.byuOk) el.dataset.byuOk = '';
    purgeHiddenElement(el);
  } else {
    if (el.dataset.block === 'yes') {
      restoreHiddenElement(el);
    }
    if (el.dataset.block) el.dataset.block = '';
    if (el.dataset.byuBlockTree) el.dataset.byuBlockTree = '';
    el.dataset.byuOk = '1';
  }
}

function setBlocked(el,id) {
  if(V.menuPause) return;
  // mark as processed to avoid initial flash
  el.dataset.byuScanned='1';
  const isBlocked = (id && blockedIds.has(id)) || id === 'pending-blocked' || id === 'name-blocked';
  setBlockAttribute(el, isBlocked);
}

function replyTargetH(el){
  if(!el) return null;
  for(const c of el.querySelectorAll('#replying-to,[id*="replying"],[class*="replying"],[class*="reply-to"],[id*="reply-to"]')){
    const a=c.querySelector?.('a[href^="/@"]');
    if(!a?.getAttribute) continue;
    if(a.closest?.('yt-formatted-string#content-text,#content-text')) continue;
    const h=hrefH(a.getAttribute('href')||'');
    if(h) return h;
  }
  return null;
}

function commentTextRoot(el){
  return el?.querySelector?.('#content-text,yt-attributed-string#content-text,.yt-core-attributed-string,#expander #content-text')||null;
}

function firstWordHandle(el){
  const root=commentTextRoot(el);
  if(!root) return null;
  const t=normText(root.textContent||'');
  if(!t) return null;
  const m=t.match(/^(@[^\s.,:;!?()[\]{}]{2,})/u);
  return m?sanH(m[1]):null;
}

function hideComment(el,propagate=true){
  const th=el.closest?.('ytd-comment-thread-renderer');
  const top=th?.querySelector?.('ytd-comment-view-model,ytd-comment-renderer');
  if(th&&top===el){ th.dataset.byuScanned='1'; th.dataset.byuPending=''; th.dataset.byuOk=''; setBlockAttribute(th, true); }
  else { el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk=''; setBlockAttribute(el, true); }
  if(propagate) markDescendantsBlocked(el);
}
function markDescendantsBlocked(commentEl){
  const base=commentEl?.closest?.('ytd-comment-view-model,ytd-comment-renderer')||commentEl;
  if(!base) return;
  base.dataset.byuBlockTree='1';
  const th=base.closest?.('ytd-comment-thread-renderer');
  const top=th?.querySelector?.('ytd-comment-view-model,ytd-comment-renderer');
  if(th && top===base) th.dataset.byuBlockTree='1';
}
function hasBlockedAncestor(commentEl){
  const base=commentEl?.closest?.('ytd-comment-view-model,ytd-comment-renderer')||commentEl;
  if(!base) return false;
  const anc=base.parentElement?.closest?.('[data-byu-block-tree="1"]');
  return !!anc;
}
function applyCommentRules(el){
  if(V.menuPause) return;
  if(!V.comments||!isComment(el)) return;
  if(hasBlockedAncestor(el)) return hideComment(el,false);
  const h=firstWordHandle(el);
  const k=hKey(h);
  if(k&&(blockedHandleKeys.has(k)||pendingHandleKeys.has(k))) return hideComment(el,true);
  const info=el.hasAttribute?.('is-reply')?commentAuthorInfo(el):infoFor(el);
  if(info.handle){ const hk0=hKey(info.handle); if(hk0&&pendingHandleKeys.has(hk0)) return hideComment(el,true); }
  if(info.id&&blockedIds.has(info.id)) return hideComment(el,true);
  if(info.handle){
    const hk=hKey(info.handle);
    if(hk&&(blockedHandleKeys.has(hk)||pendingHandleKeys.has(hk))){
      hideComment(el,true);
      if(pendingHandleKeys.has(hk)){
        resolveId(info.handle).then(id=>{
          if(!id) return;
          let foundPending=null;
          for(const p of pendingSet){
            if(hKey(p)===hk){ foundPending=p; break; }
          }
          if(foundPending){
            addBlockedId(id,foundPending);
            pendingSet.delete(foundPending);
            syncLists();
          }
        });
      }
      return;
    }
  }
  // Shorts replies: the DOM can expose a thread-level channel id, so resolve the reply author's id via handle.
  if(el.hasAttribute?.('is-reply') && info.handle){
    const hk=hKey(info.handle);
    if(hk && (blockedHandleKeys.has(hk) || pendingHandleKeys.has(hk))){
      el.dataset.byuScanned='1';
      el.dataset.byuPending='1';
      resolveId(info.handle).then(id=>{
        if(V.menuPause) return;
        el.dataset.byuPending='';
        if(id && blockedIds.has(id)) hideComment(el,true);
        else el.dataset.byuOk='1';
      });
    } else {
      el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1';
    }
    return;
  }
  const rt=replyTargetH(el);
  if(rt){
    const rtk=hKey(rt);
    if(rtk&&(blockedHandleKeys.has(rtk)||pendingHandleKeys.has(rtk))){
      el.dataset.byuScanned='1';
      el.dataset.byuPending='1';
      resolveId(rt).then(id=>{ if(V.menuPause) return; el.dataset.byuPending=''; if(id&&blockedIds.has(id)) hideComment(el,true); else el.dataset.byuOk='1'; });
    } else {
      el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1';
    }
    return;
  }
  // If not blocked by any rule, explicitly mark as scanned+ok so pre-hide CSS won't hide it.
  if(!info.id && !info.handle && !h && !rt){
    el.__byuAttempts = (el.__byuAttempts || 0) + 1;
    if(el.__byuAttempts < 8){
      setTimeout(() => { if(document.body.contains(el)) try{ findMatch(el); }catch(e){} }, 500);
      return;
    }
  }
  setBlockAttribute(el, false);
  el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1';
}

function addBlockedId(id,h){
  if(!id) return;
  if(!blockedMap.has(id)){
    h=sanH(h)||'@UNKNOWN';
    blockedMap.set(id,h);
    blockedIds.add(id);
    if(h!=='@UNKNOWN') blockedHandleKeys.add(hKey(h));
    syncLists();
    canonicalizeId(id);
  }else{
    canonicalizeId(id);
  }
}

function findMatch(el,changed){
  // Check recycling FIRST: if the element got recycled by YouTube Virtual List, reset its scanned state
  const actualInfo = isComment(el)
    ? commentAuthorInfo(el)
    : (isThread(el)
        ? (() => {
            const top = el.querySelector?.('ytd-comment-view-model,ytd-comment-renderer');
            return top ? infoFor(top) : {id:null,handle:null};
          })()
        : infoFor(el));
  if (el.__byuLastId !== actualInfo.id || el.__byuLastHandle !== actualInfo.handle) {
    if (typeof io !== 'undefined' && io && typeof io.unobserve === 'function') {
      io.unobserve(el);
    }
    visibleRenderers.delete(el);
    setBlockAttribute(el, false);
    if (el.dataset) {
      delete el.dataset.byuOk;
      delete el.dataset.byuScanned;
      delete el.dataset.byuPending;
      delete el.dataset.byuBlockTree;
      delete el.dataset.channelId;
      delete el.dataset.byuObserved;
      delete el.dataset.byuVisible;
    }
    const oldBtn = el.querySelector?.('.byu-add');
    if (oldBtn) oldBtn.remove();
    el.__byuLastId = actualInfo.id;
    el.__byuLastHandle = actualInfo.handle;
    el.__byuAttempts = 0;
  }

  // Optimize: If already scanned and there are no blacklist changes, skip entirely to avoid heavy layout thrashing of repeated querySelector calls.
  if (el.dataset && el.dataset.byuScanned === '1' && !changed) {
    return;
  }

  // Add “x” button (optional)
  const canAdd=true;
  let userEl=el.querySelector?.(userSel())||el.querySelector?.(failSel);
  if(!userEl) userEl=el.querySelector?.('a[href^="/@"],a[href^="/channel/"]')||null;
  if(canAdd&&userEl&&!el.querySelector?.('.byu-add')){
    const b=document.createElement('span');
    b.className='byu-add';
    b.textContent='X';
    b.title='Add to blacklist';
    // Store the originating renderer on the button (so clicks in the sidebar always resolve the correct scope)
    b.__byuScope=el;
    // Use event delegation (registered on document) to handle clicks, contextmenus, and pointerdowns with zero leaks
    if(window.__BYU_DEBUG) console.log('BYU X button added', b, 'scope', el);
    // IMPORTANT: for comments (especially Shorts), insert the X inside this comment's own header,
    // otherwise YouTube DOM recycling can make the button belong to a different comment.
    if(isComment(el)){
      const header=el.querySelector?.('#header-author h3')||el.querySelector?.('#header-author')||userEl;
      if(header && typeof header.prepend==='function') header.prepend(b);
    }else{
const anchor=userEl.closest?.('ytd-channel-name,#channel-name,#byline,yt-content-metadata-view-model,.ytContentMetadataViewModelMetadataRow')||userEl.parentElement||userEl;
      const tag=(anchor?.tagName||'').toLowerCase();
      if(tag==='a') anchor.insertAdjacentElement('beforebegin',b); else if(anchor && typeof anchor.prepend==='function') anchor.prepend(b);
    }
  }
  if(isComment(el)){ applyCommentRules(el); return; }
  if(V.menuPause) return;
  const cachedId=el.dataset.channelId||'';
  if(!cachedId || changed){
    if(isThread(el)){
      const top=el.querySelector?.('ytd-comment-view-model,ytd-comment-renderer');
      if(!top) {
        el.__byuAttempts = (el.__byuAttempts || 0) + 1;
        if(el.__byuAttempts < 8){
          setTimeout(() => { if(document.body.contains(el)) try{ findMatch(el); }catch(e){} }, 500);
          return;
        }
        el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1'; return;
      }
      const info=infoFor(top);
      if(info.id){ el.dataset.channelId=info.id; setBlocked(el,info.id); if(blockedIds.has(info.id)) canonicalizeId(info.id); return; }
      if(V.menuPause) return;
      if(info.handle){
        const hk=hKey(info.handle);
        if(hk && (blockedHandleKeys.has(hk) || pendingHandleKeys.has(hk))){
          setBlocked(el,'pending-blocked');
          resolveId(info.handle).then(id=>{
            el.dataset.byuPending='';
            if(!id) return;
            el.dataset.channelId=id;
            setBlocked(el,id);
            let foundPending=null;
            for(const p of pendingSet){
              if(hKey(p)===hk){ foundPending=p; break; }
            }
            if(foundPending){
              addBlockedId(id,foundPending);
              pendingSet.delete(foundPending);
              syncLists();
            }
            if(blockedIds.has(id)) canonicalizeId(id);
          });
        } else {
          el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1';
        }
        return;
      }

      el.__byuAttempts = (el.__byuAttempts || 0) + 1;
      if(el.__byuAttempts < 8){
        setTimeout(() => { if(document.body.contains(el)) try{ findMatch(el); }catch(e){} }, 500);
        return;
      }
      // Unknown thread owner: mark ok so pre-hide does not blank out the UI
      el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1'; return;
    }
    const info=infoFor(el);
    if(info.id){ el.dataset.channelId=info.id; setBlocked(el,info.id); if(blockedIds.has(info.id)) canonicalizeId(info.id); return; }
    if(V.menuPause) return;
    if(info.handle){
      const hk=hKey(info.handle);
      if(hk && (blockedHandleKeys.has(hk) || pendingHandleKeys.has(hk))){
        setBlocked(el,'pending-blocked');
        resolveId(info.handle).then(id=>{
          el.dataset.byuPending='';
          if(!id) return;
          el.dataset.channelId=id;
          setBlocked(el,id);
          let foundPending=null;
          for(const p of pendingSet){
            if(hKey(p)===hk){ foundPending=p; break; }
          }
          if(foundPending){
            addBlockedId(id,foundPending);
            pendingSet.delete(foundPending);
            syncLists();
          }
          if(blockedIds.has(id)) canonicalizeId(id);
        });
      } else {
        el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1';
      }
      return;
    }

    // No ID/handle in DOM format. Check Display Name and Video ID!
    const displayName = userEl ? (userEl.textContent || '').trim() : '';
    if (displayName && isBlockedByName(displayName)) {
      setBlocked(el, 'name-blocked');
      // Resolve video ID in background if present to sync ID to cache
      const vid = videoIdFromScope(el);
      if (vid) {
        resolveInfoFromVideoId(vid).then(vinfo => {
          if (vinfo?.id) {
            el.dataset.channelId = vinfo.id;
            addBlockedId(vinfo.id, vinfo.handle || displayName);
          }
        });
      }
      return;
    }

    const vid = videoIdFromScope(el);
    if (vid) {
      if (el.dataset.byuPending === '1') return; // already resolving
      el.dataset.byuPending = '1';
      resolveInfoFromVideoId(vid).then(vinfo => {
        el.dataset.byuPending = '';
        if (!vinfo) {
          el.dataset.byuScanned = '1'; el.dataset.byuOk = '1';
          return;
        }
        if (vinfo.id) el.dataset.channelId = vinfo.id;
        const isBlocked = (vinfo.id && blockedIds.has(vinfo.id)) ||
                          (vinfo.handle && (blockedHandleKeys.has(hKey(vinfo.handle)) || pendingHandleKeys.has(hKey(vinfo.handle))));
        if (isBlocked) {
          if (vinfo.id) {
            setBlocked(el, vinfo.id);
            canonicalizeId(vinfo.id);
          } else {
            setBlocked(el, 'pending-blocked');
          }
        } else {
          el.dataset.byuScanned = '1'; el.dataset.byuOk = '1';
        }
      });
      return;
    }

    el.__byuAttempts = (el.__byuAttempts || 0) + 1;
    if(el.__byuAttempts < 8){
      setTimeout(() => { if(document.body.contains(el)) try{ findMatch(el); }catch(e){} }, 500);
      return;
    }
    // Unknown owner: mark ok so pre-hide does not hide unrelated content (e.g., Shorts shelves)
    el.dataset.byuScanned='1'; el.dataset.byuPending=''; el.dataset.byuOk='1'; return;
  } else {
    setBlocked(el,cachedId);
  }
}
// callAddToBlacklist(): internal helper used by delegated handlers to invoke addToBlacklist() without relying on the original DOM event object.
function callAddToBlacklist(btn,type,ev){
  try{
    if(ev){ ev.preventDefault(); if(typeof ev.stopImmediatePropagation==='function') ev.stopImmediatePropagation(); ev.stopPropagation(); }
    addToBlacklist({preventDefault:()=>{},stopPropagation:()=>{},currentTarget:btn,type});
  }catch(err){ console.error('BYU callAddToBlacklist ERROR', err); }
}
// addToBlacklist(): called when the user clicks the “x” badge next to a channel name. It resolves the channel (handle and/or UC id), stores it, and triggers a rescan so matching videos/comments are hidden.
function addToBlacklist(e){
  if(V.menuPause) return;
  try{
    e.preventDefault();
    e.stopPropagation();
    const btn=e.currentTarget;
    if(!btn) return;
    const scope=btn.__byuScope || btn.closest('ytd-comment-view-model,ytd-comment-renderer') || btn.closest(renderersAll());
    if(DEBUG||window.__BYU_DEBUG) console.log('BYU addToBlacklist click', {btn, scope});
    if(!scope) return;
    const info=isComment(scope)?commentAuthorInfo(scope):infoFor(scope);
    if(isComment(scope)&&info.handle){ const handle=sanH(info.handle); const hk=hKey(handle); if(!handle||!hk) return; pendingSet.add(handle); pendingHandleKeys.add(hk); syncLists(); document.querySelectorAll('ytd-comment-view-model,ytd-comment-renderer').forEach(el=>{ try{ const ci=commentAuthorInfo(el); const eh=ci&&ci.handle?hKey(ci.handle):null; if(eh&&eh===hk) hideComment(el,true); }catch(_e){} }); scheduleScan(false); fetchId(handle).then(id=>{ if(V.menuPause) return; if(!id) return; h2id.set(handle,id); let foundPending=null; for(const p of pendingSet){ if(hKey(p)===hk){ foundPending=p; break; } } if(foundPending) pendingSet.delete(foundPending); pendingHandleKeys.delete(hk); blockedMap.set(id,handle); blockedIds.add(id); blockedHandleKeys.add(hk); syncLists(); scheduleScan(true); }); return; }
    if(DEBUG||window.__BYU_DEBUG) console.log('BYU addToBlacklist resolved', info);
    // Replies in Shorts can carry a thread-level data-channel-id, so do not trust id for replies.
    const isReply=!!(isComment(scope) && scope.hasAttribute?.('is-reply'));
    if(isReply) info.id=null;
    if(isComment(scope) && !isReply && !info.id){
      const cid=(scope && typeof scope.getAttribute==='function' ? (scope.getAttribute('data-channel-id')||'') : ((scope.dataset && scope.dataset.channelId)||''));
      if(/^UC[0-9A-Za-z_-]{22}$/.test(cid)) info.id=cid;
    }
    // Watch sidebar lockup layout: the channel can be plain text (no /@ or /channel link). In that case, derive the channel from the videoId.
    if(!info.id && !info.handle && scope && scope.matches && scope.matches('yt-lockup-view-model')){
      const vid=videoIdFromScope(scope);
      if(vid){ scope.dataset.byuScanned='1'; scope.dataset.byuPending='1';
        resolveInfoFromVideoId(vid).then(vinfo=>{
          if(V.menuPause) return; scope.dataset.byuPending='';
          const finalId=vinfo && vinfo.id ? vinfo.id : null;
          if(finalId){ addBlockedId(finalId, vinfo.handle); setBlocked(scope, finalId); scheduleScan(true); } else { scope.dataset.byuOk='1'; }
        });
      return;
      }
    }
    if(!info.id && !info.handle){
      console.warn('BYU: addToBlacklist could not resolve author for scope', scope, 'header', scope.querySelector?.('#header-author'), 'author-link', scope.querySelector?.('a#author-text'), 'thumb', scope.querySelector?.('#author-thumbnail-button'));
      return;
    }
    const hk = info.handle ? hKey(info.handle) : null;

    // UX: Hide immediately to give instant feedback
    if(isComment(scope)) hideComment(scope,true);
    else if(isThread(scope)){ const top=scope.querySelector?.('ytd-comment-view-model,ytd-comment-renderer'); if(top) hideComment(top,true); }
    else { setBlockAttribute(scope, true); }

    if(info.handle && hk) {
      pendingSet.add(info.handle);
      pendingHandleKeys.add(hk);
    }
    if(info.id) {
      addBlockedId(info.id, info.handle);
    }
    // Save pending handles right away so they survive reloads
    syncLists();

    // Sync UI with what we have blocked right now
    scheduleScan(true);

    const fin=(id)=>{
      if(!id) return;
      if(info.handle && hk) {
        pendingSet.delete(info.handle);
        pendingHandleKeys.delete(hk);
      }
      addBlockedId(id,info.handle);
      syncLists();
      scheduleScan(true);
    };

    // Check if we need to resolve handle -> ID
    if(info.id) {
      fin(info.id);
    } else if(info.handle){
      resolveId(info.handle).then(rid=>{ if(V.menuPause) return;
        const finalId = rid || info.id;
        fin(finalId);
      });
    }
  }catch(err){
    console.error('BYU addToBlacklist ERROR', err);
  }
}
// Debug tracer: if __BYU_DEBUG is true, log every click that reaches the document capture phase on a .byu-add element.
document.addEventListener('click',function(ev){
  if(!window.__BYU_DEBUG) return;
  var t=ev.target; if(!t) return;
  var n=t; while(n && n!==document.documentElement){ if(n.classList && n.classList.contains('byu-add')) break; n=n.parentElement; }
  if(n && n.classList && n.classList.contains('byu-add')) console.log('BYU tracer: click reached document (capture) on .byu-add', n);
},true);
// ---- X button event handling (robust on YouTube) ----
// YouTube attaches navigation to many parent nodes and often triggers it on the CLICK event (after pointerdown/up). If we only cancel pointerdown, the subsequent click can still open the video. Therefore we intercept CLICK in CAPTURE phase and stop it before YouTube handlers run.
document.addEventListener('click',ev=>{
  var t=ev.target; if(!t) return;
  var btn=null; for(var n=t; n && n!==document.documentElement; n=n.parentElement){ if(n.classList && n.classList.contains('byu-add')){ btn=n; break; } }
  if(!btn) return; ev.preventDefault(); if(typeof ev.stopImmediatePropagation==='function') ev.stopImmediatePropagation(); ev.stopPropagation();
  if(window.__BYU_DEBUG) console.log('BYU delegated X click', btn);
  callAddToBlacklist(btn,'click',ev);
},true);
// Fallback: also catch pointerdown to reduce UI latency (but click-capture above is the real “navigation stopper”).
document.addEventListener('pointerdown',ev=>{
  var t=ev.target; if(!t) return;
  var btn=null; for(var n=t; n && n!==document.documentElement; n=n.parentElement){ if(n.classList && n.classList.contains('byu-add')){ btn=n; break; } }
  if(!btn) return; ev.preventDefault(); ev.stopPropagation();
  if(window.__BYU_DEBUG) console.log('BYU delegated X pointerdown', btn);
  // pointerdown intentionally only suppresses YouTube navigation; addToBlacklist runs on click only.
},true);
// Intercept contextmenu in CAPTURE phase to cancel popup menus on .byu-add
document.addEventListener('contextmenu',ev=>{
  var t=ev.target; if(!t) return;
  var btn=null; for(var n=t; n && n!==document.documentElement; n=n.parentElement){ if(n.classList && n.classList.contains('byu-add')){ btn=n; break; } }
  if(!btn) return; ev.preventDefault(); ev.stopPropagation();
  if(window.__BYU_DEBUG) console.log('BYU delegated X contextmenu', btn);
  // contextmenu intentionally only suppresses YouTube menus; addToBlacklist runs on click only.
},true);
function resolveId(handle){
  if(V.menuPause) return Promise.resolve(null);
  const h=sanH(handle);
  if(!h) return Promise.resolve(null);
  if(h2id.has(h)) return Promise.resolve(h2id.get(h));
  if(inFlight.has(h)) return inFlight.get(h);
  const p=new Promise(ok=>{ q.push({h,ok}); pump(); });
  inFlight.set(h,p);
  p.finally(()=>inFlight.delete(h));
  return p;
}

function pump(){
  while(qRun<QMAX&&q.length){
    const job=q.shift();
    qRun++;
    fetchId(job.h).then(id=>job.ok(id)).catch(()=>job.ok(null)).finally(()=>{ qRun--; pump(); });
  }
}

async function fetchId(handle){
  try{
    const path=encPath(handle);
    if(!path) return null;
    const r=await fetch(path,{credentials:'same-origin'});
    if(!r.ok) return null;
    const html=await r.text();
    let m=html.match(/"externalId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"/);
    if(m){ h2id.set(handle,m[1]); return m[1]; }
    m=html.match(/"channelId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"/);
    if(m){ h2id.set(handle,m[1]); return m[1]; }
    m=html.match(/"browseId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"/); if(m){ h2id.set(handle,m[1]); return m[1]; }
    m=html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[^"\\/]+)"/); if(m&&hKey(m[1])===hKey(handle)){ const ids=[...html.matchAll(/UC[0-9A-Za-z_-]{22}/g)].map(x=>x[0]); if(ids.length){ const counts=new Map(); for(const id of ids) counts.set(id,(counts.get(id)||0)+1); const best=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0]; h2id.set(handle,best); return best; } }
    const ids=[...html.matchAll(/UC[0-9A-Za-z_-]{22}/g)].map(x=>x[0]); if(ids.length){ const counts=new Map(); for(const id of ids) counts.set(id,(counts.get(id)||0)+1); const best=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0]; h2id.set(handle,best); return best; }
    return null;
  }catch(e){return null;}
}

async function fetchCanonical(id){
  try{
    if(!id||!/^UC[0-9A-Za-z_-]{22}$/.test(id)) return null;
    if(id2h.has(id)) return id2h.get(id);
    if(idInFlight.has(id)) return idInFlight.get(id);

    const p=(async()=>{
      const r=await fetch(`/channel/${id}`,{credentials:'same-origin'});
      if(!r.ok) return null;
      const html=await r.text();

      let m=html.match(/"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/(@[^"\\/]+)"/);
      if(m) return sanH(m[1]);

      m=html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[^"\\/]+)"/);
      if(m) return sanH(m[1]);

      m=html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/www\.youtube\.com\/(@[^"'>\\/]+)["']/i);
      if(m) return sanH(m[1]);

      m=html.match(/https?:\/\/www\.youtube\.com\/(@[A-Za-z0-9._\-·%]+)/);
      if(m) return sanH(m[1]);

      return null;
    })();

    idInFlight.set(id,p);
    const h=await p;
    idInFlight.delete(id);
    return h||null;
  }catch(e){return null;}
}

async function canonicalizeId(id){
  if(V.menuPause) return;
  const h=await fetchCanonical(id);
  if(!h) return;
  const cur=blockedMap.get(id)||null;
  // Never overwrite an explicit handle chosen from UI/comment; only fill missing placeholders.
  if(cur && cur!=='@UNKNOWN' && hKey(cur)!==hKey(h)){
    if(DEBUG||window.__BYU_DEBUG) console.warn('BYU canonicalizeId would overwrite handle; skipped', {id,cur,newHandle:h});
    return;
  }
  if(cur!==h){
    blockedMap.set(id,h);
    await syncLists();
  }
}

async function canonicalizeAll(delay=250){
  if(V.menuPause) return;
  if(V.canonRun) return;
  V.canonRun=true;
  try{
    for(const id of Array.from(blockedIds).slice(0,800)){
      if(!V.menuOpen) break;
      await canonicalizeId(id);
      await new Promise(r=>setTimeout(r,delay));
    }
  }finally{
    V.canonRun=false;
  }
}


function esc(s){
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

setupObserver();
observeNewElements();
scheduleScan(true);
let navT=0; const onNav=()=>{ if(V.menuPause) return; clearTimeout(navT); applyPreHideCSS(); navT=setTimeout(()=>{ observeNewElements(); scheduleScan(true); },50); }; window.addEventListener('yt-navigate-finish',onNav,true); window.addEventListener('popstate',onNav,true);
window.addEventListener('yt-page-data-updated',onNav,true);
// Comment sort (Top comments / Newest first) does not always trigger navigation events; rescan on interaction
document.addEventListener('click',ev=>{
  if(V.menuPause) return;
  const t=ev.target;
  if(!t||!V.comments) return;
  const inHeader=t.closest?.('ytd-comments-header-renderer,ytd-comments-entry-point-header-renderer,ytd-engagement-panel-section-list-renderer');
  const inSort=t.closest?.('yt-sort-filter-sub-menu-renderer,yt-sort-filter-menu-renderer,tp-yt-paper-listbox');
  if(inHeader && inSort) setTimeout(()=>{ observeNewElements(); scheduleScan(true); },50);
},true);
// Periodic light scan every 800ms to catch active dynamic updates
setInterval(() => { if(!V.menuPause) { observeNewElements(); scheduleScan(false); } }, 800);
// Passive scroll listener (throttled)
let scrollT = 0;
window.addEventListener('scroll', () => {
  if (V.menuPause) return;
  if (!scrollT) {
    scrollT = setTimeout(() => {
      scrollT = 0;
      observeNewElements();
      scheduleScan(false);
    }, 150);
  }
}, {passive: true});

}
__BYU__main();
})();
