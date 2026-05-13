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
  state.auth = data.auth || null;
  state.permissions = data.auth?.permissions || [];
  state.snapshot = data.status.snapshot;
  state.controls = data.controls;
  state.enabledAgents = data.enabledAgents || [];
  applyPermissions();
  renderSnapshot(state.snapshot);
  renderSessionControls();
  populateNewSessionForm(data.enabledAgents);
  renderAdapters(data.channels, data.agentAdapters);
  document.getElementById('footerVersion').textContent='NordRelay '+(data.status.health?.version || '');
  document.getElementById('footerHealth').textContent='Health: '+(data.status.health?.state?.status || 'unknown');
  document.getElementById('footerUser').textContent='User: '+(data.auth?.user?.email || '-');
  const agentSelect=document.getElementById('agentSelect');
  agentSelect.innerHTML=data.enabledAgents.map(a=>'<option value="'+a+'">'+a+'</option>').join('');
  agentSelect.value=state.snapshot.session.agentId;
  agentSelect.onchange=()=>safe(async()=>{const selected=agentSelect.value;const r=await api('/api/agent',{method:'POST',body:JSON.stringify({agentId:selected})});if(state.snapshot&&r.session){state.snapshot.session=r.session;renderSnapshot(state.snapshot)}toast('Agent switched');await loadBootstrap();await reloadCurrentPage({agentId:selected})});
  applyPermissions();
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
    caps.modelSelection?'<label>Model<select id="controlModel"'+disabledAttr('settings.write')+'>'+modelOptions+'</select></label>':'',
    caps.reasoningSelection?'<label>'+esc(c.reasoningLabel||'Reasoning')+'<select id="controlReasoning"'+disabledAttr('settings.write')+'>'+reasoningOptions+'</select></label>':'',
    caps.launchProfiles?'<label>Launch<select id="controlLaunch"'+disabledAttr('settings.write')+'>'+launchOptions+'</select></label>':'',
    caps.fastMode?'<label class="checkbox"><input id="controlFast" type="checkbox" '+(s.fastMode?'checked':'')+disabledAttr('settings.write')+'> Fast mode</label>':''
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
