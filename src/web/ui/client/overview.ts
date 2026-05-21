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
  renderPageTitle();
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
  syncActiveSessionsRefresh();
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
const ACTIVE_SESSIONS_TARGET_STORAGE_KEY='nordrelayActiveSessionsTarget';
function activeSessionsPeerOptions(){return (state.peers?.peers||[]).filter(peer=>peer?.enabled!==false&&peer?.id&&peer?.url)}
function activeSessionsTargetItems(){
  const peers=activeSessionsPeerOptions();
  const items:WebuiRecord[]=[{value:'local',label:'Local node',kind:'local'}];
  if(peers.length)items.unshift({value:'all',label:'All nodes',kind:'all'});
  peers.forEach(peer=>items.push({value:peer.id,label:peer.name||peer.url||peer.id,kind:'peer',peer}));
  return items;
}
function normalizeActiveSessionsTarget(){
  const items=activeSessionsTargetItems();
  const current=state.activeSessionsTarget||'local';
  const next=items.some(item=>item.value===current)?current:'local';
  if(next!==current){
    state.activeSessionsTarget=next;
    localStorage.setItem(ACTIVE_SESSIONS_TARGET_STORAGE_KEY,next);
  }
  return next;
}
function renderActiveSessionsTargetMenu(){
  const mount=document.getElementById('activeSessionsTarget');
  if(!mount)return;
  if(!can('sessions.read')){mount.innerHTML='';return}
  const items=activeSessionsTargetItems();
  normalizeActiveSessionsTarget();
  if(items.length<=1){mount.innerHTML='';return}
  const openList=mount.querySelector('[data-control-menu="activeSessionsNode"] .control-menu-list');
  if(openList&&!openList.hidden)return;
  const selected=items.find(item=>item.value===state.activeSessionsTarget)||items.find(item=>item.value==='local')||items[0];
  mount.innerHTML=compactControlMenu('activeSessionsNode','',selected.value,selected.label,items,'sessions.read');
  bindCompactControlMenus();
}
function activeSessionsTargetLabel(target){return target==='all'?'All nodes':target==='local'?'Local node':((state.peers?.peers||[]).find(peer=>peer.id===target)?.name||target)}
function activeSessionsFetchTargets(){
  const peers=activeSessionsPeerOptions();
  if((state.activeSessionsTarget||'local')==='all')return [{id:'local',label:'Local node',kind:'local'}].concat(peers.map(peer=>({id:peer.id,label:peer.name||peer.url||peer.id,kind:'peer',peer})));
  if((state.activeSessionsTarget||'local')==='local')return [{id:'local',label:'Local node',kind:'local'}];
  const peer=peers.find(item=>item.id===state.activeSessionsTarget);
  return peer?[{id:peer.id,label:peer.name||peer.url||peer.id,kind:'peer',peer}]:[{id:'local',label:'Local node',kind:'local'}];
}
function decorateActiveSessions(sessions,target){return (sessions||[]).map(session=>({...session,nodeId:target.id,nodeName:target.label,peerId:target.kind==='peer'?target.id:'local'}))}
async function fetchActiveSessionsFromTarget(target){
  const data=target.kind==='peer'?await apiPeer(target.id,'/api/active-sessions'):await api('/api/active-sessions',{local:true});
  return decorateActiveSessions(data.sessions||[],target);
}
function sortActiveSessions(items){return (items||[]).slice().sort((left,right)=>activeSessionDurationMs(right)-activeSessionDurationMs(left))}
async function loadActiveSessionsForSelectedTarget(){
  const targets=activeSessionsFetchTargets();
  if((state.activeSessionsTarget||'local')!=='all')return {sessions:sortActiveSessions(await fetchActiveSessionsFromTarget(targets[0])),errors:[]};
  const results=await Promise.all(targets.map(target=>fetchActiveSessionsFromTarget(target).then(sessions=>({target,sessions,error:null})).catch(error=>({target,sessions:[],error}))));
  return {sessions:sortActiveSessions(results.flatMap(result=>result.sessions)),errors:results.filter(result=>result.error).map(result=>({target:result.target.label,error:String(result.error?.message||result.error)}))};
}
async function loadActiveSessions(){
  const box=document.getElementById('activeSessions');
  if(!box&&state.currentPage==='overview')return;
  renderActiveSessionsTargetMenu();
  if(!can('sessions.read')){updateActiveSessionsCount([]);if(box)box.innerHTML='<div class="item">Permission required: sessions.read</div>';return}
  if(state.activeSessionsLoading)return;
  state.activeSessionsLoading=true;
  try{
    normalizeActiveSessionsTarget();
    const data=await loadActiveSessionsForSelectedTarget();
    state.activeSessionsErrors=data.errors||[];
    renderActiveSessions(data.sessions||[]);
  }finally{
    state.activeSessionsLoading=false;
  }
}
function shouldRefreshActiveSessions(){return can('sessions.read')}
function syncActiveSessionsRefresh(){if(shouldRefreshActiveSessions())startActiveSessionsRefresh();else stopActiveSessionsRefresh()}
function startActiveSessionsRefresh(){
  if(state.currentPage==='overview')startActiveSessionDurationCounter();
  if(state.activeSessionsTimer)return;
  state.activeSessionsTimer=setInterval(()=>{if(shouldRefreshActiveSessions()){if(!document.hidden)safe(loadActiveSessions)}else stopActiveSessionsRefresh()},5000);
}
function stopActiveSessionsRefresh(){
  if(state.activeSessionsTimer)clearInterval(state.activeSessionsTimer);
  state.activeSessionsTimer=null;
  stopActiveSessionDurationCounter();
}
function activeSessionDurationMs(s){const started=Date.parse(s.startedAt||'');if(Number.isFinite(started))return Math.max(0,Date.now()-started);return Number.isFinite(Number(s.durationMs))?Number(s.durationMs):0}
function activeSessionDurationHtml(s){const started=Date.parse(s.startedAt||'');const attrs=Number.isFinite(started)?' data-active-duration-started="'+attr(String(started))+'"':'';return '<span class="active-session-duration"'+attrs+'>'+esc(fmtDuration(activeSessionDurationMs(s)))+'</span>'}
function updateActiveSessionDurationCounters(){document.querySelectorAll('[data-active-duration-started]').forEach(el=>{const started=Number(el.dataset.activeDurationStarted);if(Number.isFinite(started))el.textContent=fmtDuration(Math.max(0,Date.now()-started))})}
function startActiveSessionDurationCounter(){updateActiveSessionDurationCounters();if(state.activeSessionDurationTimer)return;state.activeSessionDurationTimer=setInterval(()=>{if(state.currentPage!=='overview'){stopActiveSessionDurationCounter();return}updateActiveSessionDurationCounters()},1000)}
function stopActiveSessionDurationCounter(){if(state.activeSessionDurationTimer)clearInterval(state.activeSessionDurationTimer);state.activeSessionDurationTimer=null}
function updateActiveSessionsCount(items:WebuiActiveSession[]|number|undefined=undefined){
  const sessions=Array.isArray(items)?items:(Array.isArray(state.activeSessions?.sessions)?state.activeSessions.sessions:[]);
  const count=sessions.length;
  const approvalRequired=sessions.some(session=>Boolean(session?.approvalRequired));
  const heading=document.getElementById('activeSessionsCount');
  if(heading)heading.textContent='('+count+')';
  const badge=document.getElementById('overviewActiveBadge');
  if(badge){
    badge.textContent=String(count);
    badge.hidden=count<1;
    badge.classList.toggle('warning',approvalRequired);
    badge.title=approvalRequired?'Action required in active sessions':'Active sessions';
    badge.setAttribute('aria-label',count+' active session'+(count===1?'':'s')+(approvalRequired?' with approval required':''));
  }
}
function renderActiveSessions(items){
  state.activeSessions={sessions:items||[],updatedAt:new Date().toISOString()};
  updateActiveSessionsCount(items||[]);
  renderChatWorkingIndicator();
  const box=document.getElementById('activeSessions');
  if(!box)return;
  const errors=(state.activeSessionsErrors||[]).map(error=>'<div class="item active-session-error"><strong>'+esc(error.target||'Node')+'</strong><small>'+esc(error.error||'Active sessions unavailable')+'</small></div>').join('');
  box.innerHTML=errors+((items||[]).map(activeSessionCard).join('')||(!errors?'<div class="item">No active sessions.</div>':''));
  document.querySelectorAll('[data-active-copy]').forEach(b=>b.onclick=()=>copyText(b.dataset.activeCopy||'','Thread ID copied'));
  document.querySelectorAll('[data-active-switch]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('sessions.write')){toast('Permission required: sessions.write');return}const peerId=b.dataset.activePeer||'local';const agentId=b.dataset.activeAgent;const threadId=b.dataset.activeSwitch;if(peerId!==state.selectedPeer){state.selectedPeer=peerId;localStorage.setItem('nordrelayPeerTarget',peerId);connectEvents()}if(agentId&&state.snapshot?.session?.agentId!==agentId){await headerTargetRequest(peerId,'/api/agent',{method:'POST',body:{agentId}})}if(threadId){await headerTargetRequest(peerId,'/api/sessions/switch',{method:'POST',body:{threadId}})}toast('Session switched');await loadBootstrap();page('chat')}));
  document.querySelectorAll('[data-active-detail]').forEach(b=>b.onclick=()=>safe(async()=>{const peerId=b.dataset.activePeer||'local';const agentId=b.dataset.activeAgent;const threadId=b.dataset.activeDetail;if(peerId!==state.selectedPeer){state.selectedPeer=peerId;localStorage.setItem('nordrelayPeerTarget',peerId);connectEvents()}if(agentId&&state.snapshot?.session?.agentId!==agentId){await headerTargetRequest(peerId,'/api/agent',{method:'POST',body:{agentId}});await loadBootstrap()}if(threadId)await loadSessionDetail(threadId,agentId)}));
  applyPermissions();
  startActiveSessionDurationCounter();
}
function activeSessionCard(s){
  const processOnly=isProcessOnlyActiveSession(s);
  const thread=s.threadId||'';
  const threadLabel=thread||(processOnly?'Codex exec process':'not started');
  const threadText=s.sessionName||short(thread,64);
  const threadTitle=s.sessionName?('Copy thread ID: '+thread):'Copy thread ID';
  const threadDisplay=thread?'<button type="button" class="copy-id" data-active-copy="'+attr(thread)+'" title="'+attr(threadTitle)+'">'+esc(threadText)+'</button>':'<span class="active-session-process">'+esc(threadLabel)+'</span>';
  const prompt=processOnly?'<small>Prompt unavailable for process scan.</small>':(s.prompt?'<small>'+esc(short(s.prompt,250))+'</small>':'');
  const tool=s.currentTool||s.lastTool||'-';
  const queue=s.queueLength?(' · '+s.queueLength+' queued'+(s.queuePaused?' paused':'')):'';
  const sourceLabel=activeSourceLabel(s.source);
  const mirrors=(s.mirrorChannels||[]).map(m=>activeSourceLabel(m.source)+' '+m.mode+(m.queueLength?' · '+m.queueLength+' queued'+(m.queuePaused?' paused':''):'')).join(', ');
  const node=state.activeSessionsTarget==='all'&&s.nodeName?esc('Node '+s.nodeName):'';
  const meta=[node,esc('Source '+sourceLabel),s.workspace?esc(s.workspace):'',activeSessionDurationHtml(s),tool&&tool!=='-'?esc('tool '+tool):''].filter(Boolean).join(' | ');
  const mirrorLine=mirrors?'<small>Mirroring: '+esc(mirrors)+'</small>':(s.source==='cli'?'<small>Mirroring: none</small>':'');
  const approval=s.approvalRequired?'<small class="active-session-approval">Action required: '+esc(short(s.approvalRequired.command||s.approvalRequired.toolName||'',160))+'</small>':'';
  return '<div class="item active-session-item"><strong>'+esc(s.agentLabel||s.agentId||'Agent')+' <span class="adapter-status enabled">'+esc(s.status)+'</span></strong><small>'+threadDisplay+esc(queue)+'</small><small>'+meta+'</small>'+mirrorLine+approval+prompt+'<div class="row"><button data-active-switch="'+attr(thread)+'" data-active-agent="'+attr(s.agentId||'')+'" data-active-peer="'+attr(s.peerId||'local')+'" '+(!s.threadId?'disabled ':'')+disabledAttr('sessions.write')+'>Switch</button><button class="secondary" data-active-detail="'+attr(thread)+'" data-active-agent="'+attr(s.agentId||'')+'" data-active-peer="'+attr(s.peerId||'local')+'" '+(!s.threadId?'disabled ':'')+'>Details</button></div></div>';
}
function isProcessOnlyActiveSession(s){
  return !s.threadId&&String(s.contextKey||'').startsWith('process:codex:');
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
function compactControlMenu(id,label,value,display,items,permission='settings.write'){
  const options=(items||[]).map(item=>'<button type="button" role="option" data-control-option="'+attr(id)+'" data-control-value="'+attr(item.value)+'" aria-selected="'+(item.value===value?'true':'false')+'">'+esc(item.label)+'</button>').join('');
  return '<div class="compact-control" data-control-menu="'+attr(id)+'">'+(label?'<span class="compact-control-label">'+esc(label)+'</span>':'')+'<button type="button" id="'+attr(id)+'" class="control-menu-button" data-control-value="'+attr(value)+'" aria-haspopup="listbox" aria-expanded="false"'+(permission?disabledAttr(permission):'')+'>'+esc(display||'Default')+'</button><div class="control-menu-list" role="listbox" hidden>'+options+'</div></div>';
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
    if(id==='activeSessionsNode'){
      state.activeSessionsTarget=nextValue||'local';
      localStorage.setItem(ACTIVE_SESSIONS_TARGET_STORAGE_KEY,state.activeSessionsTarget);
      button.dataset.controlValue=state.activeSessionsTarget;
      button.textContent=option.textContent||activeSessionsTargetLabel(state.activeSessionsTarget);
      option.closest('.control-menu-list')?.querySelectorAll('[data-control-option]').forEach(item=>item.setAttribute('aria-selected',item===option?'true':'false'));
      closeCompactControlMenus();
      syncActiveSessionsRefresh();
      await loadActiveSessions();
      return;
    }
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
function channelSettingsGroup(adapter){return ({telegram:'Telegram',discord:'Discord',slack:'Slack',matrix:'Matrix'}[adapter?.id]||adapter?.label||'Chat')}
function bindAdapterSettingsLinks(root:Element|Document=document){
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
  ['interactiveApprovals','Approvals','Approve action-required prompts from WebUI and chat adapters'],
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
