function createPaginator(containerId, onChange, pageSize=50){
  const container=document.getElementById(containerId);
  return {
    page:1,
    pageSize,
    reset(){this.page=1},
    render(meta:any={}){
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
    render(meta:any={}){
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
const logPager=createCursorPager('logPager',()=>loadLogs(false));
const artifactPager=createCursorPager('artifactPager',()=>loadArtifacts(false));
const jobsPager=createCursorPager('jobsPager',()=>loadTasks(false));

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
function localHeaderTarget(local){
  return {id:'local',name:'Local node',agents:local.enabledAgents||[],snapshot:local.status?.snapshot||null,loading:false,error:''};
}
function headerTargetName(peerId){
  if(peerId==='local')return'Local node';
  const peer=(state.peers?.peers||[]).find(p=>p.id===peerId);
  return peer?.name||peerId;
}
function applyHeaderPeerSnapshot(peers,local=state.localBootstrap){
  const localTarget=localHeaderTarget(local||{enabledAgents:state.enabledAgents||[],status:{snapshot:state.snapshot}});
  state.peers=peers;
  const available=(peers?.peers||[]).filter(p=>p.enabled&&p.url);
  if(state.selectedPeer!=='local'&&!available.some(p=>p.id===state.selectedPeer))state.selectedPeer='local';
  state.peerTargets=[localTarget].concat(available.map(p=>({id:p.id,name:p.name,agents:p.allowedAgents||[],snapshot:null,loading:true,error:''})));
}
async function loadHeaderTargetCandidates(local){
  const localTarget=localHeaderTarget(local);
  if(!can('peers.read')){
    state.selectedPeer='local';
    state.peerTargets=[localTarget];
    return;
  }
  try{
    const peers=await api('/api/peers',{local:true});
    applyHeaderPeerSnapshot(peers,local);
  }catch{
    state.peerTargets=[localTarget];
    state.selectedPeer='local';
  }
}
function mergeHeaderTargetBootstrap(peerId,bootstrap){
  const targets=state.peerTargets||[];
  const index=targets.findIndex(t=>t.id===peerId);
  const entry={id:peerId,name:headerTargetName(peerId),agents:bootstrap.enabledAgents||[],snapshot:bootstrap.status?.snapshot||null,loading:false,error:''};
  if(index>=0)targets[index]={...targets[index],...entry};
  else targets.push(entry);
  state.peerTargets=targets;
}
async function refreshRemoteHeaderTargets(local,selectedData){
  if(!can('peers.read'))return;
  const targets=(state.peerTargets||[]).filter(t=>t.id!=='local');
  if(!targets.length)return;
  await Promise.all(targets.map(async target=>{
    try{
      const bootstrap=state.selectedPeer===target.id?selectedData:await apiPeer(target.id,'/api/bootstrap');
      mergeHeaderTargetBootstrap(target.id,bootstrap);
    }catch(error){
      const current=(state.peerTargets||[]).find(t=>t.id===target.id);
      if(current){current.loading=false;current.error=error instanceof Error?error.message:String(error)}
    }
  }));
  renderHeaderTargetMenu(state.snapshot);
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
function launchPermissionsText(session){
  if(!session?.capabilities?.launchProfiles)return'n/a';
  const selectedLaunch=session.launchProfileId||session.nextLaunchProfileId;
  const profile=(state.controls?.launchProfiles||[]).find(p=>p.id===selectedLaunch);
  return profile?.behavior||session.launchProfileBehavior||session.nextLaunchProfileBehavior||'-';
}
function renderHeaderTargetMenu(s=state.snapshot){
  const line=document.getElementById('sessionLine');
  if(!line||!s?.session)return;
  const session=s.session;
  const thread=session.threadId||'';
  const summary=[session.agentLabel||session.agentId||'Agent',session.model||'default',thread?shortMiddle(thread):'not started'].join(' / ');
  const targets=state.peerTargets&&state.peerTargets.length?state.peerTargets:[{id:state.selectedPeer||'local',name:headerTargetName(state.selectedPeer||'local'),agents:state.enabledAgents||[],snapshot:s,loading:false,error:''}];
  const groups=targets.map(target=>headerTargetGroupHtml(target,session)).join('');
  line.innerHTML='<div class="compact-control header-target-menu" data-header-target-menu><button type="button" id="headerTargetBtn" class="control-menu-button header-target-button" aria-haspopup="menu" aria-expanded="false" title="'+attr('Target: '+headerTargetName(state.selectedPeer||'local'))+'">'+esc(summary)+'</button><div class="control-menu-list header-target-list" role="menu" hidden>'+groups+'</div></div>'+(thread?headerThreadCopyButton(thread):'');
  bindHeaderTargetMenu(/** @type {any} */ (line));
  bindUiCopyButtons(line);
}
function headerThreadCopyButton(thread){
  return '<button type="button" class="copy-id header-thread-copy" data-copy-value="'+attr(thread)+'" data-copy-label="Thread ID copied" title="Copy thread ID" aria-label="Copy thread ID"><span class="copy-icon" aria-hidden="true"></span></button>';
}
function headerTargetGroupHtml(target,currentSession){
  const selectedPeer=(state.selectedPeer||'local')===target.id;
  const agents=target.agents||[];
  const selectedAgent=target.snapshot?.session?.agentId||currentSession.agentId;
  const status=target.error?'error':target.loading?'loading':'';
  const agentButtons=agents.length?agents.map(agent=>headerTargetAgentHtml(target,agent,selectedPeer&&selectedAgent===agent)).join(''):'<button type="button" class="header-target-agent" disabled>'+(target.loading?'Loading agents...':target.error?'Unavailable':'No agents enabled')+'</button>';
  return '<div class="header-target-peer" data-target-peer="'+attr(target.id)+'"><div class="header-target-peer-title"><strong>'+esc(target.name||target.id)+'</strong>'+(selectedPeer?'<span class="chip">selected peer</span>':'')+(status?'<small>'+esc(status)+'</small>':'')+'</div>'+agentButtons+'</div>';
}
function headerTargetAgentHtml(target,agent,selected){
  const snapshot=target.snapshot?.session;
  const model=snapshot&&snapshot.agentId===agent?(snapshot.model||'default'):'';
  const thread=snapshot&&snapshot.agentId===agent&&snapshot.threadId?shortMiddle(snapshot.threadId):'';
  const meta=[model,thread].filter(Boolean).join(' / ');
  const key=headerTargetSessionKey(target.id,agent);
  return '<div class="header-target-agent-block" data-target-agent-block="'+attr(key)+'"><div class="header-target-agent-row"><button type="button" role="menuitemradio" class="header-target-agent" data-target-peer="'+attr(target.id)+'" data-target-agent="'+attr(agent)+'" aria-selected="'+(selected?'true':'false')+'"'+disabledAttr('sessions.write')+'><span>'+esc(agent)+'</span>'+(meta?'<small>'+esc(meta)+'</small>':'')+'</button><button type="button" class="header-target-session-toggle" data-target-sessions-toggle="'+attr(key)+'" data-target-peer="'+attr(target.id)+'" data-target-agent="'+attr(agent)+'" aria-expanded="false" title="Show recent sessions" aria-label="Show recent '+attr(agent)+' sessions"'+disabledAttr('sessions.read')+'><span aria-hidden="true"></span></button></div><div class="header-target-sessions" data-target-sessions="'+attr(key)+'" hidden></div></div>';
}
function headerTargetSessionKey(peerId,agentId){return String(peerId||'local')+'::'+String(agentId||'')}
function bindHeaderTargetMenu(root:any=document){
  const menu=root.querySelector?.('[data-header-target-menu]');
  const button=menu?.querySelector('#headerTargetBtn');
  const list=menu?.querySelector('.header-target-list');
  if(button&&list)button.onclick=event=>{event.preventDefault();event.stopPropagation();const open=list.hidden;closeCompactControlMenus(menu);list.hidden=!open;button.setAttribute('aria-expanded',open?'true':'false')};
  root.querySelectorAll?.('[data-target-agent]').forEach(option=>option.onclick=event=>safe(async()=>{
    event.preventDefault();event.stopPropagation();
    if(!can('sessions.write')){toast('Permission required: sessions.write');return}
    await selectHeaderTarget(option.dataset.targetPeer||'local',option.dataset.targetAgent||'');
  },event));
  root.querySelectorAll?.('[data-target-sessions-toggle]').forEach(toggle=>toggle.onclick=event=>safe(async()=>{
    event.preventDefault();event.stopPropagation();
    if(!can('sessions.read')){toast('Permission required: sessions.read');return}
    await toggleHeaderTargetSessions(toggle);
  },event));
  root.querySelectorAll?.('[data-target-session-switch]').forEach(option=>option.onclick=event=>safe(async()=>{
    event.preventDefault();event.stopPropagation();
    if(!can('sessions.write')){toast('Permission required: sessions.write');return}
    await selectHeaderTargetSession(option.dataset.targetPeer||'local',option.dataset.targetAgent||'',option.dataset.targetSessionSwitch||'');
  },event));
  root.querySelectorAll?.('[data-target-session-load-more]').forEach(button=>button.onclick=event=>safe(async()=>{
    event.preventDefault();event.stopPropagation();
    if(!can('sessions.read')){toast('Permission required: sessions.read');return}
    const panel=button.closest('[data-target-sessions]');
    if(!panel)return;
    const nextPage=Number(button.dataset.targetSessionNextPage||'2');
    await loadHeaderTargetSessionsPage(panel,button.dataset.targetPeer||'local',button.dataset.targetAgent||'',nextPage);
  },event));
}
async function headerTargetRequest(peerId,path,options:any={}){
  return peerId==='local'?api(path,{...options,local:true}):apiPeer(peerId,path,options);
}
async function selectHeaderTarget(peerId,agentId){
  const previousPeer=state.selectedPeer||'local';
  const changedPeer=previousPeer!==peerId;
  state.selectedPeer=peerId||'local';
  localStorage.setItem('nordrelayPeerTarget',state.selectedPeer);
  if(changedPeer)connectEvents();
  const selected=agentId;
  const r=await headerTargetRequest(state.selectedPeer,'/api/agent',{method:'POST',body:JSON.stringify({agentId:selected})});
  if(state.snapshot&&r.session){state.snapshot.session=r.session;renderSnapshot(state.snapshot)}
  toast('Target switched to '+headerTargetName(state.selectedPeer)+' / '+selected);
  await loadBootstrap();await reloadCurrentPage({agentId:selected});
}
async function selectHeaderTargetSession(peerId,agentId,threadId){
  if(!threadId)return;
  const previousPeer=state.selectedPeer||'local';
  const changedPeer=previousPeer!==peerId;
  state.selectedPeer=peerId||'local';
  localStorage.setItem('nordrelayPeerTarget',state.selectedPeer);
  if(changedPeer)connectEvents();
  if(agentId)await headerTargetRequest(state.selectedPeer,'/api/agent',{method:'POST',body:JSON.stringify({agentId})});
  const r=await headerTargetRequest(state.selectedPeer,'/api/sessions/switch',{method:'POST',body:JSON.stringify({threadId})});
  if(state.snapshot&&r.session){state.snapshot.session=r.session;renderSnapshot(state.snapshot)}
  toast('Session switched');
  await loadBootstrap();await reloadCurrentPage({agentId});
}
async function toggleHeaderTargetSessions(toggle){
  const key=toggle.dataset.targetSessionsToggle;
  const panel=document.querySelector('[data-target-sessions="'+cssEscape(key)+'"]');
  if(!panel)return;
  const opening=panel.hidden;
  toggle.setAttribute('aria-expanded',opening?'true':'false');
  panel.hidden=!opening;
  if(!opening)return;
  if(panel.dataset.loaded==='true')return;
  const peerId=toggle.dataset.targetPeer||'local';
  const agentId=toggle.dataset.targetAgent||'';
  panel.dataset.targetPeer=peerId;
  panel.dataset.targetAgent=agentId;
  panel.innerHTML='<div class="header-target-session-state">Loading sessions...</div>';
  await loadHeaderTargetSessionsPage(panel,peerId,agentId,1);
}
async function loadHeaderTargetSessionsPage(panel,peerId,agentId,pageNumber){
  try{
    const data=await headerTargetRequest(peerId,'/api/sessions',{query:{agent:agentId,page:pageNumber,limit:5}});
    const sessions=data.sessions||[];
    const hasNext=Boolean(data.pagination?.hasNext);
    panel.querySelector('[data-target-session-load-more]')?.remove();
    panel.dataset.loaded='true';
    panel.dataset.page=String(pageNumber);
    panel.dataset.hasNext=hasNext?'true':'false';
    if(pageNumber<=1)panel.innerHTML=renderHeaderTargetSessions(peerId,agentId,sessions,hasNext,pageNumber+1);
    else panel.insertAdjacentHTML('beforeend',renderHeaderTargetSessionItems(peerId,agentId,sessions)+headerTargetLoadMoreHtml(peerId,agentId,hasNext,pageNumber+1));
    bindHeaderTargetMenu(panel);
  }catch(error){
    panel.innerHTML='<div class="header-target-session-state error">'+esc(error instanceof Error?error.message:String(error))+'</div>';
  }
}
function renderHeaderTargetSessions(peerId,agentId,sessions,hasNext=false,nextPage=2){
  if(!sessions.length)return'<div class="header-target-session-state">No recent sessions.</div>';
  return renderHeaderTargetSessionItems(peerId,agentId,sessions)+headerTargetLoadMoreHtml(peerId,agentId,hasNext,nextPage);
}
function renderHeaderTargetSessionItems(peerId,agentId,sessions){
  return sessions.slice(0,5).map(session=>{
    const title=session.title||session.firstUserMessage||session.id;
    const meta=[shortMiddle(session.id),session.model||'',session.cwd||'',session.updatedAt?fmtSessionAge(session.updatedAt)+' ago':''].filter(Boolean).join(' · ');
    return '<button type="button" class="header-target-session" data-target-session-switch="'+attr(session.id)+'" data-target-peer="'+attr(peerId)+'" data-target-agent="'+attr(agentId)+'" title="'+attr([title,session.id,session.cwd||'',fmtDate(session.updatedAt)].filter(Boolean).join(' | '))+'"'+disabledAttr('sessions.write')+'><span>'+esc(short(title,92))+'</span><small>'+esc(short(meta,140))+'</small></button>';
  }).join('');
}
function headerTargetLoadMoreHtml(peerId,agentId,hasNext,nextPage){
  return hasNext?'<button type="button" class="header-target-load-more" data-target-session-load-more="true" data-target-peer="'+attr(peerId)+'" data-target-agent="'+attr(agentId)+'" data-target-session-next-page="'+attr(nextPage)+'"'+disabledAttr('sessions.read')+'>Load more</button>':'';
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
