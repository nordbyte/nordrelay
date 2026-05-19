async function loadBootstrap(){
  const local = await api('/api/bootstrap',{local:true});
  state.localBootstrap = local;
  state.auth = local.auth || null;
  state.csrfToken = local.auth?.csrfToken || state.csrfToken || null;
  state.permissions = local.auth?.permissions || [];
  applyAccountChrome(local.auth);
  await loadHeaderTargetCandidates(local);
  const data = state.selectedPeer && state.selectedPeer !== 'local' ? await api('/api/bootstrap') : local;
  state.snapshot = data.status.snapshot;
  state.controls = data.controls;
  state.enabledAgents = data.enabledAgents || [];
  mergeHeaderTargetBootstrap(state.selectedPeer||'local',data);
  applyPermissions();
  await refreshChatMirrorPreferenceForBootstrap();
  renderSnapshot(state.snapshot);
  void refreshRemoteHeaderTargets(local,data).catch(()=>renderHeaderTargetMenu(state.snapshot));
  safe(loadActiveSessions);
  renderSessionControls();
  populateNewSessionForm(data.enabledAgents);
  renderAdapters(data.channels, data.agentAdapters);
  document.getElementById('footerVersion').textContent='NordRelay '+(data.status.health?.version || '');
  document.getElementById('footerHealth').textContent='Health: '+footerHealthLabel(data.status.health?.state?.status);
  renderFooterUser(local.auth);
  applyPermissions();
}
async function refreshChatMirrorPreferenceForBootstrap(){
  if(state.currentPage!=='chat'||!can('sessions.read'))return;
  try{
    const data=await api('/api/chat/mirror');
    if(data)state.webMirror=data;
  }catch{}
}
function footerHealthLabel(status){
  if(status==='ready')return'healthy';
  if(status==='starting')return'starting';
  if(status==='stopped')return'stopped';
  if(status==='error')return'error';
  return status||'unknown';
}
function renderFooterUser(auth){
  const el=document.getElementById('footerUser');
  if(!el)return;
  const email=auth?.user?.email||'-';
  const remoteSuffix=state.selectedPeer&&state.selectedPeer!=='local'?' / target peer':'';
  el.innerHTML='User: '+(email&&email!=='-'?'<a href="#profile" class="footer-profile-link" id="footerProfileLink" title="Open profile">'+esc(email)+'</a>':esc(email))+esc(remoteSuffix);
  const link=document.getElementById('footerProfileLink');
  if(link)link.onclick=event=>safe(openProfileDialog,event);
}
function renderSnapshot(s){
  renderHeaderTargetMenu(s);
  const fastValue=s.session.capabilities&&s.session.capabilities.fastMode?(s.session.fastMode?'on':'off'):'n/a';
  const metrics=document.getElementById('metrics');
  metrics.innerHTML=[
    metricHtml('Current Session',esc(s.processing?'working':'idle')+metricThreadCopyHtml(s.session.threadId)),
    metricHtml('Queue',esc(s.queue.length)),
    metricHtml('Workspace',esc(s.session.workspace)),
    metricHtml('Agent / Model',esc(sessionAgentModelText(s.session))),
    metricHtml('Reasoning / Fast',esc((s.session.reasoningEffort||'default')+' / '+fastValue)),
    metricHtml('Permissions',esc(launchPermissionsText(s.session)))
  ].join('');
  bindUiCopyButtons(metrics);
  renderQueue(s.queue,s.queuePaused);
}
function metricHtml(label,valueHtml){return '<div class="metric"><div class="label">'+esc(label)+'</div><div class="value">'+valueHtml+'</div></div>'}
function sessionAgentModelText(session){return [(session.agentLabel||session.agentId||'Agent'),(session.model||'default')].filter(Boolean).join(' / ')}
function metricThreadCopyHtml(thread){
  return thread?' <button type="button" class="copy-id metric-thread-copy" data-copy-value="'+attr(thread)+'" data-copy-label="Thread ID copied" title="Copy thread ID" aria-label="Copy thread ID"><span class="copy-icon" aria-hidden="true"></span></button>':'';
}
function renderChatWorkspaceLine(){
  const line=document.getElementById('chatWorkspaceLine');
  if(!line)return;
  const session=state.snapshot?.session||{};
  const workspace=session.workspace||'';
  if(!workspace){
    line.hidden=true;
    line.innerHTML='';
    return;
  }
  const peer=state.selectedPeer&&state.selectedPeer!=='local'?headerTargetName(state.selectedPeer):'';
  const label=peer?'Workspace on '+peer:'Workspace';
  line.hidden=false;
  line.innerHTML='<span class="chat-workspace-label">'+esc(label)+'</span><button type="button" class="copy-id chat-workspace-path" data-copy-value="'+attr(workspace)+'" data-copy-label="Workspace path copied" title="'+attr(workspace)+'" aria-label="Copy workspace path">'+esc(shortMiddle(workspace,18,52))+'</button>';
  bindUiCopyButtons(line);
}
function launchPermissionsText(session){
  if(!session?.capabilities?.launchProfiles)return'n/a';
  const selectedLaunch=session.launchProfileId||session.nextLaunchProfileId;
  const profile=(state.controls?.launchProfiles||[]).find(p=>p.id===selectedLaunch);
  return profile?.behavior||session.launchProfileBehavior||session.nextLaunchProfileBehavior||'-';
}
async function loadActiveSessions(){
  const box=document.getElementById('activeSessions');
  if(!box)return;
  if(!can('sessions.read')){updateActiveSessionsCount([]);box.innerHTML='<div class="item">Permission required: sessions.read</div>';return}
  const data=await api('/api/active-sessions');
  renderActiveSessions(data.sessions||[]);
}
function updateActiveSessionsCount(items:any=undefined){
  const sessions=Array.isArray(items)?items:(Array.isArray(state.activeSessions?.sessions)?state.activeSessions.sessions:[]);
  const count=sessions.length;
  const heading=document.getElementById('activeSessionsCount');
  if(heading)heading.textContent='('+count+')';
  const badge=document.getElementById('overviewActiveBadge');
  if(badge){
    badge.textContent=String(count);
    badge.hidden=count<1;
    badge.setAttribute('aria-label',count+' active session'+(count===1?'':'s'));
  }
}
function renderActiveSessions(items){
  state.activeSessions={sessions:items||[],updatedAt:new Date().toISOString()};
  updateActiveSessionsCount(items||[]);
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
  const modelItems=[{value:'',label:'Default'}].concat((c.models||[]).map(m=>({value:m.slug,label:modelLabel(m)})));
  const selectedModel=modelItems.find(item=>item.value===s.model)||(s.model?{value:s.model,label:s.model}:modelItems[0]);
  const reasoningItems=(c.reasoningOptions||[]).map(v=>({value:v,label:v}));
  const selectedReasoning=reasoningItems.find(item=>item.value===s.reasoningEffort)||(s.reasoningEffort?{value:s.reasoningEffort,label:s.reasoningEffort}:reasoningItems[0]);
  const fastItems=[{value:'on',label:'on'},{value:'off',label:'off'}];
  const selectedFast=s.fastMode?'on':'off';
  const selectedLaunch=activeLaunchProfileId(s);
  const launchItems=launchMenuItems(c,s,selectedLaunch);
  const selectedLaunchItem=launchItems.find(item=>item.value===selectedLaunch)||launchItems[0];
  const mirrorItems=[{value:'off',label:'off'},{value:'status',label:'status'},{value:'final',label:'final'},{value:'full',label:'full'}];
  const selectedMirror=state.webMirror?.mode||'off';
  document.getElementById('sessionControls').innerHTML=[
    caps.modelSelection?compactControlMenu('controlModel','Model',selectedModel?.value||'',selectedModel?.label||'Default',modelItems):'',
    caps.reasoningSelection?compactControlMenu('controlReasoning',c.reasoningLabel||'Reasoning',selectedReasoning?.value||'',selectedReasoning?.label||'Default',reasoningItems):'',
    caps.fastMode?compactControlMenu('controlFast','Fast mode',selectedFast,selectedFast,fastItems):'',
    caps.launchProfiles?compactControlMenu('controlLaunch','Launch',selectedLaunchItem?.value||'',selectedLaunchItem?.label||'Default',launchItems):'',
    compactControlMenu('controlMirror','Mirror',selectedMirror,selectedMirror,mirrorItems),
    caps.launchProfiles?'<button id="applyLaunchBtn" class="secondary compact-apply-button" title="Apply selected launch profile to the current idle session"'+disabledAttr('settings.write')+'>Apply</button>':''
  ].join('');
  bindCompactControlMenus();
  renderChatWorkspaceLine();
  const applyLaunch=document.getElementById('applyLaunchBtn'); if(applyLaunch) applyLaunch.onclick=()=>safe(async()=>{const profileId=selectedCompactControlValue('controlLaunch');if(!configuredLaunchProfile(c,profileId)){toast('Select a configured launch profile first');return}await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId,apply:true})});toast('Launch profile applied to current session');loadBootstrap()});
}
function activeLaunchProfileId(session){return session.launchProfileId||session.nextLaunchProfileId||''}
function launchMenuItems(controls,session,selectedLaunch){
  const items=(controls.launchProfiles||[]).map(p=>({value:p.id,label:p.label+' - '+p.behavior+(p.unsafe?' - unsafe':'')}));
  if(selectedLaunch&&!items.some(item=>item.value===selectedLaunch)){
    items.unshift({value:selectedLaunch,label:activeLaunchLabel(session,selectedLaunch)});
  }
  return items;
}
function activeLaunchLabel(session,selectedLaunch){
  const label=session.launchProfileLabel||session.nextLaunchProfileLabel||selectedLaunch||'Current launch';
  const behavior=session.launchProfileBehavior||session.nextLaunchProfileBehavior||'';
  const unsafe=session.unsafeLaunch||session.nextUnsafeLaunch;
  return label+(behavior?' - '+behavior:'')+(unsafe?' - unsafe':'');
}
function configuredLaunchProfile(controls,profileId){return Boolean(profileId&&(controls.launchProfiles||[]).some(p=>p.id===profileId))}
function compactControlMenu(id,label,value,display,items){
  const options=(items||[]).map(item=>'<button type="button" role="option" data-control-option="'+attr(id)+'" data-control-value="'+attr(item.value)+'" aria-selected="'+(item.value===value?'true':'false')+'">'+esc(item.label)+'</button>').join('');
  return '<div class="compact-control" data-control-menu="'+attr(id)+'"><span class="compact-control-label">'+esc(label)+'</span><button type="button" id="'+attr(id)+'" class="control-menu-button" data-control-value="'+attr(value)+'" aria-haspopup="listbox" aria-expanded="false"'+disabledAttr('settings.write')+'>'+esc(display||'Default')+'</button><div class="control-menu-list" role="listbox" hidden>'+options+'</div></div>';
}
function selectedCompactControlValue(id){return document.getElementById(id)?.dataset.controlValue||''}
function closeCompactControlMenus(except=null){
  document.querySelectorAll('.compact-control').forEach(menu=>{
    if(except&&menu===except)return;
    menu.querySelector('.control-menu-list')?.setAttribute('hidden','');
    menu.querySelector('.control-menu-button')?.setAttribute('aria-expanded','false');
  });
}
function bindCompactControlMenus(){
  document.querySelectorAll('.compact-control').forEach(menu=>{
    const button=menu.querySelector('.control-menu-button');
    const list=menu.querySelector('.control-menu-list');
    if(!button||!list)return;
    button.onclick=event=>{event.preventDefault();event.stopPropagation();if(button.disabled)return;const open=list.hidden;closeCompactControlMenus(menu);list.hidden=!open;button.setAttribute('aria-expanded',open?'true':'false')};
  });
  document.querySelectorAll('[data-control-option]').forEach(option=>option.onclick=event=>safe(async()=>{
    event.preventDefault();event.stopPropagation();
    const id=option.dataset.controlOption;
    const button=document.getElementById(id);
    if(!button||button.disabled)return;
    const nextValue=option.dataset.controlValue||'';
    const previousValue=button.dataset.controlValue||'';
    const previousText=button.textContent||'Default';
    if(id==='controlMirror'){
      closeCompactControlMenus();
      button.textContent='Saving...';
      button.setAttribute('aria-busy','true');
      try{
        await setMirrorPreference(nextValue||'off');
      }catch(error){
        button.dataset.controlValue=previousValue;
        button.textContent=previousText;
        option.closest('.control-menu-list')?.querySelectorAll('[data-control-option]').forEach(item=>item.setAttribute('aria-selected',item.dataset.controlValue===previousValue?'true':'false'));
        throw error;
      }finally{
        button.removeAttribute('aria-busy');
      }
      return;
    }
    button.dataset.controlValue=nextValue;
    button.textContent=option.textContent||'Default';
    option.closest('.control-menu-list')?.querySelectorAll('[data-control-option]').forEach(item=>item.setAttribute('aria-selected',item===option?'true':'false'));
    closeCompactControlMenus();
    if(id==='controlModel'){
      if(button.dataset.controlValue){await api('/api/session/model',{method:'POST',body:JSON.stringify({model:button.dataset.controlValue})});toast('Model updated');loadBootstrap()}
    }else if(id==='controlReasoning'){
      await api('/api/session/reasoning',{method:'POST',body:JSON.stringify({reasoning:button.dataset.controlValue})});toast(((state.controls||{}).reasoningLabel||'Reasoning')+' updated');loadBootstrap();
    }else if(id==='controlFast'){
      await api('/api/session/fast',{method:'POST',body:JSON.stringify({enabled:button.dataset.controlValue==='on'})});toast('Fast mode updated');loadBootstrap();
    }else if(id==='controlLaunch'){
      await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId:button.dataset.controlValue})});toast('Launch profile updated');loadBootstrap();
    }
  },event));
  if(!state.compactControlOutsideBound){
    state.compactControlOutsideBound=true;
    document.addEventListener('click',event=>{if(!event.target.closest?.('.compact-control'))closeCompactControlMenus()});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closeCompactControlMenus()});
  }
}
function renderAdapters(channels, agents){
  const channelCards=(channels||[]).map(c=>{const status=c.status==='available'?(c.enabled===false?'disabled':'enabled'):(c.status||'planned');return adapterCard(c.label,status,'',c.capabilities.join(', ')+(c.notes?' - '+c.notes:''),channelSettingsGroup(c))});
  const agentCards=(agents||[]).map(a=>{const available=a.status==='available';const status=available?(state.enabledAgents.includes(a.id)?'enabled':'disabled'):(a.status||'planned');return adapterCard(a.label,status,'',a.notes||'',agentSettingsGroup(a))});
  document.getElementById('agentAdapters').innerHTML='<div class="list">'+(agentCards.join('')||'<div class="item">No agent adapters.</div>')+'</div>';
  document.getElementById('chatAdapters').innerHTML='<div class="list">'+(channelCards.join('')||'<div class="item">No chat adapters.</div>')+'</div>';
  bindAdapterSettingsLinks();
}
function adapterCard(label,status,detail,tooltip='',settingsGroup=''){
  const settingsButton=(status==='enabled'||status==='disabled')&&settingsGroup?'<button type="button" class="adapter-settings-link" data-settings-group="'+attr(settingsGroup)+'" title="Open '+attr(settingsGroup)+' settings" aria-label="Open '+attr(settingsGroup)+' settings"><span class="adapter-settings-icon" aria-hidden="true">&#9881;</span></button>':'';
  return '<div class="item adapter-overview-card"><div class="adapter-overview-header"><strong title="'+attr(tooltip)+'">'+esc(label)+' <span class="adapter-status '+esc(status)+'">'+esc(status)+'</span></strong>'+settingsButton+'</div>'+(detail?'<small>'+esc(detail)+'</small>':'')+'</div>';
}
function agentSettingsGroup(adapter){return ({codex:'Codex',pi:'Pi',hermes:'Hermes',openclaw:'OpenClaw','claude-code':'Claude Code'}[adapter?.id]||adapter?.label||'Agents')}
function channelSettingsGroup(adapter){return ({telegram:'Telegram',discord:'Discord',slack:'Slack'}[adapter?.id]||adapter?.label||'Chat')}
function bindAdapterSettingsLinks(root:any=document){
  root.querySelectorAll?.('[data-settings-group]').forEach(button=>button.onclick=()=>{state.settingsGroup=button.dataset.settingsGroup||null;page('settings')});
}
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
