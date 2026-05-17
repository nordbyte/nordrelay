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
function createCursorPager(containerId,onChange){
  const container=document.getElementById(containerId);
  return {
    stack:[],
    cursor:null,
    nextCursor:null,
    hasNext:false,
    total:0,
    reset(){this.stack=[];this.cursor=null;this.nextCursor=null;this.hasNext=false;this.total=0},
    render(meta={}){
      if(!container)return;
      this.nextCursor=meta.nextCursor||null;
      this.hasNext=Boolean(meta.hasNext);
      this.total=Number(meta.total||0);
      container.innerHTML='<span>'+esc(this.total?this.total+' total':'')+'</span><div class="pager-actions"><button data-cursor-action="prev" '+(!this.stack.length?'disabled':'')+'>Previous</button><button data-cursor-action="next" '+(!this.hasNext?'disabled':'')+'>Next</button></div>';
      const prev=container.querySelector('[data-cursor-action="prev"]');
      const next=container.querySelector('[data-cursor-action="next"]');
      prev.onclick=()=>{if(this.stack.length){this.cursor=this.stack.pop()||null;onChange()}};
      next.onclick=()=>{if(this.hasNext&&this.nextCursor){this.stack.push(this.cursor);this.cursor=this.nextCursor;onChange()}};
    }
  };
}
const activityPager=createCursorPager('activityPager',()=>loadActivity(false));
const auditPager=createCursorPager('auditPager',()=>loadAudit(false));
const artifactPager=createCursorPager('artifactPager',()=>loadArtifacts(false));
const jobsPager=createCursorPager('jobsPager',()=>loadTasks(false));

async function loadBootstrap(){
  const local = await api('/api/bootstrap',{local:true});
  state.auth = local.auth || null;
  state.csrfToken = local.auth?.csrfToken || state.csrfToken || null;
  state.permissions = local.auth?.permissions || [];
  applyAccountChrome(local.auth);
  await loadPeerSelector();
  const data = state.selectedPeer && state.selectedPeer !== 'local' ? await api('/api/bootstrap') : local;
  state.snapshot = data.status.snapshot;
  state.controls = data.controls;
  state.enabledAgents = data.enabledAgents || [];
  applyPermissions();
  renderSnapshot(state.snapshot);
  safe(loadActiveSessions);
  renderSessionControls();
  populateNewSessionForm(data.enabledAgents);
  renderAdapters(data.channels, data.agentAdapters);
  document.getElementById('footerVersion').textContent='NordRelay '+(data.status.health?.version || '');
  document.getElementById('footerHealth').textContent='Health: '+(data.status.health?.state?.status || 'unknown');
  document.getElementById('footerUser').textContent='User: '+(local.auth?.user?.email || '-')+(state.selectedPeer&&state.selectedPeer!=='local'?' / target peer':'');
  const agentSelect=document.getElementById('agentSelect');
  agentSelect.innerHTML=data.enabledAgents.map(a=>'<option value="'+a+'">'+a+'</option>').join('');
  agentSelect.value=state.snapshot.session.agentId;
  agentSelect.onchange=()=>safe(async()=>{const selected=agentSelect.value;const r=await api('/api/agent',{method:'POST',body:JSON.stringify({agentId:selected})});if(state.snapshot&&r.session){state.snapshot.session=r.session;renderSnapshot(state.snapshot)}toast('Agent switched');await loadBootstrap();await reloadCurrentPage({agentId:selected})});
  applyPermissions();
}
async function loadPeerSelector(){
  const peerSelect=document.getElementById('peerSelect');
  if(!peerSelect)return;
  if(!can('peers.read')){
    peerSelect.innerHTML='<option value="local">Local</option>';
    peerSelect.value='local';
    state.selectedPeer='local';
    return;
  }
  try{
    const peers=await api('/api/peers',{local:true});
    state.peers=peers;
    const available=(peers.peers||[]).filter(p=>p.enabled&&p.url);
    peerSelect.innerHTML='<option value="local">Local node</option>'+available.map(p=>'<option value="'+attr(p.id)+'">'+esc(p.name)+'</option>').join('');
    if(state.selectedPeer!=='local'&&!available.some(p=>p.id===state.selectedPeer))state.selectedPeer='local';
    peerSelect.value=state.selectedPeer;
    peerSelect.onchange=()=>safe(async()=>{state.selectedPeer=peerSelect.value||'local';localStorage.setItem('nordrelayPeerTarget',state.selectedPeer);connectEvents();toast(state.selectedPeer==='local'?'Target: local':'Target: '+peerSelect.options[peerSelect.selectedIndex].text);await loadBootstrap();await reloadCurrentPage()});
  }catch{
    peerSelect.innerHTML='<option value="local">Local node</option>';
    peerSelect.value='local';
  }
}
function renderSnapshot(s){
  const line=document.getElementById('sessionLine');
  const thread=s.session.threadId||'';
  line.innerHTML=esc(s.session.agentLabel||'Agent')+' / '+esc(s.session.model||'default')+' / '+(thread?uiCopyButton(thread,'Thread ID copied'):'not started');
  bindUiCopyButtons(line);
  document.getElementById('metrics').innerHTML=[
    ['Status',s.processing?'working':'idle'],['Agent',s.session.agentLabel],['Queue',s.queue.length],['Workspace',s.session.workspace],['Thread',s.session.threadId||'not started'],['Reasoning',s.session.reasoningEffort||'default'],['Fast',s.session.capabilities&&s.session.capabilities.fastMode?(s.session.fastMode?'on':'off'):'n/a']
  ].map(([k,v])=>'<div class="metric"><div class="label">'+esc(k)+'</div><div class="value">'+esc(v)+'</div></div>').join('');
  renderQueue(s.queue,s.queuePaused);
}
async function loadActiveSessions(){
  const box=document.getElementById('activeSessions');
  if(!box)return;
  if(!can('sessions.read')){box.innerHTML='<div class="item">Permission required: sessions.read</div>';return}
  const data=await api('/api/active-sessions');
  renderActiveSessions(data.sessions||[]);
}
function renderActiveSessions(items){
  state.activeSessions={sessions:items||[],updatedAt:new Date().toISOString()};
  renderChatWorkingIndicator();
  const box=document.getElementById('activeSessions');
  if(!box)return;
  box.innerHTML=(items||[]).map(activeSessionCard).join('')||'<div class="item">No active sessions.</div>';
  document.querySelectorAll('[data-active-copy]').forEach(b=>b.onclick=()=>copyText(b.dataset.activeCopy||'','Thread ID copied'));
  document.querySelectorAll('[data-active-switch]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('sessions.write')){toast('Permission required: sessions.write');return}const agentId=b.dataset.activeAgent;const threadId=b.dataset.activeSwitch;if(agentId&&state.snapshot?.session?.agentId!==agentId){await api('/api/agent',{method:'POST',body:{agentId}})}if(threadId){await api('/api/sessions/switch',{method:'POST',body:{threadId}})}toast('Session switched');await loadBootstrap();page('chat')}));
  document.querySelectorAll('[data-active-detail]').forEach(b=>b.onclick=()=>safe(async()=>{const agentId=b.dataset.activeAgent;const threadId=b.dataset.activeDetail;if(agentId&&state.snapshot?.session?.agentId!==agentId){await api('/api/agent',{method:'POST',body:{agentId}});await loadBootstrap()}if(threadId)await loadSessionDetail(threadId)}));
  applyPermissions();
}
function activeSessionCard(s){
  const thread=s.threadId||'not started';
  const prompt=s.prompt?'<small>'+esc(short(s.prompt,250))+'</small>':'';
  const tool=s.currentTool||s.lastTool||'-';
  const queue=s.queueLength?(' · '+s.queueLength+' queued'+(s.queuePaused?' paused':'')):'';
  const sourceLabel=activeSourceLabel(s.source);
  const mirrors=(s.mirrorChannels||[]).map(m=>activeSourceLabel(m.source)+' '+m.mode+(m.queueLength?' · '+m.queueLength+' queued'+(m.queuePaused?' paused':''):'')).join(', ');
  const meta=['Source '+sourceLabel,s.workspace,fmtDuration(s.durationMs),tool&&tool!=='-'?'tool '+tool:''].filter(Boolean).join(' | ');
  const mirrorLine=mirrors?'<small>Mirroring: '+esc(mirrors)+'</small>':(s.source==='cli'?'<small>Mirroring: none</small>':'');
  return '<div class="item active-session-item"><strong>'+esc(s.agentLabel||s.agentId||'Agent')+' <span class="adapter-status enabled">'+esc(s.status)+'</span></strong><small><button type="button" class="copy-id" data-active-copy="'+attr(thread)+'" title="Copy thread ID">'+esc(short(thread,64))+'</button>'+esc(queue)+'</small><small>'+esc(meta)+'</small>'+mirrorLine+prompt+'<div class="row"><button data-active-switch="'+attr(thread)+'" data-active-agent="'+attr(s.agentId||'')+'" '+(!s.threadId?'disabled ':'')+disabledAttr('sessions.write')+'>Switch</button><button class="secondary" data-active-detail="'+attr(thread)+'" data-active-agent="'+attr(s.agentId||'')+'" '+(!s.threadId?'disabled ':'')+'>Details</button></div></div>';
}
function activeSourceLabel(source){
  if(source==='cli')return'CLI';
  if(source==='telegram')return'Telegram';
  if(source==='discord')return'Discord';
  if(source==='slack')return'Slack';
  if(source==='web')return'WebUI';
  return source||'-';
}
function renderSessionControls(){
  const c=state.controls||{};const s=state.snapshot?.session||{};const caps=c.capabilities||{};
  const modelOptions=['<option value="">Default</option>'].concat((c.models||[]).map(m=>'<option value="'+attr(m.slug)+'" '+(m.slug===s.model?'selected':'')+'>'+esc(modelLabel(m))+'</option>')).join('');
  const reasoningOptions=(c.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'" '+(v===s.reasoningEffort?'selected':'')+'>'+esc(v)+'</option>').join('');
  const launchOptions=(c.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'" '+(p.id===(s.nextLaunchProfileId||s.launchProfileId)?'selected':'')+'>'+esc(p.label+' - '+p.behavior+(p.unsafe?' - unsafe':''))+'</option>').join('');
  document.getElementById('sessionControls').innerHTML=[
    caps.modelSelection?'<label>Model<select id="controlModel"'+disabledAttr('settings.write')+'>'+modelOptions+'</select></label>':'',
    caps.reasoningSelection?'<label>'+esc(c.reasoningLabel||'Reasoning')+'<select id="controlReasoning"'+disabledAttr('settings.write')+'>'+reasoningOptions+'</select></label>':'',
    caps.launchProfiles?'<label>Launch<select id="controlLaunch"'+disabledAttr('settings.write')+'>'+launchOptions+'</select></label><button id="applyLaunchBtn" class="secondary" title="Apply selected launch profile to the current idle session"'+disabledAttr('settings.write')+'>Apply to Current</button>':'',
    caps.fastMode?'<label class="checkbox"><input id="controlFast" type="checkbox" '+(s.fastMode?'checked':'')+disabledAttr('settings.write')+'> Fast mode</label>':''
  ].join('');
  const model=document.getElementById('controlModel'); if(model) model.onchange=()=>safe(async()=>{if(model.value){await api('/api/session/model',{method:'POST',body:JSON.stringify({model:model.value})});toast('Model updated');loadBootstrap()}});
  const reasoning=document.getElementById('controlReasoning'); if(reasoning) reasoning.onchange=()=>safe(async()=>{await api('/api/session/reasoning',{method:'POST',body:JSON.stringify({reasoning:reasoning.value})});toast((c.reasoningLabel||'Reasoning')+' updated');loadBootstrap()});
  const launch=document.getElementById('controlLaunch'); if(launch) launch.onchange=()=>safe(async()=>{await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId:launch.value})});toast('Launch profile updated');loadBootstrap()});
  const applyLaunch=document.getElementById('applyLaunchBtn'); if(applyLaunch&&launch) applyLaunch.onclick=()=>safe(async()=>{await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId:launch.value,apply:true})});toast('Launch profile applied to current session');loadBootstrap()});
  const fast=document.getElementById('controlFast'); if(fast) fast.onchange=()=>safe(async()=>{await api('/api/session/fast',{method:'POST',body:JSON.stringify({enabled:fast.checked})});toast('Fast mode updated');loadBootstrap()});
}
function renderAdapters(channels, agents){
  const channelCards=(channels||[]).map(c=>{const status=c.status==='available'?(c.enabled===false?'disabled':'enabled'):(c.status||'planned');return adapterCard(c.label,status,'',c.capabilities.join(', ')+(c.notes?' - '+c.notes:''))});
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
