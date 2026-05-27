const NORDRELAY_PLUGIN_PANEL_CSS = `
:root{color-scheme:light;--bg:#f4f6f2;--surface:#ffffff;--surface-soft:#fbfcf8;--text:#18201b;--muted:#5d675f;--border:#dce3d9;--border-soft:#e7ede4;--accent:#235c42;--accent-strong:#17452f;--accent-soft:#dff5e8;--accent-text:#1d6a4c;--success:#1d8a5b;--warn:#fff7da;--warn-text:#8a6a12;--danger:#9b1c1c;--pre:#111812;--pre-text:#f3f7ef;--scrollbar-track:#edf2e9;--scrollbar-thumb:#b6c5b8;--scrollbar-thumb-hover:#889d8c;--shadow:0 8px 24px rgba(24,32,27,.04);--link:#1d6a4c}
:root[data-theme="dark"]{color-scheme:dark;--bg:#101411;--surface:#171d19;--surface-soft:#1d251f;--text:#edf4ee;--muted:#a7b3aa;--border:#2d3830;--border-soft:#263128;--accent:#0b7a4b;--accent-strong:#047857;--accent-soft:#0b2f1f;--accent-text:#57c785;--success:#57c785;--warn:#3b3216;--warn-text:#f2c94c;--danger:#cc4b4b;--pre:#070a08;--pre-text:#e8f1ea;--scrollbar-track:#121a15;--scrollbar-thumb:#3a4c40;--scrollbar-thumb-hover:#5d7867;--shadow:0 10px 28px rgba(0,0,0,.22);--link:#57c785}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:var(--scrollbar-track)}
*::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border:2px solid var(--scrollbar-track);border-radius:999px}
*::-webkit-scrollbar-thumb:hover{background:var(--scrollbar-thumb-hover)}
html{min-height:100%;font-size:16px;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body.nordrelay-plugin-panel{min-height:100vh;margin:0;padding:16px;background:var(--bg);color:var(--text);font-family:Inter,"Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,Roboto,Arial,sans-serif;line-height:1.4;font-synthesis:none}
h1{font-size:22px;margin:0 0 14px;line-height:1.15}
h2{font-size:16px;margin:0 0 12px;line-height:1.2}
h3{font-size:14px;margin:0 0 10px;line-height:1.25}
p{margin:4px 0;color:var(--muted)}
a{color:var(--link)}
small{color:var(--muted)}
.stack{display:flex;flex-direction:column;gap:16px}
.row,.toolbar,.ui-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.section-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 12px}
.section-tabs{display:flex;align-items:flex-end;gap:2px;width:100%;min-width:0;min-height:43px;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--border)}
.section-tabs button{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:43px;height:43px;margin:0;padding:0 14px;border:0;border-radius:0;background:transparent;color:var(--muted);font-weight:650;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:inset 0 -2px 0 transparent}
.section-tabs button:hover{background:color-mix(in srgb,var(--accent) 8%,transparent);color:var(--text)}
.section-tabs button.active,.section-tabs button[aria-selected="true"]{box-shadow:inset 0 -2px 0 var(--accent);background:transparent;color:var(--text)}
.panel,.metric,.item{background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow)}
.panel{padding:16px}
.item{padding:12px;margin:0 0 10px}
.item strong{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.item small{display:block;margin-top:5px}
.empty-state,.loading-state,.error-state{padding:14px;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-soft);color:var(--muted)}
.error-state{border-color:color-mix(in srgb,var(--danger) 55%,var(--border));color:var(--danger)}
.callout{padding:10px 12px;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-soft);color:var(--text)}
.callout.muted{color:var(--muted)}
.callout.warn{border-color:color-mix(in srgb,var(--warn-text) 45%,var(--border));background:var(--warn);color:var(--text)}
.callout.error{border-color:var(--danger);color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,var(--surface))}
.metrics,.metrics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.metric{padding:16px}
.metric .label,.metric-label{font-size:12px;text-transform:uppercase;color:var(--muted)}
.metric .value,.metric-value{font-size:18px;font-weight:750;margin-top:4px;overflow:hidden;text-overflow:ellipsis}
	.metric-row{display:grid;grid-template-columns:minmax(110px,0.65fr) minmax(0,1fr);gap:8px;align-items:center;margin:6px 0;font-size:13px}
	.metric-kv-number{font-variant-numeric:tabular-nums;font-weight:700}
	.progress,.metric-bar{height:7px;background:color-mix(in srgb,var(--border) 50%,transparent);border-radius:999px;overflow:hidden}
	.progress-fill,.metric-bar-fill{display:block;height:100%;background:var(--success)}
	.progress-fill.warn,.metric-bar-fill.warn{background:var(--warn-text)}
	.progress-fill.error,.metric-bar-fill.error{background:var(--danger)}
	.progress-svg{display:block;width:100%;height:7px;border-radius:999px;overflow:hidden}
	.progress-svg .progress-track{fill:color-mix(in srgb,var(--border) 50%,transparent)}
	.progress-svg .progress-fill{fill:var(--success)}
	.progress-svg.warn .progress-fill{fill:var(--warn-text)}
	.progress-svg.error .progress-fill{fill:var(--danger)}
	button,select,input,textarea{border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit;line-height:1.2;vertical-align:middle}
input,select,textarea{font-size:15px}
button{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;height:36px;padding:0 12px;background:var(--accent);color:white;border-color:var(--accent);cursor:pointer;line-height:1;text-align:center;white-space:nowrap}
button:hover{background:var(--accent-strong)}
button.secondary{background:var(--surface);color:var(--text)}
button.secondary:hover,button.secondary:focus{background:var(--accent);border-color:var(--accent);color:white;outline:none}
button.active,button[aria-selected="true"]{background:var(--accent);border-color:var(--accent);color:white}
button.danger{background:var(--danger);border-color:var(--danger);color:white}
button.mini-button,.mini-button{min-height:28px;height:28px;padding:0 8px;font-size:13px;line-height:1}
button:disabled{opacity:.65;cursor:not-allowed}
input,select{min-height:36px;height:36px;padding:0 10px}
textarea{width:100%;padding:10px;resize:vertical;line-height:1.4}
label{display:grid;gap:5px;font-size:12px;color:var(--muted)}
label.checkbox{display:flex;align-items:center;gap:8px;color:var(--text)}
.adapter-status,.badge{display:inline-flex;align-items:center;justify-content:center;min-height:22px;border-radius:999px;border:1px solid var(--border);padding:2px 8px;font-size:12px;font-weight:750;line-height:1;color:var(--muted);white-space:nowrap}
.adapter-status.enabled,.badge.enabled,.adapter-status.latest,.badge.latest{color:var(--accent-text);border-color:color-mix(in srgb,var(--accent-text) 45%,var(--border));background:var(--accent-soft)}
.adapter-status.disabled,.badge.disabled{color:var(--muted);background:var(--surface-soft)}
.adapter-status.warning,.adapter-status.planned,.badge.warning,.badge.planned{color:var(--warn-text);border-color:color-mix(in srgb,var(--warn-text) 45%,var(--border));background:var(--warn)}
.adapter-status.failed,.badge.failed,.adapter-status.error,.badge.error{color:var(--danger);border-color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,var(--surface))}
.chip{display:inline-flex;align-items:center;justify-content:center;min-height:20px;border-radius:999px;border:1px solid var(--border);padding:2px 8px;font-size:12px;line-height:1.15;color:var(--muted);margin-right:6px}
.chip.ok{color:var(--accent-text);border-color:color-mix(in srgb,var(--accent-text) 45%,var(--border));background:var(--accent-soft)}
.chip.error{color:var(--danger);border-color:var(--danger)}
.chip.warn{color:var(--warn-text);border-color:color-mix(in srgb,var(--warn-text) 45%,var(--border));background:var(--warn)}
.data-table-wrap{max-width:100%;margin-top:12px;overflow-x:auto;overflow-y:visible;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-soft);-webkit-overflow-scrolling:touch}
.data-table{width:100%;min-width:var(--table-min-width,860px);border-collapse:collapse;table-layout:auto;font-size:14px;line-height:1.35}
.data-table th,.data-table td{padding:10px 12px;border-bottom:1px solid var(--border-soft);text-align:left;vertical-align:middle}
.data-table th{background:var(--surface);color:var(--muted);font-size:13px;font-weight:750;line-height:1;white-space:nowrap}
.data-table tbody tr:last-child td{border-bottom:0}
.data-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--surface) 55%,var(--surface-soft))}
.data-table tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.data-table td{min-width:0;color:var(--text)}
.data-table .primary-cell{font-weight:650}
.data-table .age-cell,.data-table .number-cell,.data-table .status-cell,.data-table .updated-cell,.data-table .version-cell{white-space:nowrap}
.truncate-cell{display:block;min-width:0;max-width:min(44vw,420px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.data-table-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:nowrap;white-space:nowrap}
	.data-table-actions button{min-height:28px;height:28px;padding:0 8px;font-size:13px;line-height:1}
	.actions-cell,.actions-heading{white-space:nowrap}
	.actions-heading{text-align:right!important}
	svg{display:block;max-width:100%;color:var(--muted)}
	.sparkline{display:inline-block;vertical-align:middle;margin-left:8px}
	.metrics-grid+.metrics-chart-stack{margin-top:16px}
	.chart-wrap{position:relative;width:100%;min-height:180px}
	.chart-axis-label{position:absolute;left:4px;z-index:1;pointer-events:none;color:var(--muted);font-size:11px;line-height:1.2;letter-spacing:0;font-family:inherit}
	.chart-axis-label-top{top:4px}
	.chart-axis-label-bottom{bottom:26px}
	.chart-hit{cursor:crosshair}
	.chart-hit:hover{fill:color-mix(in srgb,var(--accent) 12%,transparent)!important}
	.chart-tooltip{position:absolute;left:0;top:0;z-index:20;max-width:280px;white-space:pre-line;pointer-events:none;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);box-shadow:var(--shadow);font-size:12px;line-height:1.35;letter-spacing:0;font-family:inherit}
	.chart-tooltip[hidden]{display:none}
	.chart-tooltip-note{font-size:12px;color:var(--muted)}
	.chart-legend{align-items:center;gap:6px}
	.chart-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.25;font-family:inherit;letter-spacing:0;transform:none;font-stretch:normal}
	.chart-legend-dot{display:inline-block;width:9px;height:9px;min-width:9px;color:inherit}
	pre,.log-view,.code-block{max-width:100%;overflow:auto;margin:8px 0;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--pre);color:var(--pre-text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;white-space:pre}
code,.inline-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--link)}
.code-diff span{display:block;min-height:1.35em}
.diff-add{color:var(--success)}
.diff-del{color:var(--danger)}
.diff-hunk{color:var(--accent-text);font-weight:700}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}
.artifact-card{border:1px solid var(--border-soft);border-radius:8px;padding:8px;background:var(--surface-soft);min-width:0}
.artifact-card img,.media-preview img{width:100%;height:auto;object-fit:cover;border:1px solid var(--border);border-radius:6px;background:var(--surface)}
`;

const NORDRELAY_PLUGIN_PANEL_BRIDGE_JS = `
(function(){
  var panelToken=__NORDRELAY_PLUGIN_PANEL_TOKEN__;
  function post(type,payload){try{parent.postMessage({source:'nordrelay-plugin-panel',token:panelToken,type:type,payload:payload||{}},'*')}catch{}}
  function height(){return Math.max(document.documentElement.scrollHeight||0,document.body?document.body.scrollHeight:0,320)}
  function sendResize(){post('resize',{height:height()})}
  window.NordRelayPanel={
    toast:function(message){post('toast',{message:String(message||'')})},
    copyText:function(value,label){post('copy',{value:String(value||''),label:label?String(label):'Copied'})},
    ready:function(){post('ready',{})},
    reload:function(input){post('reload',{input:input&&typeof input==='object'?input:{}})},
    resize:sendResize
  };
  window.addEventListener('message',function(event){
    var data=event.data||{};
    if(data.source!=='nordrelay-host'||data.type!=='theme')return;
    document.documentElement.dataset.theme=data.theme==='dark'?'dark':'light';
    sendResize();
  });
  if(window.ResizeObserver)new ResizeObserver(sendResize).observe(document.documentElement);
  window.addEventListener('load',function(){sendResize();post('ready',{})});
  setTimeout(sendResize,50);
  setTimeout(sendResize,250);
})();
`;

function currentPluginPanelTheme(){return document.documentElement.dataset.theme==='dark'?'dark':'light'}
function currentPluginPanelNonce(){
  const script=document.querySelector('script[nonce]') as HTMLScriptElement|null;
  const style=document.querySelector('style[nonce]') as HTMLStyleElement|null;
  return script?.nonce||script?.getAttribute('nonce')||style?.nonce||style?.getAttribute('nonce')||'';
}
function pluginPanelNonceAttr(){
  const nonce=currentPluginPanelNonce();
  return nonce?' nonce="'+attr(nonce)+'"':'';
}
function pluginPanelStyleTag(){return '<style data-nordrelay-plugin-ui'+pluginPanelNonceAttr()+'>'+NORDRELAY_PLUGIN_PANEL_CSS+'</style>'}
function pluginPanelBridgeTag(panelToken=''){
  const script=NORDRELAY_PLUGIN_PANEL_BRIDGE_JS
    .replace('__NORDRELAY_PLUGIN_PANEL_TOKEN__',JSON.stringify(String(panelToken||'')))
    .replace(/<\/script/gi,'<\\/script');
  return '<script data-nordrelay-plugin-bridge'+pluginPanelNonceAttr()+'>'+script+'</script>';
}
function pluginPanelNonceInlineTags(html){
  const nonce=pluginPanelNonceAttr();
  if(!nonce)return String(html||'');
  return String(html||'')
    .replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi,(_match,attrs)=>'<script'+attrs+nonce+'>')
    .replace(/<style\b(?![^>]*\bnonce=)([^>]*)>/gi,(_match,attrs)=>'<style'+attrs+nonce+'>');
}
function pluginPanelBodyTag(attrs=''){
  const text=String(attrs||'');
  if(/class=["'][^"']*["']/i.test(text)){
    return '<body'+text.replace(/class=["']([^"']*)["']/i,(_,classes)=>'class="'+attr(String(classes||'').trim()+' nordrelay-plugin-panel')+'"')+'>';
  }
  return '<body'+text+' class="nordrelay-plugin-panel">';
}
function pluginPanelDocument(html,options:WebuiRecord={}){
  const raw=pluginPanelNonceInlineTags(html);
  const theme=String(options.theme||currentPluginPanelTheme());
  const headExtra='<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+pluginPanelStyleTag()+pluginPanelBridgeTag(String(options.panelToken||''));
  if(/<!doctype|<html[\s>]/i.test(raw)){
    let doc=raw;
    if(/<html[\s>]/i.test(doc))doc=doc.replace(/<html([^>]*)>/i,(_match,attrs)=>'<html'+attrs+' data-theme="'+attr(theme)+'">');
    else doc='<!doctype html><html data-theme="'+attr(theme)+'">'+doc+'</html>';
    if(/<head[\s>]/i.test(doc))doc=doc.replace(/<head([^>]*)>/i,'<head$1>'+headExtra);
    else doc=doc.replace(/<html([^>]*)>/i,'<html$1><head>'+headExtra+'</head>');
    if(/<body[\s>]/i.test(doc))doc=doc.replace(/<body([^>]*)>/i,(_match,attrs)=>pluginPanelBodyTag(attrs));
    else doc=doc.replace(/<\/head>/i,'</head><body class="nordrelay-plugin-panel">')+'</body>';
    return doc;
  }
  return '<!doctype html><html data-theme="'+attr(theme)+'"><head>'+headExtra+'</head><body class="nordrelay-plugin-panel">'+raw+'</body></html>';
}
function pluginPanelFrameHtml(html,title,options:WebuiRecord={},className=''){
  const panelToken=createPluginPanelToken();
  const documentHtml=pluginPanelDocument(html,{...options,panelToken});
  const url=URL.createObjectURL(new Blob([documentHtml],{type:'text/html'}));
  const classes=['plugin-panel-frame',String(className||'').trim()].filter(Boolean).join(' ');
  return '<iframe class="'+attr(classes)+'" sandbox="allow-scripts" title="'+attr(title)+'" data-plugin-panel-frame data-plugin-panel-token="'+attr(panelToken)+'" data-plugin-panel-url="'+attr(url)+'" src="'+attr(url)+'"></iframe>';
}
function createPluginPanelToken(){
  const cryptoApi=(globalThis as WebuiRecord).crypto as WebuiRecord|undefined;
  if(cryptoApi&&typeof cryptoApi.randomUUID==='function')return String(cryptoApi.randomUUID());
  return 'panel-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
}
function revokePluginPanelUrls(root:ParentNode=document){
  root.querySelectorAll?.('iframe.plugin-panel-frame[data-plugin-panel-url]').forEach(frame=>{
    const url=(frame as HTMLIFrameElement).dataset.pluginPanelUrl;
    if(url)try{URL.revokeObjectURL(url)}catch{}
  });
}
function asPluginPanelFrame(frame):HTMLIFrameElement|null{
  return frame instanceof HTMLIFrameElement?frame:null;
}
function pluginPanelAvailableHeight(frame){
  frame=asPluginPanelFrame(frame);
  if(!frame||!frame.classList.contains('plugin-panel-page-frame'))return 320;
  const rect=frame.getBoundingClientRect();
  const footer=document.querySelector('footer');
  const footerHeight=footer?footer.getBoundingClientRect().height:0;
  return Math.max(420,Math.floor(window.innerHeight-rect.top-footerHeight-24));
}
function applyPluginPanelFrameHeight(frame,contentHeight=0){
  frame=asPluginPanelFrame(frame);
  if(!frame)return;
  const minimum=pluginPanelAvailableHeight(frame);
  const height=Math.max(minimum,Math.min(2400,Number(contentHeight)||0));
  frame.style.height=height+'px';
}
function bindPluginPanelFrame(frame){
  frame=asPluginPanelFrame(frame);
  if(!frame||frame.dataset.pluginPanelBound)return;
  frame.dataset.pluginPanelBound='true';
  frame.addEventListener('load',()=>{postPluginPanelTheme(frame);applyPluginPanelFrameHeight(frame)});
  applyPluginPanelFrameHeight(frame);
}
function postPluginPanelTheme(frame){
  frame=asPluginPanelFrame(frame);
  if(!frame)return;
  try{frame.contentWindow?.postMessage({source:'nordrelay-host',type:'theme',theme:currentPluginPanelTheme()},'*')}catch{}
}
function isPluginPanelWindow(source){
  return Boolean(pluginPanelFrameForWindow(source));
}
function pluginPanelFrameForWindow(source){
  return Array.from(document.querySelectorAll('iframe.plugin-panel-frame')).map(asPluginPanelFrame).find(item=>item?.contentWindow===source)||null;
}
function pluginPanelFrameForMessage(event:MessageEvent){
  const data=event.data||{};
  const token=String(data.token||'');
  if(token){
    const frame=Array.from(document.querySelectorAll('iframe.plugin-panel-frame'))
      .map(asPluginPanelFrame)
      .find(item=>item?.dataset.pluginPanelToken===token);
    if(frame)return frame;
  }
  return pluginPanelFrameForWindow(event.source);
}
window.addEventListener('message',event=>{
  const data=event.data||{};
  const frame=pluginPanelFrameForMessage(event);
  if(data.source!=='nordrelay-plugin-panel'||!frame)return;
  const payload=data.payload||{};
  if(data.type==='resize'){
    applyPluginPanelFrameHeight(frame,Number(payload.height)||0);
  }else if(data.type==='toast'){
    toast(String(payload.message||'Plugin panel'));
  }else if(data.type==='copy'){
    copyText(String(payload.value||''),String(payload.label||'Copied'));
  }else if(data.type==='reload'){
    const reload=(globalThis as WebuiRecord).reloadPluginPanelFrame;
    if(frame&&typeof reload==='function')void reload(frame,payload.input&&typeof payload.input==='object'?payload.input:{});
  }
});
function syncPluginPanelThemes(){
  document.querySelectorAll('iframe.plugin-panel-frame').forEach(frame=>postPluginPanelTheme(frame));
}
window.addEventListener('resize',()=>document.querySelectorAll('iframe.plugin-panel-page-frame').forEach(frame=>applyPluginPanelFrameHeight(frame)));
