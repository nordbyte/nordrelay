async function loadBootstrap(options:WebuiRecord={}){
  const local = await api('/api/bootstrap',{local:true});
  state.localBootstrap = local;
  state.auth = local.auth || null;
  state.csrfToken = local.auth?.csrfToken || state.csrfToken || null;
  state.permissions = local.auth?.permissions || [];
  applyAccountChrome(local.auth);
  await loadHeaderTargetCandidates(local);
  state.snapshot = local.status.snapshot;
  state.snapshotPeerId = 'local';
  state.controls = local.controls;
  state.enabledAgents = local.enabledAgents || [];
  mergeHeaderTargetBootstrap('local',local);
  pruneMirroredLocalSnapshotChatTabs(local);
  renderPageTitle();
  applyPermissions();
  renderHeaderTargetMenu(state.snapshot);
  let data = local;
  let dataPeerId = 'local';
  let remoteBootstrapError = null;
  const selectedPeer = state.selectedPeer || 'local';
  const bootstrapContextKey=String(options.contextKey||'');
  if(selectedPeer !== 'local'){
    try{
      data = await apiPeer(selectedPeer,'/api/bootstrap',{timeoutMs:HEADER_TARGET_PEER_TIMEOUT_MS,...(bootstrapContextKey?{contextKey:bootstrapContextKey}:{})});
      dataPeerId = selectedPeer;
      mergeHeaderTargetBootstrap(selectedPeer,data);
    }catch(error){
      remoteBootstrapError = error;
      markHeaderTargetError(selectedPeer,error);
      setApiState('peer-unreachable',{target:selectedPeer,message:'Peer '+headerTargetName(selectedPeer)+' is unreachable. Select another node from the header.',retryAfterMs:5000});
      data = local;
    }
  }
  state.snapshot = data.status.snapshot;
  state.snapshotPeerId = dataPeerId;
  state.controls = data.controls;
  state.enabledAgents = data.enabledAgents || [];
  if(!remoteBootstrapError) mergeHeaderTargetBootstrap(state.selectedPeer||'local',data);
  renderPageTitle();
  applyPermissions();
  renderSnapshot(state.snapshot);
  void refreshRemoteHeaderTargets(local,remoteBootstrapError?null:data).catch(()=>renderHeaderTargetMenuIfClosed(state.snapshot));
  safe(loadActiveSessions);
  renderSessionControls();
  syncCurrentSessionChatTab({activate:state.currentPage==='chat'&&!state.activeChatTabId});
  renderChatTabs();
  populateNewSessionForm(data.enabledAgents);
  renderAdapters(data.channels, data.agentAdapters);
  document.getElementById('footerVersion').textContent='NordRelay '+(data.status.health?.version || '');
  document.getElementById('footerHealth').textContent='Health: '+footerHealthLabel(data.status.health?.state?.status);
  renderFooterUser(local.auth);
  syncActiveSessionsRefresh();
  safe(loadPluginPanelNav);
  applyPermissions();
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
  renderHeaderTargetMenuIfClosed(s);
  const fastValue=s.session.capabilities&&s.session.capabilities.fastMode?(s.session.fastMode?'on':'off'):'n/a';
  const metrics=document.getElementById('metrics');
  metrics.innerHTML=[
    metricHtml('Current Session',esc(s.processing?'working':'idle')+metricThreadCopyHtml(s.session.threadId)),
    metricHtml('Queue',esc(queuedQueueCount(s.queue))),
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
function updateSnapshotQueue(queue,paused){
  const items=Array.isArray(queue)?queue:[];
  updateQueueNavBadge(items);
  if(!state.snapshot)return;
  state.snapshot.queue=items;
  state.snapshot.queuePaused=Boolean(paused);
  if(state.currentPage==='chat')renderChatWorkspaceLine();
}
function updateCurrentChatQueue(queue,paused){
  if(!state.snapshot)return;
  state.snapshot.queue=Array.isArray(queue)?queue:[];
  state.snapshot.queuePaused=Boolean(paused);
  if(state.currentPage==='chat')renderChatWorkspaceLine();
}
function updateQueueNavBadge(queue){
  const count=Array.isArray(queue)?queuedQueueCount(queue):Math.max(0,Number(queue)||0);
  const badge=document.getElementById('queueNavBadge');
  if(!badge)return;
  badge.textContent=String(count);
  badge.hidden=count<1;
  badge.title='Queued prompts';
  badge.setAttribute('aria-label',count+' queued prompt'+(count===1?'':'s'));
}
function queuedQueueItems(queue){
  return (Array.isArray(queue)?queue:[]).filter(item=>(item?.status||'queued')==='queued');
}
function queuedQueueCount(queue){
  return queuedQueueItems(queue).length;
}
function currentChatQueueState(){
  const queue=state.snapshot?.queue;
  if(Array.isArray(queue))return{length:queuedQueueCount(queue),paused:Boolean(state.snapshot?.queuePaused)};
  const session=state.snapshot?.session||{};
  const active=(state.activeSessions?.sessions||[]).find(item=>String(item.threadId||'')===String(session.threadId||'')&&(!session.agentId||!item.agentId||String(item.agentId)===String(session.agentId)));
  const length=Number(active?.queueLength||0);
  return{length:Number.isFinite(length)&&length>0?length:0,paused:Boolean(active?.queuePaused)};
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
  const queue=currentChatQueueState();
  const queueLabel=queue.length>0?queue.length+' in queue'+(queue.paused?' paused':''):'';
  const meta=[label,queueLabel].filter(Boolean).join(' · ');
  line.hidden=false;
  line.innerHTML='<span class="chat-workspace-label">'+esc(meta)+'</span><button type="button" class="copy-id chat-workspace-path" data-copy-value="'+attr(workspace)+'" data-copy-label="Workspace path copied" title="'+attr(workspace)+'" aria-label="Copy workspace path">'+esc(shortMiddle(workspace,18,52))+'</button>';
  bindUiCopyButtons(line);
}
function launchPermissionsText(session){
  if(!session?.capabilities?.launchProfiles)return'n/a';
  const selectedLaunch=activeLaunchProfileId(session,state.controls||{});
  const profile=(state.controls?.launchProfiles||[]).find(p=>p.id===selectedLaunch);
  if(session.launchProfileBehavior)return session.launchProfileBehavior;
  if(profile&&launchProfileBehaviorMatches(profile,session))return profile.behavior;
  return session.nextLaunchProfileBehavior||profile?.behavior||'-';
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
function activeSessionsTargetForPeerId(peerId){
  if(!peerId||peerId==='local')return{id:'local',label:'Local node',kind:'local'};
  const peer=activeSessionsPeerOptions().find(item=>item.id===peerId);
  return{id:peerId,label:peer?.name||peer?.url||headerTargetName(peerId),kind:'peer',peer};
}
function chatTabActiveSessionsFetchTargets(){
  const peerIds=new Set<string>();
  ensureChatTabs().forEach(tab=>peerIds.add(tab.peerId||'local'));
  peerIds.add(state.selectedPeer||'local');
  return Array.from(peerIds).map(activeSessionsTargetForPeerId);
}
function decorateActiveSessions(sessions,target){return (sessions||[]).map(session=>({...session,nodeId:target.id,nodeName:target.label,peerId:target.kind==='peer'?target.id:'local'}))}
async function fetchActiveSessionsFromTarget(target){
  if(target.kind==='peer'){
    const retryAt=state.activeSessionsPeerBackoff?.[target.id]||0;
    if(retryAt>Date.now())throw new Error('Peer active-session refresh is cooling down for '+fmtDuration(retryAt-Date.now()));
  }
  try{
    const data=target.kind==='peer'?await apiPeer(target.id,'/api/active-sessions'):await api('/api/active-sessions',{local:true});
    if(target.kind==='peer'&&state.activeSessionsPeerBackoff)delete state.activeSessionsPeerBackoff[target.id];
    return decorateActiveSessions(data.sessions||[],target);
  }catch(error){
    if(target.kind==='peer'&&isTransientPeerRefreshError(error))state.activeSessionsPeerBackoff[target.id]=Date.now()+15_000;
    throw error;
  }
}
function sortActiveSessions(items){return (items||[]).slice().sort((left,right)=>activeSessionDurationMs(right)-activeSessionDurationMs(left))}
function activeSessionsErrorsFromResults(results){
  return results
    .filter(result=>result.error&&!isTransientPeerRefreshError(result.error))
    .map(result=>({target:result.target.label,error:String(result.error?.message||result.error)}));
}
async function loadActiveSessionsForSelectedTarget(){
  const targets=activeSessionsFetchTargets();
  if((state.activeSessionsTarget||'local')!=='all')return {sessions:sortActiveSessions(await fetchActiveSessionsFromTarget(targets[0])),errors:[]};
  const results=await Promise.all(targets.map(target=>fetchActiveSessionsFromTarget(target).then(sessions=>({target,sessions,error:null})).catch(error=>({target,sessions:[],error}))));
  return {sessions:sortActiveSessions(results.flatMap(result=>result.sessions)),errors:activeSessionsErrorsFromResults(results)};
}
async function loadActiveSessionsForChatTabs(){
  const targets=chatTabActiveSessionsFetchTargets();
  const results=await Promise.all(targets.map(target=>fetchActiveSessionsFromTarget(target).then(sessions=>({target,sessions,error:null})).catch(error=>({target,sessions:[],error}))));
  return {sessions:sortActiveSessions(results.flatMap(result=>result.sessions)),errors:activeSessionsErrorsFromResults(results)};
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
    const data=state.currentPage==='chat'?await loadActiveSessionsForChatTabs():await loadActiveSessionsForSelectedTarget();
    state.activeSessionsErrors=data.errors||[];
    state.activeSessionsLoadedTarget=state.currentPage==='chat'?'chat-tabs':state.activeSessionsTarget||'local';
    if(state.currentPage==='chat')syncChatTabsFromActiveSessions(data.sessions||[]);
    renderActiveSessions(data.sessions||[]);
  }catch(error){
    if(!isApiStateError(error))throw error;
    state.activeSessionsErrors=[];
    const loadedTarget=state.activeSessionsLoadedTarget||'';
    const currentTarget=state.currentPage==='chat'?'chat-tabs':state.activeSessionsTarget||'local';
    if(loadedTarget===currentTarget&&state.activeSessions?.sessions?.length){
      setApiState('stale-data',{target:error.apiTarget,message:'Showing the last active-session data while this node reconnects.',incrementFailure:false});
      renderActiveSessions(state.activeSessions.sessions);
    }else{
      renderActiveSessions([]);
    }
  }finally{
    state.activeSessionsLastLoadAt=Date.now();
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
function isTransientPeerRefreshError(error){
  const message=String(error?.message||error||'').toLowerCase();
  return [
    'timed out',
    'timeout',
    'unreachable',
    'failed to fetch',
    'network',
    'cooling down',
    'ehostunreach',
    'enetunreach',
    'econnrefused',
    'enotfound',
    'etimedout',
    'eai_again',
    'socket hang up',
  ].some(fragment=>message.includes(fragment));
}
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
  if(state.currentPage==='chat')renderSessionControls();
  renderChatTabs();
  const box=document.getElementById('activeSessions');
  if(!box)return;
  const errors=(state.activeSessionsErrors||[]).map(error=>'<div class="item active-session-error"><strong>'+esc(error.target||'Node')+'</strong><small>'+esc(error.error||'Active sessions unavailable')+'</small></div>').join('');
  box.innerHTML=errors+((items||[]).map(activeSessionCard).join('')||(!errors?'<div class="item">No active sessions.</div>':''));
  document.querySelectorAll('[data-active-copy]').forEach(b=>b.onclick=()=>copyText(b.dataset.activeCopy||'','Thread ID copied'));
  document.querySelectorAll('[data-active-switch]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('sessions.write')){toast('Permission required: sessions.write');return}const peerId=b.dataset.activePeer||'local';const agentId=b.dataset.activeAgent;const threadId=b.dataset.activeSwitch;const active=(state.activeSessions?.sessions||[]).find(item=>item.threadId===threadId&&(item.peerId||'local')===peerId);await openChatSession(chatTabFromActiveSession(active||{peerId,agentId,threadId} as WebuiActiveSession)||{peerId,agentId,threadId},{navigate:true})}));
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
  const c=state.controls||{};const s=currentControlSession();const caps=c.capabilities||{};
  const lockedTitle=chatSessionControlLockTitle();
  const modelItems=[{value:'',label:'Default'}].concat((c.models||[]).map(m=>({value:m.slug,label:modelLabel(m)})));
  const selectedModel=modelItems.find(item=>item.value===s.model)||(s.model?{value:s.model,label:s.model}:modelItems[0]);
  const reasoningItems=(c.reasoningOptions||[]).map(v=>({value:v,label:v}));
  const selectedReasoning=reasoningItems.find(item=>item.value===s.reasoningEffort)||(s.reasoningEffort?{value:s.reasoningEffort,label:s.reasoningEffort}:{value:'',label:'Default'});
  const fastItems=[{value:'on',label:'on'},{value:'off',label:'off'}];
  const selectedFast=s.fastMode?'on':'off';
  const selectedLaunch=activeLaunchProfileId(s,c);
  const launchItems=launchMenuItems(c,s,selectedLaunch);
  const selectedLaunchItem=launchItems.find(item=>item.value===selectedLaunch)||launchItems[0];
  const launchControlLabel=isCodexControlSession(s)?'Permissions':'Launch';
  document.getElementById('sessionControls').innerHTML=[
    caps.modelSelection?compactControlMenu('controlModel','Model',selectedModel?.value||'',selectedModel?.label||'Default',modelItems,'settings.write',lockedTitle):'',
    caps.reasoningSelection?compactControlMenu('controlReasoning',c.reasoningLabel||'Reasoning',selectedReasoning?.value||'',selectedReasoning?.label||'Default',reasoningItems,'settings.write',lockedTitle):'',
    caps.fastMode?compactControlMenu('controlFast','Fast mode',selectedFast,selectedFast,fastItems,'settings.write',lockedTitle):'',
    caps.launchProfiles?compactControlMenu('controlLaunch',launchControlLabel,selectedLaunchItem?.value||'',selectedLaunchItem?.label||'Ask for approval',launchItems,'settings.write',lockedTitle):''
  ].join('');
  bindCompactControlMenus();
  renderChatWorkspaceLine();
}
function chatSessionControlLockTitle(){return currentChatWorkingSession()?'Wait until the current session finishes before changing model, reasoning, fast mode, or launch.':''}
function activeControlSessionForTab(tab: WebuiChatTab | null): WebuiActiveSession | null {
  if(!tab?.threadId)return null;
  const tabPeer=String(tab.peerId||'local');
  const tabAgent=String(tab.agentId||'');
  const tabThread=String(tab.threadId||'');
  return (state.activeSessions?.sessions||[]).find(item=>{
    const itemPeer=String(item.peerId||item.nodeId||'local');
    if(itemPeer!==tabPeer)return false;
    if(String(item.threadId||'')!==tabThread)return false;
    const itemAgent=String(item.agentId||'');
    return !tabAgent||!itemAgent||tabAgent===itemAgent;
  })||null;
}
function currentControlSession(): WebuiSessionSnapshot {
  const snapshot=state.snapshot?.session||{};
  const tab=state.currentPage==='chat'?activeChatTab():null;
  if(!tab?.threadId)return snapshot;
  const tabPeer=String(tab.peerId||'local');
  if(tabPeer!==String(state.selectedPeer||'local'))return snapshot;
  const snapshotMatchesTab=String(state.snapshotPeerId||'local')===tabPeer&&String(snapshot.threadId||'')===String(tab.threadId||'');
  const source: WebuiSessionSnapshot=snapshotMatchesTab?snapshot:{};
  const active=activeControlSessionForTab(tab);
  return {
    ...tab,
    ...active,
    ...source,
    agentId:String(source.agentId||active?.agentId||tab.agentId||''),
    agentLabel:String(source.agentLabel||active?.agentLabel||tab.agentLabel||source.agentId||active?.agentId||tab.agentId||''),
    threadId:String(source.threadId||active?.threadId||tab.threadId||''),
    sessionName:String(source.sessionName||active?.sessionName||tab.sessionName||''),
    workspace:String(source.workspace||active?.workspace||tab.workspace||''),
    model:String(source.model||active?.model||tab.model||''),
    reasoningEffort:String(source.reasoningEffort||active?.reasoningEffort||tab.reasoningEffort||''),
    fastMode:typeof source.fastMode==='boolean'?source.fastMode:(typeof active?.fastMode==='boolean'?active.fastMode:tab.fastMode),
    launchProfileId:String(source.launchProfileId||active?.launchProfileId||tab.launchProfileId||''),
    nextLaunchProfileId:String(source.nextLaunchProfileId||active?.nextLaunchProfileId||tab.nextLaunchProfileId||''),
    launchProfileLabel:String(source.launchProfileLabel||active?.launchProfileLabel||tab.launchProfileLabel||''),
    launchProfileBehavior:String(source.launchProfileBehavior||active?.launchProfileBehavior||tab.launchProfileBehavior||''),
    sandboxMode:String(source.sandboxMode||active?.sandboxMode||tab.sandboxMode||''),
    approvalPolicy:String(source.approvalPolicy||active?.approvalPolicy||tab.approvalPolicy||''),
    approvalsReviewer:String(source.approvalsReviewer||active?.approvalsReviewer||tab.approvalsReviewer||''),
    activeLaunchProfileId:String(source.activeLaunchProfileId||active?.activeLaunchProfileId||tab.activeLaunchProfileId||''),
    nextLaunchProfileLabel:String(source.nextLaunchProfileLabel||active?.nextLaunchProfileLabel||tab.nextLaunchProfileLabel||''),
    nextLaunchProfileBehavior:String(source.nextLaunchProfileBehavior||active?.nextLaunchProfileBehavior||tab.nextLaunchProfileBehavior||''),
    nextUnsafeLaunch:typeof source.nextUnsafeLaunch==='boolean'?source.nextUnsafeLaunch:(typeof active?.nextUnsafeLaunch==='boolean'?active.nextUnsafeLaunch:tab.nextUnsafeLaunch),
  };
}
function currentControlAgentId(session: WebuiSessionSnapshot = state.snapshot?.session||{}){
  const tab=state.currentPage==='chat'?activeChatTab():null;
  return String(session?.agentId||tab?.agentId||state.enabledAgents?.[0]||'');
}
function isCodexControlSession(session: WebuiSessionSnapshot = state.snapshot?.session||{}){return currentControlAgentId(session)==='codex'}
function activeLaunchProfileId(session,controls=state.controls||{}){
  if(isCodexControlSession(session))return codexPermissionId(session);
  const profiles=(controls.launchProfiles||[]).concat(knownUnsafeLaunchProfilesForSession(session));
  const currentId=session.launchProfileId||'';
  const currentProfile=profiles.find(profile=>profile.id===currentId);
  if(currentProfile&&launchProfileBehaviorMatches(currentProfile,session))return currentId;
  const matchingProfile=profiles.find(profile=>launchProfileBehaviorMatches(profile,session));
  if(matchingProfile)return matchingProfile.id;
  if(currentProfile&&activeLaunchBehavior(session))return 'active:'+activeLaunchBehavior(session);
  return currentId||session.nextLaunchProfileId||'';
}
function activeLaunchBehavior(session){
  const activeBehavior=String(session?.launchProfileBehavior||'').trim();
  if(activeBehavior)return activeBehavior;
  const sandbox=String(session?.sandboxMode||'').trim();
  const approval=String(session?.approvalPolicy||'').trim();
  return sandbox&&approval?sandbox+' / '+approval:'';
}
function launchProfileBehaviorMatches(profile,session){
  const behavior=String(profile?.behavior||'').trim();
  if(!behavior)return false;
  const activeBehavior=activeLaunchBehavior(session);
  const profileReviewer=String(profile?.approvalsReviewer||'').trim();
  const sessionReviewer=String(session?.approvalsReviewer||session?.nextApprovalsReviewer||'').trim();
  if(activeBehavior&&behavior===activeBehavior&&(!profileReviewer&&!sessionReviewer||profileReviewer===sessionReviewer))return true;
  return false;
}
function launchMenuItems(controls,session,selectedLaunch){
  if(isCodexControlSession(session))return codexPermissionMenuItems(controls,session,selectedLaunch);
  const items=(controls.launchProfiles||[]).map(p=>({value:p.id,label:p.label+' - '+p.behavior+(p.unsafe?' - unsafe':'')}));
  for(const profile of knownUnsafeLaunchProfilesForSession(session)){
    if(!items.some(item=>item.value===profile.id))items.push({value:profile.id,label:profile.label+' - '+profile.behavior+' - unsafe'});
  }
  if(selectedLaunch&&!items.some(item=>item.value===selectedLaunch)){
    items.unshift({value:selectedLaunch,label:activeLaunchLabel(session,selectedLaunch)});
  }
  return items;
}
const CODEX_PERMISSION_MENU_DEFAULTS=[
  {value:'ask-for-approval',label:'Ask for approval'},
  {value:'approve-for-me',label:'Approve for me'},
  {value:'full-access',label:'Full Access'}
];
function codexPermissionMenuItems(controls: WebuiControls = {},session: WebuiSessionSnapshot = {},selectedLaunch: string = ''){
  const configured=new Map<string, WebuiLaunchProfile>((controls.launchProfiles||[]).map(profile=>[String(profile.id||''),profile]));
  const items=CODEX_PERMISSION_MENU_DEFAULTS.map(item=>{
    const profile=configured.get(item.value)||null;
    return{value:item.value,label:profile?.label||item.label};
  });
  if(selectedLaunch&&!items.some(item=>item.value===selectedLaunch)){
    items.unshift({value:selectedLaunch,label:codexPermissionLabel(selectedLaunch,session)});
  }
  return items;
}
function codexPermissionId(session: WebuiSessionSnapshot = {}){
  const explicit=String(session.launchProfileId||session.nextLaunchProfileId||'').trim();
  if(CODEX_PERMISSION_MENU_DEFAULTS.some(item=>item.value===explicit))return explicit;
  const behavior=activeLaunchBehavior(session)||String(session.nextLaunchProfileBehavior||'').trim();
  const sandbox=String(session.sandboxMode||'').trim();
  const approval=String(session.approvalPolicy||'').trim();
  const reviewer=String(session.approvalsReviewer||session.nextApprovalsReviewer||'').trim();
  if(explicit==='full-access'||behavior==='danger-full-access / never'||sandbox==='danger-full-access')return'full-access';
  if(explicit==='approve-for-me'||reviewer==='auto_review')return'approve-for-me';
  if(explicit==='ask-for-approval'||explicit==='review'||behavior==='workspace-write / on-request'||approval==='on-request')return'ask-for-approval';
  if(explicit==='default'||behavior==='workspace-write / never'||(sandbox==='workspace-write'&&approval==='never'))return'approve-for-me';
  return explicit||'ask-for-approval';
}
function codexPermissionLabel(profileId:string,session:WebuiSessionSnapshot={}): string {
  const found=CODEX_PERMISSION_MENU_DEFAULTS.find(item=>item.value===profileId);
  if(found)return found.label;
  const label=session.launchProfileLabel||session.nextLaunchProfileLabel||profileId||'Current permission';
  return String(label);
}
function activeLaunchLabel(session,selectedLaunch){
  const label=session.launchProfileLabel||session.nextLaunchProfileLabel||selectedLaunch||'Current launch';
  const behavior=session.launchProfileBehavior||session.nextLaunchProfileBehavior||'';
  const unsafe=session.unsafeLaunch||session.nextUnsafeLaunch;
  return label+(behavior?' - '+behavior:'')+(unsafe?' - unsafe':'');
}
function configuredLaunchProfile(controls,profileId){return Boolean(launchProfileForSelection(controls,state.snapshot?.session||{},profileId))}
function launchProfileForSelection(controls,session,profileId){
  const profile=(controls.launchProfiles||[]).find(p=>p.id===profileId)||knownUnsafeLaunchProfileForSession(session,profileId);
  if(profile)return profile;
  if(isCodexControlSession(session)){
    const item=CODEX_PERMISSION_MENU_DEFAULTS.find(entry=>entry.value===profileId);
    if(item)return{id:item.value,label:item.label,behavior:item.value==='full-access'?'danger-full-access / never':'workspace-write / on-request',unsafe:item.value==='full-access',approvalsReviewer:item.value==='approve-for-me'?'auto_review':item.value==='ask-for-approval'?'user':''};
  }
  return null;
}
function knownUnsafeLaunchProfileForSession(session,profileId){
  return knownUnsafeLaunchProfilesForSession(session).find(profile=>profile.id===profileId)||null;
}
function knownUnsafeLaunchProfilesForSession(session){
  const agentId=session?.agentId;
  if(agentId==='codex')return[{id:'full-access',label:'Full Access',behavior:'danger-full-access / never',unsafe:true}];
  if(agentId==='claude-code')return[{id:'bypass-permissions',label:'Bypass Permissions',behavior:'Bypass Claude Code permission prompts. Use only in trusted workspaces.',unsafe:true}];
  return[];
}
function confirmUnsafeLaunchProfile(profile,apply){
  if(!profile?.unsafe)return true;
  return confirm((apply?'Apply':'Set')+' unsafe launch profile "'+(profile.label||profile.id)+'"?\n\nBehavior: '+(profile.behavior||'-')+'\n\nUse this only in a trusted workspace.');
}
function stateDisabledAttr(title){return title?' data-state-disabled="true" data-state-disabled-title="'+attr(title)+'" disabled title="'+attr(title)+'"':''}
function compactControlMenu(id,label,value,display,items,permission='settings.write',stateDisabledTitle=''){
  const options=(items||[]).map(item=>'<button type="button" role="option" data-control-option="'+attr(id)+'" data-control-value="'+attr(item.value)+'" aria-selected="'+(item.value===value?'true':'false')+'">'+esc(item.label)+'</button>').join('');
  return '<div class="compact-control" data-control-menu="'+attr(id)+'">'+(label?'<span class="compact-control-label">'+esc(label)+'</span>':'')+'<button type="button" id="'+attr(id)+'" class="control-menu-button" data-control-value="'+attr(value)+'" aria-haspopup="listbox" aria-expanded="false"'+(stateDisabledAttr(stateDisabledTitle)||(permission?disabledAttr(permission):''))+'>'+esc(display||'Default')+'</button><div class="control-menu-list" role="listbox" hidden>'+options+'</div></div>';
}
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
    if(['controlModel','controlReasoning','controlFast','controlLaunch'].includes(id)&&currentChatWorkingSession()){toast('Wait until the current session finishes before changing this setting.');closeCompactControlMenus();return}
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
      const profile=launchProfileForSelection(state.controls||{},currentControlSession(),button.dataset.controlValue);
      if(!profile){
        button.dataset.controlValue=previousValue;
        button.textContent=previousText;
        option.closest('.control-menu-list')?.querySelectorAll('[data-control-option]').forEach(item=>item.setAttribute('aria-selected',item.dataset.controlValue===previousValue?'true':'false'));
        toast('Select a configured launch profile first');
        return;
      }
      if(!confirmUnsafeLaunchProfile(profile,true)){
        button.dataset.controlValue=previousValue;
        button.textContent=previousText;
        option.closest('.control-menu-list')?.querySelectorAll('[data-control-option]').forEach(item=>item.setAttribute('aria-selected',item.dataset.controlValue===previousValue?'true':'false'));
        return;
      }
      await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId:button.dataset.controlValue,apply:true,confirmUnsafe:Boolean(profile.unsafe)})});toast('Launch profile applied');loadBootstrap();
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
