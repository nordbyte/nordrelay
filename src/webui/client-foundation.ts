export function dashboardClientFoundation(): string {
  return `
const token = localStorage.getItem('nordrelayDashboardToken') || '';
const state = { snapshot:null, controls:null, newSessionControls:null, enabledAgents:[], settings:[], currentPage:'overview', settingsGroup:null, logsPlain:'', logTimer:null, toastTimer:null, cliStatusActive:false, selectedArtifactTurns:new Set(), mediaRecorder:null, recordedChunks:[], events:null, reconnectTimer:null, notifications:false, toolTooltipTimer:null, toolTooltipTarget:null, agentUpdateJobs:[], sessionsRequestId:0 };
const authHeaders = () => token ? { authorization: 'Bearer ' + token } : {};
async function api(path, options={}) {
  const headers = { ...(options.body ? {'content-type':'application/json'} : {}), ...authHeaders(), ...(options.headers||{}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { location.reload(); return; }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg,options={}){const el=document.getElementById('toast');el.textContent=msg;el.style.display='block';if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null;if(!options.sticky){state.toastTimer=setTimeout(()=>{el.style.display='none';state.toastTimer=null},options.duration||3500)}}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function attr(s){return esc(s).replace(/"/g,'&quot;')}
function cssEscape(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&')}
function short(s,max=250){const text=String(s??'');return text.length>max?text.slice(0,max-1)+'...':text}
async function copyText(text,label='Copied'){if(!text)return;try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}toast(label)}
function fmtDate(s){return s?new Date(s).toLocaleString(): '-'}
function fmtDuration(ms){if(!ms&&ms!==0)return '-';const sec=Math.round(ms/1000);if(sec<60)return sec+'s';return Math.floor(sec/60)+'m '+(sec%60)+'s'}
function fmtBytes(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1).replace(/\\.0$/,'')+' KB';return (n/1048576).toFixed(1).replace(/\\.0$/,'')+' MB'}
function compactNum(n){if(!n)return'';if(n>=1000000000)return Math.round(n/100000000)/10+'B';if(n>=1000000)return Math.round(n/100000)/10+'M';if(n>=1000)return Math.round(n/100)/10+'K';return String(n)}
function loadingHtml(label){return '<div class="loading-state"><span class="spinner"></span><span>'+esc(label||'Loading...')+'</span></div>'}
function setLoading(id,label){const el=document.getElementById(id);if(el)el.innerHTML=loadingHtml(label)}
function modelLabel(m){const meta=[m.contextWindow?compactNum(m.contextWindow):'',m.supportsImages===true?'img':m.supportsImages===false?'text':'',m.supportsThinking===true?'think':''].filter(Boolean).join(' ');return (m.displayName||m.slug)+(meta?' · '+meta:'')}
function fmtAge(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return sec+'s ago';const min=Math.floor(sec/60);if(min<60)return min+'m ago';return Math.floor(min/60)+'h ago'}
function isCliRunningStatus(msg){return / CLI running\\b/.test(String(msg||''))}
function isCliDoneStatus(msg){return / CLI task\\b/.test(String(msg||''))}
function applyTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('nordrelayTheme',theme);document.getElementById('themeBtn').textContent=theme==='dark'?'Light':'Dark'}
function toggleTheme(){applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark')}
function page(name){state.currentPage=name;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===name));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));document.getElementById('pageTitle').textContent=name[0].toUpperCase()+name.slice(1);document.getElementById('sidebar').classList.remove('open'); void reloadCurrentPage().catch(err=>toast(err.message||String(err)));}
async function reloadCurrentPage(options={}){const name=state.currentPage;if(name==='chat'){await loadChatHistory();scrollChatToBottom()} if(name==='sessions') await loadSessions(true,options.agentId); if(name==='settings') await loadSettings(); if(name==='logs') await loadLogs(); if(name==='diagnostics') await loadDiagnostics(); if(name==='artifacts') await loadArtifacts(); if(name==='activity') await loadActivity(); if(name==='tasks') await loadTasks(); if(name==='adapters') await loadAdapterHealth(); if(name==='access') await loadAccess(); if(name==='version') await loadVersion();}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.getElementById('menuBtn').onclick=()=>document.getElementById('sidebar').classList.toggle('open');
document.getElementById('refreshBtn').onclick=()=>loadBootstrap();
document.getElementById('themeBtn').onclick=toggleTheme;
applyTheme(localStorage.getItem('nordrelayTheme') || 'light');

function createPaginator(containerId, onChange, pageSize=50){
  const container=document.getElementById(containerId);
  return {
    page:1,
    pageSize,
    reset(){this.page=1},
    render(meta={}){
      const hasPrevious=Boolean(meta.hasPrevious);
      const hasNext=Boolean(meta.hasNext);
      container.innerHTML='<span>Page '+this.page+' / '+this.pageSize+' per page</span><div class="pager-actions"><button data-page-action="prev" '+(!hasPrevious?'disabled':'')+'>Previous</button><button data-page-action="next" '+(!hasNext?'disabled':'')+'>Next</button></div>';
      const prev=container.querySelector('[data-page-action="prev"]');
      const next=container.querySelector('[data-page-action="next"]');
      prev.onclick=()=>{if(hasPrevious){this.page-=1;onChange()}};
      next.onclick=()=>{if(hasNext){this.page+=1;onChange()}};
    }
  };
}
const sessionsPager=createPaginator('sessionsPager',()=>loadSessions(false),50);

async function loadBootstrap(){
  const data = await api('/api/bootstrap');
  state.snapshot = data.status.snapshot;
  state.controls = data.controls;
  state.enabledAgents = data.enabledAgents || [];
  renderSnapshot(state.snapshot);
  renderSessionControls();
  populateNewSessionForm(data.enabledAgents);
  renderAdapters(data.channels, data.agentAdapters);
  document.getElementById('footerVersion').textContent='NordRelay '+(data.status.health?.version || '');
  document.getElementById('footerHealth').textContent='Health: '+(data.status.health?.state?.status || 'unknown');
  const agentSelect=document.getElementById('agentSelect');
  agentSelect.innerHTML=data.enabledAgents.map(a=>'<option value="'+a+'">'+a+'</option>').join('');
  agentSelect.value=state.snapshot.session.agentId;
  agentSelect.onchange=()=>safe(async()=>{const selected=agentSelect.value;const r=await api('/api/agent',{method:'POST',body:JSON.stringify({agentId:selected})});if(state.snapshot&&r.session){state.snapshot.session=r.session;renderSnapshot(state.snapshot)}toast('Agent switched');await loadBootstrap();await reloadCurrentPage({agentId:selected})});
}
function renderSnapshot(s){
  document.getElementById('sessionLine').textContent=(s.session.agentLabel||'Agent')+' / '+(s.session.model||'default')+' / '+(s.session.threadId||'not started');
  document.getElementById('sessionText').textContent=s.sessionText||'';
  document.getElementById('metrics').innerHTML=[
    ['Status',s.processing?'working':'idle'],['Agent',s.session.agentLabel],['Queue',s.queue.length],['Workspace',s.session.workspace],['Thread',s.session.threadId||'not started'],['Reasoning',s.session.reasoningEffort||'default'],['Fast',s.session.capabilities&&s.session.capabilities.fastMode?(s.session.fastMode?'on':'off'):'n/a']
  ].map(([k,v])=>'<div class="metric"><div class="label">'+esc(k)+'</div><div class="value">'+esc(v)+'</div></div>').join('');
  renderQueue(s.queue,s.queuePaused);
}
function renderSessionControls(){
  const c=state.controls||{};const s=state.snapshot?.session||{};const caps=c.capabilities||{};
  const modelOptions=['<option value="">Default</option>'].concat((c.models||[]).map(m=>'<option value="'+attr(m.slug)+'" '+(m.slug===s.model?'selected':'')+'>'+esc(modelLabel(m))+'</option>')).join('');
  const reasoningOptions=(c.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'" '+(v===s.reasoningEffort?'selected':'')+'>'+esc(v)+'</option>').join('');
  const launchOptions=(c.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'" '+(p.id===(s.nextLaunchProfileId||s.launchProfileId)?'selected':'')+'>'+esc(p.label+' - '+p.behavior+(p.unsafe?' - unsafe':''))+'</option>').join('');
  document.getElementById('sessionControls').innerHTML=[
    caps.modelSelection?'<label>Model<select id="controlModel">'+modelOptions+'</select></label>':'',
    caps.reasoningSelection?'<label>'+esc(c.reasoningLabel||'Reasoning')+'<select id="controlReasoning">'+reasoningOptions+'</select></label>':'',
    caps.launchProfiles?'<label>Launch<select id="controlLaunch">'+launchOptions+'</select></label>':'',
    caps.fastMode?'<label class="checkbox"><input id="controlFast" type="checkbox" '+(s.fastMode?'checked':'')+'> Fast mode</label>':''
  ].join('');
  const model=document.getElementById('controlModel'); if(model) model.onchange=()=>safe(async()=>{if(model.value){await api('/api/session/model',{method:'POST',body:JSON.stringify({model:model.value})});toast('Model updated');loadBootstrap()}});
  const reasoning=document.getElementById('controlReasoning'); if(reasoning) reasoning.onchange=()=>safe(async()=>{await api('/api/session/reasoning',{method:'POST',body:JSON.stringify({reasoning:reasoning.value})});toast((c.reasoningLabel||'Reasoning')+' updated');loadBootstrap()});
  const launch=document.getElementById('controlLaunch'); if(launch) launch.onchange=()=>safe(async()=>{await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId:launch.value})});toast('Launch profile updated');loadBootstrap()});
  const fast=document.getElementById('controlFast'); if(fast) fast.onchange=()=>safe(async()=>{await api('/api/session/fast',{method:'POST',body:JSON.stringify({enabled:fast.checked})});toast('Fast mode updated');loadBootstrap()});
}
function renderAdapters(channels, agents){
  const channelCards=(channels||[]).map(c=>adapterCard(c.label,c.status,'',c.capabilities.join(', ')));
  const agentCards=(agents||[]).map(a=>{const available=a.status==='available';const status=available?(state.enabledAgents.includes(a.id)?'enabled':'disabled'):(a.status||'planned');return adapterCard(a.label,status,'',a.notes||'')});
  document.getElementById('agentAdapters').innerHTML='<div class="list">'+(agentCards.join('')||'<div class="item">No agent adapters.</div>')+'</div>';
  document.getElementById('chatAdapters').innerHTML='<div class="list">'+(channelCards.join('')||'<div class="item">No chat adapters.</div>')+'</div>';
}
function adapterCard(label,status,detail,tooltip=''){return '<div class="item"><strong title="'+attr(tooltip)+'">'+esc(label)+' <span class="adapter-status '+esc(status)+'">'+esc(status)+'</span></strong>'+(detail?'<small>'+esc(detail)+'</small>':'')+'</div>'}
const agentFeatureDefs=[
  ['modelSelection','Model','Model selection'],
  ['reasoningSelection','Reasoning','Reasoning/thinking level selection'],
  ['launchProfiles','Launch','Launch profile selection'],
  ['fastMode','Fast','Fast mode'],
  ['workspaces','Workspaces','Workspace listing and switching'],
  ['attachments','Files/images','File, photo, and voice attachments'],
  ['externalActivity','External busy','Detect native CLI activity'],
  ['cliMirror','CLI mirror','Mirror native CLI turns'],
  ['activityLog','Activity','Session activity timeline'],
  ['usageStats','Usage','Token and context usage'],
  ['subscriptionLimits','Limits','Subscription/quota limits'],
  ['auth','Auth','Authentication status'],
  ['login','Login','Interactive login'],
  ['logout','Logout','Interactive logout'],
  ['handback','Handback','Return session to native CLI']
];
function featureMatrix(caps){const c=caps||{};return '<div class="feature-matrix">'+agentFeatureDefs.map(([key,label,title])=>'<span class="feature-chip '+(c[key]?'supported':'unsupported')+'" title="'+attr(title)+'"><span>'+esc(label)+'</span><b>'+(c[key]?'✓':'-')+'</b></span>').join('')+'</div>'}
function versionStatusLabel(status){if(status==='current')return'Latest';if(status==='outdated')return'Outdated';if(status==='not-installed')return'Not installed';return'Unknown'}
function versionStatusClass(status){if(status==='current')return'available';if(status==='outdated')return'planned';return'disabled'}
function jobStatusClass(status){if(status==='completed')return'available';if(status==='running')return'planned';return'disabled'}
`;
}
