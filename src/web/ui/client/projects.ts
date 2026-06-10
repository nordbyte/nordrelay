function switchProjectTab(tab){
  state.projectTab=tab||'projects';
  document.querySelectorAll('[data-project-tab]').forEach(b=>{
    const active=b.dataset.projectTab===state.projectTab;
    b.classList.toggle('active',active);
    b.setAttribute('aria-selected',active?'true':'false');
    b.tabIndex=active?0:-1;
  });
  document.querySelectorAll('[data-project-tab-panel]').forEach(p=>p.classList.toggle('active',p.dataset.projectTabPanel===state.projectTab));
}

function projectString(value){
  return String(value??'');
}

function projectArray(value){
  return Array.isArray(value)?value:[];
}

async function loadProjects(){
  switchProjectTab(state.projectTab||'projects');
  if(!can('projects.read')){
    document.getElementById('projectList').innerHTML=uiEmpty('Permission required: projects.read');
    return;
  }
  setLoading('projectList','Loading projects...');
  setLoading('projectSummaryPanel','Loading project summary...');
  setLoading('projectPlanPanel','Loading project plan...');
  setLoading('projectSessionsPanel','Loading linked sessions...');
  setLoading('projectJobsPanel','Loading project jobs...');
  const [data,peers]=await Promise.all([
    api('/api/projects',{local:true}),
    can('peers.read')?api('/api/peers',{local:true}).catch(()=>state.peers||null):Promise.resolve(state.peers||null)
  ]);
  state.projects=data.projects||[];
  state.projectJobs=data.jobs||[];
  if(peers)state.peers=peers;
  if(state.selectedProjectId&&!state.projects.some(p=>p.id===state.selectedProjectId)){
    state.selectedProjectId='';
  }
  if(!state.selectedProjectId&&state.projects.length){
    state.selectedProjectId=projectString(state.projects[0].id);
  }
  localStorage.setItem('nordrelaySelectedProjectId',state.selectedProjectId||'');
  renderProjectsPage();
}

function renderProjectsPage(){
  renderProjectList();
  renderProjectSummary();
  renderProjectPlan();
  renderProjectSessions();
  renderProjectJobs();
  bindTableActionMenus(document.getElementById('page-projects')||document);
  bindUiCopyButtons(document.getElementById('page-projects')||document);
  applyPermissions();
}

function selectedProject(){
  return (state.projects||[]).find(project=>project.id===state.selectedProjectId)||null;
}

function projectFilter(project){
  const q=(document.getElementById('projectSearch')?.value||'').toLowerCase();
  if(!q)return true;
  return [project.name,project.description,project.workspacePath,project.id,project.target].join(' ').toLowerCase().includes(q);
}

function projectCell(label,html,cls=''){
  return '<td data-label="'+attr(label)+'"'+(cls?' class="'+attr(cls)+'"':'')+'>'+html+'</td>';
}

function projectStatusBadge(status){
  return '<span class="adapter-status '+(status==='archived'?'disabled':'enabled')+'">'+esc(status||'active')+'</span>';
}

function projectTargetLabel(target){
  if(!target||target==='local')return'Local node';
  const id=String(target).replace(/^peer:/,'');
  const peer=(state.peers?.peers||[]).find(p=>p.id===id);
  return peer?(peer.name||peer.url||id)+' ('+(peer.platform||'peer')+')':id;
}

function projectActions(project){
  const primary='<button type="button" data-project-select="'+attr(project.id)+'"'+disabledAttr('projects.write')+'>'+(project.id===state.selectedProjectId?'Selected':'Select')+'</button>';
  return '<div class="data-table-actions">'+primary+tableActionMenuHtml([
    '<button type="button" class="secondary" data-project-edit="'+attr(project.id)+'"'+disabledAttr('projects.write')+'>Edit</button>',
    '<button type="button" class="secondary" data-project-summary-tab="'+attr(project.id)+'">Open summary</button>',
    '<button type="button" class="secondary" data-project-plan-tab="'+attr(project.id)+'">Open plan</button>',
    '<button type="button" class="danger" data-project-delete="'+attr(project.id)+'"'+disabledAttr('projects.write')+'>Delete</button>'
  ],{className:'project-action-menu',panelClassName:'project-action-menu-panel',id:project.id})+'</div>';
}

function renderProjectList(){
  const list=(state.projects||[]).filter(projectFilter);
  const target=document.getElementById('projectList');
  if(!target)return;
  if(!list.length){
    target.innerHTML=uiEmpty('No projects yet.');
    return;
  }
  target.innerHTML='<div class="data-table-wrap"><table class="data-table projects-table"><thead><tr><th>Updated</th><th>Name</th><th>Status</th><th>Workspace</th><th>Target</th><th>Sessions</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+list.map(project=>{
    const active=project.id===state.selectedProjectId?' selected-row':'';
    return '<tr class="'+active+'">'+
      projectCell('Updated','<span title="'+attr(fmtDate(project.updatedAt))+'">'+esc(fmtSessionAge(project.updatedAt))+'</span>','updated-cell')+
      projectCell('Name','<span class="truncate-cell" title="'+attr(project.description||project.name||'')+'">'+esc(short(project.name||'-',140))+'</span>','primary-cell')+
      projectCell('Status',projectStatusBadge(project.status),'status-cell')+
      projectCell('Workspace','<button type="button" class="copy-id" data-copy-value="'+attr(project.workspacePath||'')+'" data-copy-label="Workspace copied" title="'+attr(project.workspacePath||'')+'">'+esc(short(project.workspacePath||'-',140))+'</button>')+
      projectCell('Target','<span class="truncate-cell" title="'+attr(projectTargetLabel(project.target))+'">'+esc(short(projectTargetLabel(project.target),100))+'</span>')+
      projectCell('Sessions',esc(String(projectArray(project.linkedSessions).length)))+
      projectCell('Actions',projectActions(project),'actions-cell')+
    '</tr>';
  }).join('')+'</tbody></table></div>';
  bindProjectButtons(target);
}

function renderProjectSummary(){
  const project=selectedProject();
  const target=document.getElementById('projectSummaryPanel');
  if(!target)return;
  if(!project){target.innerHTML=uiEmpty('Select a project first.');return}
  target.innerHTML='<div class="project-editor-meta">'+projectMiniSummary(project)+'</div><textarea id="projectSummaryText" class="project-markdown-editor" rows="18" placeholder="Generate or edit the project summary...">'+esc(project.summaryMarkdown||'')+'</textarea>';
}

function renderProjectPlan(){
  const project=selectedProject();
  const target=document.getElementById('projectPlanPanel');
  if(!target)return;
  if(!project){target.innerHTML=uiEmpty('Select a project first.');return}
  target.innerHTML='<div class="project-editor-meta">'+projectMiniSummary(project)+'</div><textarea id="projectPlanText" class="project-markdown-editor" rows="18" placeholder="Generate or edit the prioritized development plan...">'+esc(project.planMarkdown||'')+'</textarea><h3 class="table-section-title">Parsed plan items</h3>'+renderProjectPlanItemsTable(projectArray(project.planItems));
}

function renderProjectPlanItemsTable(items){
  if(!items.length)return uiEmpty('No structured plan items parsed yet.');
  return '<div class="data-table-wrap"><table class="data-table project-plan-items-table"><thead><tr><th>Priority</th><th>Title</th><th>Focus</th><th>Target</th><th>Confidence</th><th>Status</th><th>Exists</th><th>Evidence</th></tr></thead><tbody>'+items.map(item=>
    '<tr>'+
      projectCell('Priority',esc(String(item.priority??'-')),'updated-cell')+
      projectCell('Title','<span class="truncate-cell" title="'+attr([item.description,item.userValue?'User value: '+item.userValue:'',projectArray(item.blockedBy).length?'Blocked by: '+projectArray(item.blockedBy).join(', '):''].filter(Boolean).join(' | ')||item.title||'')+'">'+esc(short(item.title||'-',160))+'</span>','primary-cell')+
      projectCell('Focus','<span class="truncate-cell" title="'+attr(item.category||projectPlanModeLabel(item.mode||'balanced'))+'">'+esc(short(projectPlanModeLabel(item.mode||'balanced'),80))+'</span><small>'+esc(short(item.category||'-',80))+'</small>')+
      projectCell('Target','<span class="truncate-cell" title="'+attr(item.targetArea||'')+'">'+esc(short(item.targetArea||'-',100))+'</span>')+
      projectCell('Confidence',item.confidence!==undefined?esc(String(item.confidence))+'%':'-')+
      projectCell('Status','<span class="adapter-status planned">'+esc(item.status||'proposed')+'</span>','status-cell')+
      projectCell('Exists','<span class="adapter-status '+(item.alreadyExistsCheck==='existing'?'disabled':item.alreadyExistsCheck==='partial'?'planned':'enabled')+'">'+esc(item.alreadyExistsCheck||'not_found')+'</span>')+
      projectCell('Evidence','<span class="truncate-cell" title="'+attr(projectArray(item.evidence).join(' | '))+'">'+esc(short(projectArray(item.evidence).join(' | ')||'-',220))+'</span>')+
    '</tr>'
  ).join('')+'</tbody></table></div>';
}

function projectDocumentLabel(kind){
  return kind==='plan'?'plan':'summary';
}

function projectRevisionPath(projectId,kind,revisionId='',action=''){
  let path='/api/projects/'+encodeURIComponent(projectString(projectId))+'/'+projectDocumentLabel(kind)+'/history';
  if(revisionId)path+='/'+encodeURIComponent(projectString(revisionId));
  if(action)path+='/'+encodeURIComponent(projectString(action));
  return path;
}

function projectRevisionSourceBadge(source){
  const cls=source==='generated'?'enabled':source==='restored'?'planned':'';
  return '<span class="adapter-status '+cls+'">'+esc(source||'manual')+'</span>';
}

function projectRevisionMeta(revision){
  return [
    revision.language?'Language: '+revision.language:'',
    revision.agentId?'Agent: '+revision.agentId:'',
    revision.planMode?'Focus: '+projectPlanModeLabel(revision.planMode):'',
    revision.planningHorizon?'Horizon: '+revision.planningHorizon:'',
    revision.riskLevel?'Risk: '+revision.riskLevel:'',
    revision.jobId?'Job: '+revision.jobId:'',
    projectArray(revision.planItems).length?'Items: '+projectArray(revision.planItems).length:''
  ].filter(Boolean).join(' | ');
}

function renderProjectRevisionHistory(kind,revisions){
  if(!revisions.length)return uiEmpty('No '+projectDocumentLabel(kind)+' history yet.');
  return '<div class="data-table-wrap"><table class="data-table project-revision-table"><thead><tr><th>Updated</th><th>Title</th><th>Source</th><th>Detail</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+revisions.map(revision=>
    '<tr>'+
      projectCell('Updated','<span title="'+attr(fmtDate(revision.updatedAt||revision.createdAt))+'">'+esc(fmtSessionAge(revision.updatedAt||revision.createdAt))+'</span>','updated-cell')+
      projectCell('Title','<span class="truncate-cell" title="'+attr(revision.title||'')+'">'+esc(short(revision.title||projectDocumentLabel(kind)+' revision',140))+'</span>','primary-cell')+
      projectCell('Source',projectRevisionSourceBadge(revision.source),'status-cell')+
      projectCell('Detail','<span class="truncate-cell" title="'+attr(projectRevisionMeta(revision))+'">'+esc(short(projectRevisionMeta(revision)||'-',220))+'</span>')+
      projectCell('Actions','<div class="data-table-actions"><button type="button" class="secondary mini-button" data-project-revision-open="'+attr(revision.id)+'" data-project-revision-kind="'+attr(kind)+'">Open</button><button type="button" class="secondary mini-button" data-project-revision-edit="'+attr(revision.id)+'" data-project-revision-kind="'+attr(kind)+'"'+disabledAttr('projects.write')+'>Edit</button><button type="button" class="secondary mini-button" data-project-revision-restore="'+attr(revision.id)+'" data-project-revision-kind="'+attr(kind)+'"'+disabledAttr('projects.write')+'>Restore</button><button type="button" class="danger mini-button" data-project-revision-delete="'+attr(revision.id)+'" data-project-revision-kind="'+attr(kind)+'"'+disabledAttr('projects.write')+'>Delete</button></div>','actions-cell')+
    '</tr>'
  ).join('')+'</tbody></table></div>';
}

async function openProjectHistoryDialog(kind){
  const project=selectedProject();
  if(!project){toast('Select a project first');return}
  const result=await api(projectRevisionPath(project.id,kind),{local:true});
  adminDialog(projectDocumentLabel(kind)[0].toUpperCase()+projectDocumentLabel(kind).slice(1)+' history','<div class="project-history-dialog">'+renderProjectRevisionHistory(kind,result.revisions||[])+'</div>',async()=>{},{
    submitText:'Close',
    reloadAccess:false
  });
  bindProjectRevisionButtons(document.getElementById('adminDialogBody')||document);
  applyPermissions();
}

async function openProjectRevisionDialog(kind,revisionId,editable=false){
  const project=selectedProject();
  if(!project)return;
  const result=await api(projectRevisionPath(project.id,kind,revisionId),{local:true});
  const revision=result.revision||{};
  const readonly=editable?'':' readonly';
  adminDialog((editable?'Edit ':'Open ')+projectDocumentLabel(kind)+' revision','<div class="form-grid">'+
    '<label class="full-span">Title<input id="dlgProjectRevisionTitle" value="'+attr(revision.title||'')+'" '+(editable?'':'readonly')+'></label>'+
    '<label class="full-span">Markdown<textarea id="dlgProjectRevisionMarkdown" class="project-markdown-editor project-revision-editor" rows="16"'+readonly+'>'+esc(revision.markdown||'')+'</textarea></label>'+
    '<p class="full-span">'+esc(projectRevisionMeta(revision)||'Revision metadata unavailable.')+'</p>'+
  '</div>',async()=>{
    if(!editable)return;
    await api(projectRevisionPath(project.id,kind,revision.id),{local:true,method:'PATCH',body:JSON.stringify({title:val('dlgProjectRevisionTitle')||undefined,markdown:val('dlgProjectRevisionMarkdown')})});
    toast('Revision updated');
  },{submitText:editable?'Save':'Close',afterSubmit:editable?()=>openProjectHistoryDialog(kind):undefined,reloadAccess:false});
}

function bindProjectRevisionButtons(root:Document|Element=document){
  root.querySelectorAll('[data-project-revision-open]').forEach(b=>b.onclick=()=>safe(async()=>{
    document.getElementById('adminDialog')?.close();
    await openProjectRevisionDialog(b.dataset.projectRevisionKind,b.dataset.projectRevisionOpen,false);
  }));
  root.querySelectorAll('[data-project-revision-edit]').forEach(b=>b.onclick=()=>safe(async()=>{
    document.getElementById('adminDialog')?.close();
    await openProjectRevisionDialog(b.dataset.projectRevisionKind,b.dataset.projectRevisionEdit,true);
  }));
  root.querySelectorAll('[data-project-revision-restore]').forEach(b=>b.onclick=()=>safe(async()=>{
    const project=selectedProject();if(!project)return;
    const kind=b.dataset.projectRevisionKind;
    if(!confirm('Restore this '+projectDocumentLabel(kind)+' revision as the current version?'))return;
    const result=await api(projectRevisionPath(project.id,kind,b.dataset.projectRevisionRestore,'restore'),{local:true,method:'POST'});
    state.projects=(state.projects||[]).map(item=>item.id===result.project.id?result.project:item);
    document.getElementById('adminDialog')?.close();
    toast(projectDocumentLabel(kind)+' restored');
    renderProjectsPage();
  }));
  root.querySelectorAll('[data-project-revision-delete]').forEach(b=>b.onclick=()=>safe(async()=>{
    const project=selectedProject();if(!project)return;
    const kind=b.dataset.projectRevisionKind;
    if(!confirm('Delete this '+projectDocumentLabel(kind)+' revision?'))return;
    await api(projectRevisionPath(project.id,kind,b.dataset.projectRevisionDelete),{local:true,method:'DELETE'});
    toast('Revision deleted');
    document.getElementById('adminDialog')?.close();
    await openProjectHistoryDialog(kind);
  }));
}

function renderProjectSessions(){
  const project=selectedProject();
  const target=document.getElementById('projectSessionsPanel');
  if(!target)return;
  if(!project){target.innerHTML=uiEmpty('Select a project first.');return}
  const links=projectArray(project.linkedSessions);
  if(!links.length){target.innerHTML=uiEmpty('No linked sessions yet.');return}
  target.innerHTML='<div class="data-table-wrap"><table class="data-table project-sessions-table"><thead><tr><th>Linked</th><th>Label</th><th>Agent</th><th>Thread</th><th>Peer</th><th>Workspace</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+links.map(link=>
    '<tr>'+
      projectCell('Linked','<span title="'+attr(fmtDate(link.linkedAt))+'">'+esc(fmtSessionAge(link.linkedAt))+'</span>','updated-cell')+
      projectCell('Label','<span class="truncate-cell" title="'+attr(link.label||'')+'">'+esc(short(link.label||'-',120))+'</span>','primary-cell')+
      projectCell('Agent',esc(link.agentId||'-'))+
      projectCell('Thread','<button type="button" class="copy-id" data-copy-value="'+attr(link.threadId||'')+'" data-copy-label="Thread ID copied">'+esc(shortMiddle(link.threadId||'-',8))+'</button>')+
      projectCell('Peer',esc(link.peerId?projectTargetLabel('peer:'+link.peerId):'Local node'))+
      projectCell('Workspace','<span class="truncate-cell" title="'+attr(link.workspace||'')+'">'+esc(short(link.workspace||'-',150))+'</span>')+
      projectCell('Actions','<div class="data-table-actions"><button type="button" class="danger" data-project-session-unlink="'+attr(link.id)+'"'+disabledAttr('projects.write')+'>Unlink</button></div>','actions-cell')+
    '</tr>'
  ).join('')+'</tbody></table></div>';
  bindProjectSessionButtons(target);
}

function renderProjectJobs(){
  const project=selectedProject();
  const target=document.getElementById('projectJobsPanel');
  if(!target)return;
  if(!project){target.innerHTML=uiEmpty('Select a project first.');return}
  const jobs=(state.projectJobs||[]).filter(job=>job.projectId===project.id);
  if(!jobs.length){target.innerHTML=uiEmpty('No project jobs yet.');return}
  target.innerHTML='<div class="data-table-wrap"><table class="data-table project-jobs-table"><thead><tr><th>Updated</th><th>Kind</th><th>Focus</th><th>Status</th><th>Agent</th><th>Thread</th><th>Log</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+jobs.map(job=>
    '<tr>'+
      projectCell('Updated','<span title="'+attr(fmtDate(job.updatedAt))+'">'+esc(fmtSessionAge(job.updatedAt))+'</span>','updated-cell')+
      projectCell('Kind','<span class="truncate-cell">'+esc(job.kind||'-')+'</span>','primary-cell')+
      projectCell('Focus',job.kind==='plan'?'<span class="truncate-cell" title="'+attr([projectPlanModeLabel(job.planMode||'balanced'),job.planningHorizon||'next-release',job.riskLevel||'balanced'].join(' · '))+'">'+esc(short(projectPlanModeLabel(job.planMode||'balanced'),100))+'</span>':'-')+
      projectCell('Status','<span class="adapter-status '+projectJobStatusClass(job.status)+'">'+esc(job.status||'-')+'</span>','status-cell')+
      projectCell('Agent',esc(job.agentId||'-'))+
      projectCell('Thread',job.threadId?'<button type="button" class="copy-id" data-copy-value="'+attr(job.threadId)+'" data-copy-label="Thread ID copied">'+esc(shortMiddle(job.threadId,8))+'</button>':'-')+
      projectCell('Log','<span class="truncate-cell" title="'+attr(projectArray(job.log).join(' | '))+'">'+esc(short(job.error||projectArray(job.log).slice(-1)[0]||'-',220))+'</span>')+
      projectCell('Actions',projectJobActions(job),'actions-cell')+
    '</tr>'
  ).join('')+'</tbody></table></div>';
  bindProjectJobButtons(target);
}

function projectJobActions(job){
  if(!['queued','running'].includes(job.status))return '<div class="data-table-actions"></div>';
  return '<div class="data-table-actions"><button type="button" class="danger" data-project-job-cancel="'+attr(job.id)+'"'+disabledAttr('projects.run')+'>Cancel</button></div>';
}

function projectJobStatusClass(status){
  if(status==='completed')return'enabled';
  if(status==='failed'||status==='aborted')return'disabled';
  return'planned';
}

function projectMiniSummary(project){
  return '<div class="project-mini-summary">'+
    '<strong>'+esc(project.name||'Project')+'</strong>'+
    '<small>'+esc(projectTargetLabel(project.target))+' · '+esc(project.workspacePath||'-')+'</small>'+
    '<small>Summary '+esc(project.summaryUpdatedAt?fmtSessionAge(project.summaryUpdatedAt):'not generated')+' · Plan '+esc(project.planUpdatedAt?fmtSessionAge(project.planUpdatedAt):'not generated')+'</small>'+
  '</div>';
}

function projectAgentOptions(selected){
  const agents=(state.enabledAgents&&state.enabledAgents.length?state.enabledAgents:['codex','pi','hermes','openclaw','claude-code']);
  return '<option value="">Default</option>'+agents.map(agent=>'<option value="'+attr(agent)+'" '+(agent===selected?'selected':'')+'>'+esc(agent)+'</option>').join('');
}

function projectTargetOptions(selected){
  const peers=(state.peers?.peers||[]).filter(peer=>peer.enabled!==false);
  const local='<option value="local" '+((!selected||selected==='local')?'selected':'')+'>Local node</option>';
  return local+peers.map(peer=>{
    const value='peer:'+peer.id;
    const label=(peer.name||peer.url||peer.id)+' ('+(peer.platform||'peer')+')';
    return '<option value="'+attr(value)+'" '+(value===selected?'selected':'')+'>'+esc(label)+'</option>';
  }).join('');
}

const PROJECT_PLAN_MODES=[
  ['balanced','Balanced roadmap'],
  ['features','New features'],
  ['bugfixes','Bug fixes'],
  ['refactor','Code quality / refactoring'],
  ['performance','Performance / scalability'],
  ['security','Security / permissions'],
  ['ux','UX / WebUI'],
  ['tests','Tests / CI / docs'],
  ['release','Release readiness']
];
const PROJECT_PLAN_HORIZONS=[
  ['next-sprint','Next sprint'],
  ['next-release','Next release'],
  ['long-term','Long-term roadmap']
];
const PROJECT_PLAN_RISK_LEVELS=[
  ['conservative','Conservative'],
  ['balanced','Balanced'],
  ['ambitious','Ambitious']
];

function projectSelectOptions(options,selected){
  return options.map(option=>'<option value="'+attr(option[0])+'" '+(option[0]===selected?'selected':'')+'>'+esc(option[1])+'</option>').join('');
}

function projectPlanModeLabel(mode){
  return (PROJECT_PLAN_MODES.find(option=>option[0]===mode)||PROJECT_PLAN_MODES[0])[1];
}

function openProjectDialog(project=null){
  const title=project?'Edit project':'Create project';
  adminDialog(title,'<div class="form-grid">'+
    '<label>Name<input id="dlgProjectName" value="'+attr(project?.name||'')+'" required maxlength="120"></label>'+
    '<label>Default agent<select id="dlgProjectAgent">'+projectAgentOptions(project?.defaultAgentId||'')+'</select></label>'+
    '<label>Target<select id="dlgProjectTarget">'+projectTargetOptions(project?.target||'local')+'</select></label>'+
    '<label>Status<select id="dlgProjectStatus"><option value="active" '+((project?.status||'active')==='active'?'selected':'')+'>Active</option><option value="archived" '+(project?.status==='archived'?'selected':'')+'>Archived</option></select></label>'+
    '<label class="full-span">Workspace path<input id="dlgProjectWorkspace" value="'+attr(project?.workspacePath||state.snapshot?.session?.workspace||'')+'" required placeholder="/path/to/repo"></label>'+
    '<label class="full-span">Description<textarea id="dlgProjectDescription" rows="4">'+esc(project?.description||'')+'</textarea></label>'+
  '</div>',async()=>{
    const body={name:val('dlgProjectName'),workspacePath:val('dlgProjectWorkspace'),description:val('dlgProjectDescription'),target:val('dlgProjectTarget')||'local',defaultAgentId:val('dlgProjectAgent')||undefined,status:val('dlgProjectStatus')||'active'};
    const result=project?await api('/api/projects/'+encodeURIComponent(projectString(project.id)),{local:true,method:'PATCH',body:JSON.stringify(body)}):await api('/api/projects',{local:true,method:'POST',body:JSON.stringify(body)});
    state.selectedProjectId=projectString(result.project?.id||state.selectedProjectId);
    localStorage.setItem('nordrelaySelectedProjectId',state.selectedProjectId||'');
    toast(project?'Project updated':'Project created');
  },{afterSubmit:loadProjects});
}

function openProjectRunDialog(kind){
  const project=selectedProject();
  if(!project){toast('Select a project first');return}
  const planFields=kind==='plan'
    ? '<label>Plan focus<select id="dlgProjectPlanMode">'+projectSelectOptions(PROJECT_PLAN_MODES,'balanced')+'</select></label>'+
      '<label>Planning horizon<select id="dlgProjectPlanningHorizon">'+projectSelectOptions(PROJECT_PLAN_HORIZONS,'next-release')+'</select></label>'+
      '<label>Risk level<select id="dlgProjectRiskLevel">'+projectSelectOptions(PROJECT_PLAN_RISK_LEVELS,'balanced')+'</select></label>'
    : '';
  adminDialog(kind==='plan'?'Generate project plan':'Generate project summary','<div class="form-grid">'+
    '<label>Agent<select id="dlgProjectRunAgent">'+projectAgentOptions(project.defaultAgentId||'')+'</select></label>'+
    '<label>Language<input id="dlgProjectRunLanguage" value="English" placeholder="English"></label>'+
    planFields+
    '<label class="full-span">Extra instructions<textarea id="dlgProjectRunInstructions" rows="5" placeholder="Optional focus, constraints, or priorities"></textarea></label>'+
    '<p class="full-span">NordRelay starts a background agent run in the project workspace. The result is saved back into this project and can be edited afterwards.</p>'+
  '</div>',async()=>{
    const base={agentId:val('dlgProjectRunAgent')||undefined,language:val('dlgProjectRunLanguage')||'English',instructions:val('dlgProjectRunInstructions')||undefined};
    const body=kind==='plan'
      ? {...base,planMode:val('dlgProjectPlanMode')||'balanced',planningHorizon:val('dlgProjectPlanningHorizon')||'next-release',riskLevel:val('dlgProjectRiskLevel')||'balanced'}
      : base;
    const result=await api('/api/projects/'+encodeURIComponent(projectString(project.id))+'/'+kind+'/run',{local:true,method:'POST',body:JSON.stringify(body)});
    toast('Project '+kind+' queued: '+(result.job?.id||project.name));
  },{submitText:'Run',afterSubmit:loadProjects});
}

function openProjectSessionDialog(){
  const project=selectedProject();
  if(!project){toast('Select a project first');return}
  adminDialog('Link session','<div class="form-grid">'+
    '<label>Agent<select id="dlgProjectSessionAgent">'+projectAgentOptions(project.defaultAgentId||state.snapshot?.session?.agentId||'')+'</select></label>'+
    '<label>Peer ID<input id="dlgProjectSessionPeer" value="'+attr(state.selectedPeer&&state.selectedPeer!=='local'?state.selectedPeer:'')+'" placeholder="empty for local"></label>'+
    '<label class="full-span">Thread ID<input id="dlgProjectSessionThread" value="'+attr(state.snapshot?.session?.threadId||'')+'" required></label>'+
    '<label class="full-span">Label<input id="dlgProjectSessionLabel" value="'+attr(state.snapshot?.session?.sessionName||'')+'"></label>'+
    '<label class="full-span">Workspace<input id="dlgProjectSessionWorkspace" value="'+attr(state.snapshot?.session?.workspace||project.workspacePath||'')+'"></label>'+
  '</div>',async()=>{
    const body={threadId:val('dlgProjectSessionThread'),agentId:val('dlgProjectSessionAgent')||undefined,peerId:val('dlgProjectSessionPeer')||undefined,label:val('dlgProjectSessionLabel')||undefined,workspace:val('dlgProjectSessionWorkspace')||undefined};
    await api('/api/projects/'+encodeURIComponent(projectString(project.id))+'/sessions',{local:true,method:'POST',body:JSON.stringify(body)});
    toast('Session linked');
  },{afterSubmit:loadProjects});
}

function linkCurrentProjectSession(){
  const project=selectedProject();
  const session=state.snapshot?.session;
  if(!project){toast('Select a project first');return}
  if(!session?.threadId){toast('No selected session to link');return}
  return safe(async()=>{
    await api('/api/projects/'+encodeURIComponent(projectString(project.id))+'/sessions',{local:true,method:'POST',body:JSON.stringify({
      threadId:session.threadId,
      agentId:session.agentId,
      peerId:state.selectedPeer&&state.selectedPeer!=='local'?state.selectedPeer:undefined,
      label:session.sessionName||session.threadId,
      workspace:session.workspace
    })});
    toast('Selected session linked');
    await loadProjects();
  });
}

function bindProjectButtons(root:Document|Element=document){
  root.querySelectorAll('[data-project-select]').forEach(b=>b.onclick=()=>{state.selectedProjectId=projectString(b.dataset.projectSelect);localStorage.setItem('nordrelaySelectedProjectId',state.selectedProjectId||'');renderProjectsPage()});
  root.querySelectorAll('[data-project-edit]').forEach(b=>b.onclick=()=>openProjectDialog((state.projects||[]).find(project=>project.id===b.dataset.projectEdit)||null));
  root.querySelectorAll('[data-project-summary-tab]').forEach(b=>b.onclick=()=>{state.selectedProjectId=projectString(b.dataset.projectSummaryTab);switchProjectTab('summary');renderProjectsPage()});
  root.querySelectorAll('[data-project-plan-tab]').forEach(b=>b.onclick=()=>{state.selectedProjectId=projectString(b.dataset.projectPlanTab);switchProjectTab('plan');renderProjectsPage()});
  root.querySelectorAll('[data-project-delete]').forEach(b=>b.onclick=()=>safe(async()=>{if(!confirm('Delete this project?'))return;await api('/api/projects/'+encodeURIComponent(projectString(b.dataset.projectDelete)),{local:true,method:'DELETE'});toast('Project deleted');await loadProjects()}));
}

function bindProjectSessionButtons(root:Document|Element=document){
  root.querySelectorAll('[data-project-session-unlink]').forEach(b=>b.onclick=()=>safe(async()=>{
    const project=selectedProject();if(!project)return;
    await api('/api/projects/'+encodeURIComponent(projectString(project.id))+'/sessions/'+encodeURIComponent(projectString(b.dataset.projectSessionUnlink)),{local:true,method:'DELETE'});
    toast('Session unlinked');
    await loadProjects();
  }));
}

function bindProjectJobButtons(root:Document|Element=document){
  root.querySelectorAll('[data-project-job-cancel]').forEach(b=>b.onclick=()=>safe(async()=>{
    await api('/api/projects/jobs/'+encodeURIComponent(projectString(b.dataset.projectJobCancel))+'/cancel',{local:true,method:'POST'});
    toast('Project job cancelled');
    await loadProjects();
  }));
}

function bindProjectPage(){
  document.querySelectorAll('[data-project-tab]').forEach(b=>b.onclick=()=>{switchProjectTab(b.dataset.projectTab);renderProjectsPage()});
  document.getElementById('reloadProjectsBtn').onclick=()=>safe(loadProjects);
  document.getElementById('reloadProjectJobsBtn').onclick=()=>safe(loadProjects);
  document.getElementById('createProjectBtn').onclick=()=>openProjectDialog(null);
  document.getElementById('projectSearch').oninput=()=>renderProjectList();
  document.getElementById('runProjectSummaryBtn').onclick=()=>openProjectRunDialog('summary');
  document.getElementById('runProjectPlanBtn').onclick=()=>openProjectRunDialog('plan');
  document.getElementById('projectSummaryHistoryBtn').onclick=()=>safe(()=>openProjectHistoryDialog('summary'));
  document.getElementById('projectPlanHistoryBtn').onclick=()=>safe(()=>openProjectHistoryDialog('plan'));
  document.getElementById('saveProjectSummaryBtn').onclick=()=>safe(async()=>{
    const project=selectedProject();if(!project)return;
    const text=document.getElementById('projectSummaryText')?.value||'';
    const result=await api('/api/projects/'+encodeURIComponent(projectString(project.id))+'/summary',{local:true,method:'PATCH',body:JSON.stringify({markdown:text})});
    state.projects=(state.projects||[]).map(item=>item.id===result.project.id?result.project:item);
    toast('Summary saved');
    renderProjectsPage();
  });
  document.getElementById('saveProjectPlanBtn').onclick=()=>safe(async()=>{
    const project=selectedProject();if(!project)return;
    const text=document.getElementById('projectPlanText')?.value||'';
    const result=await api('/api/projects/'+encodeURIComponent(projectString(project.id))+'/plan',{local:true,method:'PATCH',body:JSON.stringify({markdown:text})});
    state.projects=(state.projects||[]).map(item=>item.id===result.project.id?result.project:item);
    toast('Plan saved');
    renderProjectsPage();
  });
  document.getElementById('linkProjectCurrentSessionBtn').onclick=linkCurrentProjectSession;
  document.getElementById('linkProjectSessionBtn').onclick=openProjectSessionDialog;
}

bindProjectPage();
