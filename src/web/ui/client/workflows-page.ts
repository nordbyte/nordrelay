function switchWorkflowTab(tab){
  state.workflowTab=tab||'templates';
  document.querySelectorAll('[data-workflow-tab]').forEach(b=>{
    const active=b.dataset.workflowTab===state.workflowTab;
    b.classList.toggle('active',active);
    b.setAttribute('aria-selected',active?'true':'false');
    b.tabIndex=active?0:-1;
  });
  document.querySelectorAll('[data-workflow-tab-panel]').forEach(p=>p.classList.toggle('active',p.dataset.workflowTabPanel===state.workflowTab));
}

async function loadWorkflows(){
  switchWorkflowTab(state.workflowTab||'templates');
  if(!can('workflows.read')){
    document.getElementById('templateList').innerHTML=uiEmpty('Permission required: workflows.read');
    return;
  }
  setLoading('templateList','Loading templates...');
  setLoading('workflowList','Loading workflows...');
  setLoading('workflowRunList','Loading runs...');
  const [templates,workflows,peers]=await Promise.all([
    api('/api/templates'),
    api('/api/workflows'),
    can('peers.read')?api('/api/peers',{local:true}).catch(()=>state.peers||null):Promise.resolve(state.peers||null)
  ]);
  state.workflowTemplates=templates.templates||[];
  state.workflows=workflows.workflows||[];
  state.workflowRuns=workflows.runs||[];
  if(peers)state.peers=peers;
  renderWorkflowSections();
}

function renderWorkflowSections(){renderTemplates();renderWorkflowList();renderWorkflowRuns();applyPermissions()}
function workflowFilter(value,id){const q=(document.getElementById(id)?.value||'').toLowerCase();if(!q)return true;return [value.name,value.description,(value.tags||[]).join(' '),value.id].join(' ').toLowerCase().includes(q)}
function workflowTags(tags){return (tags||[]).map(t=>'<span class="chip">'+esc(t)+'</span>').join('')}
function workflowCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+cls+'"':'')+'>'+html+'</td>'}
function templateUpdatedHtml(t){return t.updatedAt?'<span title="'+attr(fmtDate(t.updatedAt))+'">'+esc(fmtSessionAge(t.updatedAt))+'</span>':'-'}
function templateVariablesText(t){const count=(t.variables||[]).length;return count+' variable'+(count===1?'':'s')}
function renderTemplateRow(t){const summary=t.description||t.prompt||'';const tags=workflowTags(t.tags)||'-';const scope='<span class="adapter-status '+(t.scope==='shared'?'enabled':'planned')+'">'+esc(t.scope||'private')+'</span>';const actions='<div class="data-table-actions"><button data-template-run="'+attr(t.id)+'"'+disabledAttr('workflows.run')+'>Run</button><button class="secondary" data-template-insert="'+attr(t.id)+'">Insert</button><button class="secondary" data-template-preview="'+attr(t.id)+'">Preview</button><button class="secondary" data-template-history="'+attr(t.id)+'">History</button><button class="secondary" data-template-export="'+attr(t.id)+'">Export</button><button class="secondary" data-template-edit="'+attr(t.id)+'"'+disabledAttr('workflows.write')+'>Edit</button><button class="danger" data-template-delete="'+attr(t.id)+'"'+disabledAttr('workflows.write')+'>Delete</button></div>';return '<tr>'+workflowCell('Updated',templateUpdatedHtml(t),'updated-cell')+workflowCell('Name','<span class="truncate-cell" title="'+attr(t.name||'')+'">'+esc(short(t.name||'-',120))+'</span>','primary-cell')+workflowCell('Scope',scope,'scope-cell')+workflowCell('Tags',tags,'tags-cell')+workflowCell('Variables',esc(templateVariablesText(t)),'variables-cell')+workflowCell('Prompt','<span class="truncate-cell" title="'+attr(summary)+'">'+esc(short(summary||'-',180))+'</span>','prompt-cell')+workflowCell('Actions',actions,'actions-cell')+'</tr>'}
function renderTemplatesTable(templates){if(!templates.length)return uiEmpty('No templates.');return '<div class="data-table-wrap"><table class="data-table templates-table"><thead><tr><th>Updated</th><th>Name</th><th>Scope</th><th>Tags</th><th>Variables</th><th>Prompt</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+templates.map(renderTemplateRow).join('')+'</tbody></table></div>'}

function renderTemplates(){
  const list=(state.workflowTemplates||[]).filter(t=>workflowFilter(t,'templateSearch'));
  document.getElementById('templateList').innerHTML=renderTemplatesTable(list);
  bindTemplateButtons();
}

function renderWorkflowList(){
  const list=(state.workflows||[]).filter(w=>workflowFilter(w,'workflowSearch'));
  document.getElementById('workflowList').innerHTML=renderWorkflowsTable(list);
  bindWorkflowButtons();
}

function renderWorkflowRuns(){
  document.getElementById('workflowRunList').innerHTML=renderWorkflowRunsTable(state.workflowRuns||[]);
  bindUiTraceButtons(document.getElementById('workflowRunList'));
  document.querySelectorAll('[data-workflow-run-cancel]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('workflows.run')){toast('Permission required: workflows.run');return}await api('/api/workflow-runs/'+encodeURIComponent(b.dataset.workflowRunCancel)+'/cancel',{method:'POST'});toast('Workflow run cancelled');await loadWorkflows()}));
  document.querySelectorAll('[data-workflow-run-resume]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('workflows.run')){toast('Permission required: workflows.run');return}await api('/api/jobs/'+encodeURIComponent('workflow-run:'+b.dataset.workflowRunResume)+'/action',{method:'POST',body:JSON.stringify({action:'retry'})});toast('Workflow resumed');await loadWorkflows()}));
  document.querySelectorAll('[data-workflow-run-rerun-failed]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('workflows.run')){toast('Permission required: workflows.run');return}await api('/api/workflow-runs/'+encodeURIComponent(b.dataset.workflowRunRerunFailed)+'/rerun-failed',{method:'POST',body:JSON.stringify({})});toast('Workflow queued from failed step');await loadWorkflows()}));
  document.querySelectorAll('[data-workflow-run-report]').forEach(b=>b.onclick=()=>safe(()=>showWorkflowRunReport(b.dataset.workflowRunReport)));
  applyPermissions();
}

function runStatusClass(status){if(status==='completed')return'enabled';if(status==='failed'||status==='aborted')return'disabled';return'planned'}
function workflowScheduleSummary(w){const s=w.schedule||{};if(!s.enabled&&!s.nextRunAt&&!s.intervalMinutes&&!s.cron)return'-';return [(s.enabled?'enabled':'disabled'),s.cron?'cron '+s.cron:'',s.timezone?'tz '+s.timezone:'',s.nextRunAt?'next '+fmtDate(s.nextRunAt):'',s.intervalMinutes?'every '+s.intervalMinutes+'m':'',s.lastRunAt?'last '+fmtDate(s.lastRunAt):''].filter(Boolean).join(' | ')}
function workflowStepCounts(w){const steps=w.steps||[];const approvals=steps.filter(s=>s.requiresApproval).length;const peerTargets=steps.filter(s=>s.target&&s.target!=='local').length;const retries=steps.filter(s=>s.retryPolicy).length;return steps.length+' step(s)'+(approvals?' | '+approvals+' approval':'')+(peerTargets?' | '+peerTargets+' peer target':'')+(retries?' | '+retries+' retry policy':'')}
function renderWorkflowRow(w){const scope='<span class="adapter-status '+(w.scope==='shared'?'enabled':'planned')+'">'+esc(w.scope||'private')+'</span>';const actions='<div class="data-table-actions"><button data-workflow-run="'+attr(w.id)+'"'+disabledAttr('workflows.run')+'>Run</button><button class="secondary" data-workflow-preview="'+attr(w.id)+'">Preview</button><button class="secondary" data-workflow-history="'+attr(w.id)+'">History</button><button class="secondary" data-workflow-export="'+attr(w.id)+'">Export</button><button class="secondary" data-workflow-edit="'+attr(w.id)+'"'+disabledAttr('workflows.write')+'>Edit</button><button class="danger" data-workflow-delete="'+attr(w.id)+'"'+disabledAttr('workflows.write')+'>Delete</button></div>';return '<tr>'+workflowCell('Updated',templateUpdatedHtml(w),'updated-cell')+workflowCell('Name','<span class="truncate-cell" title="'+attr(w.name||'')+'">'+esc(short(w.name||'-',120))+'</span>','primary-cell')+workflowCell('Scope',scope,'scope-cell')+workflowCell('Schedule','<span class="truncate-cell" title="'+attr(workflowScheduleSummary(w))+'">'+esc(short(workflowScheduleSummary(w),150))+'</span>')+workflowCell('Steps','<span class="truncate-cell" title="'+attr(workflowStepCounts(w))+'">'+esc(workflowStepCounts(w))+'</span>')+workflowCell('Tags',workflowTags(w.tags)||'-','tags-cell')+workflowCell('Description','<span class="truncate-cell" title="'+attr(w.description||'')+'">'+esc(short(w.description||'-',180))+'</span>')+workflowCell('Actions',actions,'actions-cell')+'</tr>'}
function renderWorkflowsTable(workflows){if(!workflows.length)return uiEmpty('No workflows.');return '<div class="data-table-wrap"><table class="data-table workflows-table"><thead><tr><th>Updated</th><th>Name</th><th>Scope</th><th>Schedule</th><th>Steps</th><th>Tags</th><th>Description</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+workflows.map(renderWorkflowRow).join('')+'</tbody></table></div>'}
function workflowRunProgress(r){const steps=r.steps||[];const done=steps.filter(s=>s.status==='completed'||s.status==='skipped').length;return done+'/'+steps.length+' steps'}
function workflowRunCurrentStep(r){const step=(r.steps||[]).find(s=>['running','paused','queued'].includes(s.status))||(r.steps||[]).find(s=>s.status==='failed')||(r.steps||[]).slice(-1)[0];return step?step.name+' / '+step.status:'-'}
function workflowRunActions(r){return '<div class="data-table-actions"><button class="secondary" data-workflow-run-report="'+attr(r.id)+'">Report</button>'+(r.status==='paused'?'<button class="secondary" data-workflow-run-resume="'+attr(r.id)+'"'+disabledAttr('workflows.run')+'>Resume</button>':'')+(r.status==='failed'?'<button class="secondary" data-workflow-run-rerun-failed="'+attr(r.id)+'"'+disabledAttr('workflows.run')+'>Rerun failed step</button>':'')+(['queued','running','paused'].includes(r.status)?'<button class="danger" data-workflow-run-cancel="'+attr(r.id)+'"'+disabledAttr('workflows.run')+'>Cancel</button>':'')+'</div>'}
function workflowRunStepMeta(s){return [['Target',s.target],['Session',s.sessionMode],['Agent',s.agentId],['Workspace',s.workspace],['Workspace mode',s.workspaceMode],['Model',s.model],['Reasoning',s.reasoningEffort],['Launch',s.launchProfileId],['Approval',s.requiresApproval?'required':''],['Continue on error',s.continueOnError?'yes':''],['Retry',s.retryPolicy?((s.retryPolicy.maxAttempts||1)+' attempts / '+(s.retryPolicy.delayMs||0)+'ms'):''],['Trace',s.correlationId?uiTraceControls(s.correlationId):'']].filter(row=>row[1]).map(row=>'<small>'+esc(row[0])+': '+(row[0]==='Trace'?row[1]:esc(row[1]))+'</small>').join('')}
function workflowRunAttemptHtml(s){const attempts=s.attemptHistory||[];if(!attempts.length)return'';return '<div class="workflow-attempts">'+attempts.map(a=>'<small>'+esc('#'+a.attempt+' '+a.status+' / '+fmtDate(a.startedAt)+(a.finishedAt?' - '+fmtDate(a.finishedAt):'')+(a.error?' / '+a.error:''))+'</small>').join('')+'</div>'}
function workflowRunTimelineHtml(r){const steps=r.steps||[];if(!steps.length)return uiEmpty('No steps recorded.');return '<div class="data-table-wrap"><table class="data-table workflow-run-step-table"><thead><tr><th>Step</th><th>Status</th><th>Timing</th><th>Target</th><th>Prompt</th></tr></thead><tbody>'+steps.map(s=>'<tr>'+workflowCell('Step','<span class="truncate-cell" title="'+attr(s.name||'-')+'">'+esc(short(s.name||'-',120))+'</span>','primary-cell')+workflowCell('Status','<span class="adapter-status '+runStatusClass(s.status)+'">'+esc(s.status||'-')+'</span>','status-cell')+workflowCell('Timing','<span class="truncate-cell" title="'+attr([fmtDate(s.startedAt),fmtDate(s.finishedAt)].filter(v=>v&&v!=='-').join(' - '))+'">'+esc([s.startedAt?fmtDate(s.startedAt):'',s.finishedAt?fmtDate(s.finishedAt):''].filter(Boolean).join(' - ')||'-')+'</span>')+workflowCell('Target','<div class="activity-context">'+workflowRunStepMeta(s)+workflowRunAttemptHtml(s)+'</div>')+workflowCell('Prompt','<span class="truncate-cell" title="'+attr((s.error?('Error: '+s.error+' | '):'')+(s.prompt||''))+'">'+esc(short(s.error?('Error: '+s.error):s.prompt||'-',220))+'</span>')+'</tr>').join('')+'</tbody></table></div>'}
function renderWorkflowRunRow(r){const status='<span class="adapter-status '+runStatusClass(r.status)+'">'+esc(r.status||'-')+'</span>';const title=(r.error?'Error: '+r.error:'Created '+fmtDate(r.createdAt));const timeline='<details class="workflow-run-timeline"><summary>'+esc(workflowRunProgress(r))+'</summary>'+workflowRunTimelineHtml(r)+'</details>';return '<tr>'+workflowCell('Updated',templateUpdatedHtml(r),'updated-cell')+workflowCell('Name','<span class="truncate-cell" title="'+attr(title)+'">'+esc(short(r.name||'-',130))+'</span>','primary-cell')+workflowCell('Status',status,'status-cell')+workflowCell('Progress',timeline)+workflowCell('Current step','<span class="truncate-cell" title="'+attr(workflowRunCurrentStep(r))+'">'+esc(short(workflowRunCurrentStep(r),140))+'</span>')+workflowCell('Owner','<span class="truncate-cell" title="'+attr(r.ownerId||'-')+'">'+esc(short(r.ownerId||'-',100))+'</span>')+workflowCell('Actions',workflowRunActions(r),'actions-cell')+'</tr>'}
function renderWorkflowRunsTable(runs){if(!runs.length)return uiEmpty('No workflow runs.');return '<div class="data-table-wrap"><table class="data-table workflow-runs-table"><thead><tr><th>Updated</th><th>Name</th><th>Status</th><th>Progress</th><th>Current step</th><th>Owner</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+runs.map(renderWorkflowRunRow).join('')+'</tbody></table></div>'}
function workflowRunLogTable(logs){if(!logs?.length)return uiEmpty('No debug log entries.');return '<div class="data-table-wrap"><table class="data-table workflow-run-log-table"><thead><tr><th>Time</th><th>Level</th><th>Scope</th><th>Message</th><th>Detail</th></tr></thead><tbody>'+logs.map(log=>'<tr>'+workflowCell('Time','<span title="'+attr(fmtDate(log.at))+'">'+esc(fmtSessionAge(log.at))+'</span>','updated-cell')+workflowCell('Level','<span class="adapter-status '+(log.level==='error'?'disabled':log.level==='warn'?'planned':'enabled')+'">'+esc(log.level||'info')+'</span>','status-cell')+workflowCell('Scope',esc(log.scope+(log.stepId?' / '+log.stepId:'')))+workflowCell('Message','<span class="truncate-cell" title="'+attr(log.message||'')+'">'+esc(short(log.message||'-',180))+'</span>','primary-cell')+workflowCell('Detail','<span class="truncate-cell" title="'+attr(log.detail||'')+'">'+esc(short(log.detail||'-',240))+'</span>')+'</tr>').join('')+'</tbody></table></div>'}
function workflowRunReportHtml(report){const s=report.summary||{};const rows=[['Status',s.status],['Steps',(s.completedSteps||0)+' completed / '+(s.failedSteps||0)+' failed / '+(s.skippedSteps||0)+' skipped / '+(s.totalSteps||0)+' total'],['Duration',s.durationMs===null||s.durationMs===undefined?'-':fmtDuration(s.durationMs)],['Generated',fmtDate(report.generatedAt)]];return '<div class="full-span">'+card('Summary',rows)+'<h2 class="task-section-title">Timeline</h2>'+workflowRunTimelineHtml(report.run||{})+'<h2 class="task-section-title">Debug log</h2>'+workflowRunLogTable(report.logs||[])+'<div class="row"><button type="button" id="downloadWorkflowRunReportBtn" class="secondary">Download JSON</button></div></div>'}
async function showWorkflowRunReport(id){const report=await api('/api/workflow-runs/'+encodeURIComponent(id)+'/report');adminDialog('Workflow run report',workflowRunReportHtml(report),async()=>{}, {submitText:'Close',reloadAccess:false});const btn=document.getElementById('downloadWorkflowRunReportBtn');if(btn)btn.onclick=()=>downloadJson('nordrelay-workflow-run-'+id+'.json',report)}
function bindTemplateButtons(){}
function bindWorkflowButtons(){}
function collectVariablesFromPrompt(prompt){return Array.from(new Set(String(prompt||'').match(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g)?.map(v=>v.replace(/[{}]/g,'').trim())||[]))}

function workflowVariableDefinitions(items){
  const map=new Map();
  (items||[]).filter(Boolean).forEach(item=>{
    if(item.variables){
      (item.variables||[]).forEach(v=>{
        const name=String(v.name||'').trim();
        if(name&&!map.has(name))map.set(name,{name,label:v.label||name,required:v.required!==false,defaultValue:v.defaultValue||''});
      });
    }else{
      collectVariablesFromPrompt(item.prompt).forEach(name=>{if(!map.has(name))map.set(name,{name,label:name,required:true,defaultValue:''})});
    }
  });
  return [...map.values()];
}

function workflowVariableItemsForWorkflow(w){
  return (w?.steps||[]).map(step=>step.templateId?state.workflowTemplates.find(t=>t.id===step.templateId)||step:step);
}

function workflowVariableInputs(defs){
  return defs.map(v=>'<label>'+esc(v.label||v.name)+'<input data-workflow-variable="'+attr(v.name)+'" value="'+attr(v.defaultValue||'')+'" '+(v.required?'required':'')+'></label>').join('');
}

function openWorkflowVariableDialog(title,items,submitText,onSubmit){
  const defs=workflowVariableDefinitions(items);
  if(!defs.length){return safe(()=>onSubmit({}))}
  adminDialog(title,'<div class="workflow-variable-dialog"><p>Set variables for this run. Values are applied to every matching {{variable}} placeholder.</p><div class="form-grid">'+workflowVariableInputs(defs)+'</div></div>',async()=>{
    const variables={};
    document.querySelectorAll('[data-workflow-variable]').forEach(input=>variables[input.dataset.workflowVariable]=input.value);
    await onSubmit(variables);
  },{submitText,reloadAccess:false});
}

async function runTemplate(id){
  if(!can('workflows.run')){toast('Permission required: workflows.run');return}
  const t=state.workflowTemplates.find(x=>x.id===id);
  openWorkflowVariableDialog('Run template', [t], 'Run', async variables=>{
    const r=await api('/api/templates/'+encodeURIComponent(id)+'/run',{method:'POST',body:JSON.stringify({variables})});
    toast('Template run started: '+(r.run?.name||id));
    await loadWorkflows();
  });
}

async function runWorkflow(id){
  if(!can('workflows.run')){toast('Permission required: workflows.run');return}
  const w=state.workflows.find(x=>x.id===id);
  openWorkflowVariableDialog('Run workflow', workflowVariableItemsForWorkflow(w), 'Run', async variables=>{
    const r=await api('/api/workflows/'+encodeURIComponent(id)+'/run',{method:'POST',body:JSON.stringify({variables})});
    toast('Workflow queued: '+(r.run?.name||id));
    await loadWorkflows();
  });
}

async function previewTemplate(id){
  const t=state.workflowTemplates.find(x=>x.id===id);
  openWorkflowVariableDialog('Preview template', [t], 'Preview', async variables=>{
    const p=await api('/api/templates/'+encodeURIComponent(id)+'/preview',{method:'POST',body:JSON.stringify({variables})});
    showPreview(p);
  });
}

async function previewWorkflow(id){
  const w=state.workflows.find(x=>x.id===id);
  openWorkflowVariableDialog('Preview workflow', workflowVariableItemsForWorkflow(w), 'Preview', async variables=>{
    const p=await api('/api/workflows/'+encodeURIComponent(id)+'/preview',{method:'POST',body:JSON.stringify({variables})});
    showPreview(p);
  });
}

async function runTemplateVersion(id,version){
  if(!can('workflows.run')){toast('Permission required: workflows.run');return}
  const t=state.workflowTemplates.find(x=>x.id===id);
  openWorkflowVariableDialog('Run template v'+version,[t],'Run',async variables=>{
    const r=await api('/api/templates/'+encodeURIComponent(id)+'/versions/'+encodeURIComponent(version)+'/run',{method:'POST',body:JSON.stringify({variables})});
    toast('Template run started: '+(r.run?.name||id));
    await loadWorkflows();
  });
}

async function runWorkflowVersion(id,version){
  if(!can('workflows.run')){toast('Permission required: workflows.run');return}
  const w=state.workflows.find(x=>x.id===id);
  openWorkflowVariableDialog('Run workflow v'+version,workflowVariableItemsForWorkflow(w),'Run',async variables=>{
    const r=await api('/api/workflows/'+encodeURIComponent(id)+'/versions/'+encodeURIComponent(version)+'/run',{method:'POST',body:JSON.stringify({variables})});
    toast('Workflow queued: '+(r.run?.name||id));
    await loadWorkflows();
  });
}

async function previewTemplateVersion(id,version){
  const t=state.workflowTemplates.find(x=>x.id===id);
  openWorkflowVariableDialog('Preview template v'+version,[t],'Preview',async variables=>{
    const p=await api('/api/templates/'+encodeURIComponent(id)+'/versions/'+encodeURIComponent(version)+'/preview',{method:'POST',body:JSON.stringify({variables})});
    showPreview(p);
  });
}

async function previewWorkflowVersion(id,version){
  const w=state.workflows.find(x=>x.id===id);
  openWorkflowVariableDialog('Preview workflow v'+version,workflowVariableItemsForWorkflow(w),'Preview',async variables=>{
    const p=await api('/api/workflows/'+encodeURIComponent(id)+'/versions/'+encodeURIComponent(version)+'/preview',{method:'POST',body:JSON.stringify({variables})});
    showPreview(p);
  });
}

function workflowVersionCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+cls+'"':'')+'>'+html+'</td>'}
function workflowVersionSummary(v){const s=v.snapshot||{};if(v.kind==='template')return short(s.prompt||'',180);return ((s.steps||[]).length||0)+' step(s)'+(s.description?' | '+s.description:'')}
function workflowDiffHtml(diff){const changes=diff.changes||[];if(!changes.length)return uiEmpty('No differences.');return '<div class="data-table-wrap"><table class="data-table workflow-version-diff-table"><thead><tr><th>Path</th><th>Type</th><th>Before</th><th>After</th></tr></thead><tbody>'+changes.map(c=>'<tr>'+workflowVersionCell('Path','<span class="truncate-cell" title="'+attr(c.path||'')+'">'+esc(short(c.path||'-',140))+'</span>')+workflowVersionCell('Type','<span class="chip">'+esc(c.type||'-')+'</span>')+workflowVersionCell('Before','<span class="truncate-cell" title="'+attr(JSON.stringify(c.before??''))+'">'+esc(short(JSON.stringify(c.before??''),180))+'</span>')+workflowVersionCell('After','<span class="truncate-cell" title="'+attr(JSON.stringify(c.after??''))+'">'+esc(short(JSON.stringify(c.after??''),180))+'</span>')+'</tr>').join('')+'</tbody></table></div>'}
function workflowVersionsTable(kind,id,versions,diff){if(!versions.length)return uiEmpty('No versions recorded yet.');return '<div class="data-table-wrap"><table class="data-table workflow-version-table"><thead><tr><th>Version</th><th>Created</th><th>Name</th><th>Summary</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+versions.map(v=>{const actions='<div class="data-table-actions"><button class="secondary" data-version-preview="'+attr(kind+':'+id+':'+v.version)+'">Preview</button><button class="secondary" data-version-run="'+attr(kind+':'+id+':'+v.version)+'"'+disabledAttr('workflows.run')+'>Run</button><button class="secondary" data-version-export="'+attr(kind+':'+id+':'+v.version)+'">Export</button><button class="danger" data-version-rollback="'+attr(kind+':'+id+':'+v.version)+'"'+disabledAttr('workflows.write')+'>Rollback</button></div>';return '<tr>'+workflowVersionCell('Version','v'+esc(v.version),'updated-cell')+workflowVersionCell('Created','<span title="'+attr(fmtDate(v.createdAt))+'">'+esc(fmtSessionAge(v.createdAt))+'</span>')+workflowVersionCell('Name','<span class="truncate-cell" title="'+attr(v.name||'')+'">'+esc(short(v.name||'-',120))+'</span>','primary-cell')+workflowVersionCell('Summary','<span class="truncate-cell" title="'+attr(workflowVersionSummary(v))+'">'+esc(short(workflowVersionSummary(v),180))+'</span>')+workflowVersionCell('Actions',actions,'actions-cell')+'</tr>'}).join('')+'</tbody></table></div><h2 class="task-section-title">Latest diff</h2>'+workflowDiffHtml(diff||{})}
function workflowVersionAction(value){const [kind,id,versionText]=String(value||'').split(':');return{kind,id,version:Number(versionText)}}
async function showWorkflowHistory(kind,id){
  const [versions,diff]=await Promise.all([
    api('/api/'+(kind==='template'?'templates':'workflows')+'/'+encodeURIComponent(id)+'/versions'),
    api('/api/'+(kind==='template'?'templates':'workflows')+'/'+encodeURIComponent(id)+'/diff').catch(()=>({changes:[]}))
  ]);
  adminDialog((kind==='template'?'Template':'Workflow')+' history',workflowVersionsTable(kind,id,versions.versions||[],diff),async()=>{},{
    submitText:'Close',
    reloadAccess:false,
    afterSubmit:async()=>{}
  });
  bindWorkflowVersionButtons();
}
function bindWorkflowVersionButtons(){const root=document.getElementById('adminDialogBody');root.querySelectorAll('[data-version-preview]').forEach(b=>b.onclick=()=>safe(()=>{const a=workflowVersionAction(b.dataset.versionPreview);document.getElementById('adminDialog').close();return a.kind==='template'?previewTemplateVersion(a.id,a.version):previewWorkflowVersion(a.id,a.version)}));root.querySelectorAll('[data-version-run]').forEach(b=>b.onclick=()=>safe(()=>{const a=workflowVersionAction(b.dataset.versionRun);document.getElementById('adminDialog').close();return a.kind==='template'?runTemplateVersion(a.id,a.version):runWorkflowVersion(a.id,a.version)}));root.querySelectorAll('[data-version-export]').forEach(b=>b.onclick=()=>safe(()=>{const a=workflowVersionAction(b.dataset.versionExport);return exportWorkflowItem(a.kind,a.id,a.version)}));root.querySelectorAll('[data-version-rollback]').forEach(b=>b.onclick=()=>safe(async()=>{const a=workflowVersionAction(b.dataset.versionRollback);if(!confirm('Rollback to version '+a.version+'?'))return;await api('/api/'+(a.kind==='template'?'templates':'workflows')+'/'+encodeURIComponent(a.id)+'/versions/'+encodeURIComponent(a.version)+'/rollback',{method:'POST',body:JSON.stringify({})});document.getElementById('adminDialog').close();toast('Rolled back to version '+a.version);await loadWorkflows()}))}
async function exportWorkflowItem(kind,id,version=null){
  const url='/api/'+(kind==='template'?'templates':'workflows')+'/'+encodeURIComponent(id)+(version?'/versions/'+encodeURIComponent(version)+'/export':'/export');
  const bundle=await api(url);
  const name=(bundle.template?.name||bundle.workflow?.name||kind).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,'')||kind;
  downloadJson('nordrelay-'+kind+'-'+name+(version?'-v'+version:'')+'.json',bundle);
  toast('Exported '+kind);
}
function importWorkflowDialog(kind){
  if(!can('workflows.write')){toast('Permission required: workflows.write');return}
  adminDialog('Import '+kind,'<label class="full-span">JSON bundle<textarea id="workflowImportJson" rows="12" placeholder="Paste exported NordRelay '+kind+' JSON"></textarea></label>',async()=>{
    const raw=val('workflowImportJson');
    if(!raw.trim())throw new Error('Paste a JSON bundle first.');
    const bundle=JSON.parse(raw);
    await api('/api/'+(kind==='template'?'templates':'workflows')+'/import',{method:'POST',body:JSON.stringify({bundle})});
    toast('Imported '+kind);
  },{afterSubmit:loadWorkflows});
}

function showPreview(p){toast((p.prompts||[]).map((step,i)=>(i+1)+'. '+step.name+'\n'+step.prompt).join('\n\n---\n\n').slice(0,3500),{duration:12000})}
function insertTemplate(id){const t=state.workflowTemplates.find(x=>x.id===id);if(!t)return;document.getElementById('promptInput').value=t.prompt;page('chat');document.getElementById('promptInput').focus()}

function openTemplateDialog(t=null){
  if(!can('workflows.write')){toast('Permission required: workflows.write');return}
  adminDialog(t?'Edit template':'Create template','<label>Name<input id="dlgTemplateName" value="'+attr(t?.name||'')+'"></label><label>Scope<select id="dlgTemplateScope"><option value="private">Private</option><option value="shared">Shared</option></select></label><label class="full-span">Description<input id="dlgTemplateDescription" value="'+attr(t?.description||'')+'"></label><label class="full-span">Tags<input id="dlgTemplateTags" value="'+attr((t?.tags||[]).join(', '))+'"></label><label class="full-span">Prompt<textarea id="dlgTemplatePrompt" rows="10">'+esc(t?.prompt||'')+'</textarea></label>',async()=>{
    const promptText=val('dlgTemplatePrompt');
    const body={name:val('dlgTemplateName'),description:val('dlgTemplateDescription'),tags:csvToList(val('dlgTemplateTags')),prompt:promptText,variables:collectVariablesFromPrompt(promptText).map(name=>({name,required:true})),scope:val('dlgTemplateScope')};
    if(t)await api('/api/templates/'+encodeURIComponent(t.id),{method:'PUT',body:JSON.stringify(body)});
    else await api('/api/templates',{method:'POST',body:JSON.stringify(body)});
  },{afterSubmit:loadWorkflows});
  document.getElementById('dlgTemplateScope').value=t?.scope||'private';
}

function workflowDialogBody(w){
  return '<label>Name<input id="dlgWorkflowName" value="'+attr(w?.name||'')+'"></label>'+
    '<label>Scope<select id="dlgWorkflowScope"><option value="private">Private</option><option value="shared">Shared</option></select></label>'+
    '<label class="full-span">Description<input id="dlgWorkflowDescription" value="'+attr(w?.description||'')+'"></label>'+
    '<label class="full-span">Tags<input id="dlgWorkflowTags" value="'+attr((w?.tags||[]).join(', '))+'"></label>'+
    '<label class="checkbox"><input id="dlgWorkflowScheduleEnabled" type="checkbox" '+(w?.schedule?.enabled?'checked':'')+'> Schedule enabled</label>'+
    '<label>Run at<input id="dlgWorkflowScheduleRunAt" type="datetime-local" value="'+attr(datetimeLocalValue(w?.schedule?.nextRunAt||w?.schedule?.runAt||''))+'"></label>'+
    '<label>Repeat minutes<input id="dlgWorkflowScheduleInterval" type="number" min="0" value="'+attr(w?.schedule?.intervalMinutes||0)+'"></label>'+
    '<label>Cron<input id="dlgWorkflowScheduleCron" value="'+attr(w?.schedule?.cron||'')+'" placeholder="*/30 * * * *"></label>'+
    '<label>Timezone<input id="dlgWorkflowScheduleTimezone" value="'+attr(w?.schedule?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'')+'" placeholder="Europe/Berlin"></label>'+
    '<div class="workflow-builder full-span">'+
    '<div class="workflow-builder-toolbar"><strong>Workflow builder</strong><div class="row"><button type="button" data-workflow-builder-add>Add step</button><button type="button" id="workflowBuilderPreviewBtn" class="secondary">Preview workflow</button></div></div>'+
    '<div id="workflowBuilderSteps" class="workflow-builder-steps"></div>'+
    '<div id="workflowBuilderValidation" class="workflow-builder-validation"></div>'+
    '<details class="workflow-builder-json"><summary>Advanced JSON import/export</summary><textarea id="dlgWorkflowStepsJson" rows="8"></textarea><div class="row"><button type="button" id="workflowBuilderImportJsonBtn" class="secondary">Import JSON</button><button type="button" id="workflowBuilderSyncJsonBtn" class="secondary">Update JSON from builder</button><button type="button" id="workflowBuilderCopyJsonBtn" class="secondary">Copy JSON</button></div></details>'+
    '<div class="workflow-builder-preview"><strong>Live preview</strong><div id="workflowBuilderPreview"></div></div>'+
    '<div id="workflowBuilderDataLists"></div>'+
    '</div>';
}

function openWorkflowDialog(w=null){
  if(!can('workflows.write')){toast('Permission required: workflows.write');return}
  state.workflowBuilder=workflowBuilderState(w);
  adminDialog(w?'Edit workflow':'Create workflow',workflowDialogBody(w),async()=>{
    const errors=validateWorkflowBuilder();
    if(errors.length)throw new Error(errors[0]);
    const body={name:val('dlgWorkflowName'),description:val('dlgWorkflowDescription'),tags:csvToList(val('dlgWorkflowTags')),steps:workflowBuilderStepsPayload(),schedule:workflowSchedulePayload(),scope:val('dlgWorkflowScope')};
    if(w)await api('/api/workflows/'+encodeURIComponent(w.id),{method:'PUT',body:JSON.stringify(body)});
    else await api('/api/workflows',{method:'POST',body:JSON.stringify(body)});
  },{afterSubmit:loadWorkflows});
  document.getElementById('dlgWorkflowScope').value=w?.scope||'private';
  renderWorkflowBuilder();
}

function datetimeLocalValue(value){if(!value)return'';const d=new Date(value);if(!Number.isFinite(d.getTime()))return'';return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function workflowSchedulePayload(){const enabled=Boolean(document.getElementById('dlgWorkflowScheduleEnabled')?.checked);const runAtLocal=val('dlgWorkflowScheduleRunAt');const intervalMinutes=Number(val('dlgWorkflowScheduleInterval')||0);const cron=val('dlgWorkflowScheduleCron');const timezone=val('dlgWorkflowScheduleTimezone');const runAt=runAtLocal?new Date(runAtLocal).toISOString():undefined;return enabled||runAt||intervalMinutes||cron?{enabled,runAt,nextRunAt:runAt,intervalMinutes,cron:cron||undefined,timezone:timezone||undefined}:undefined}

function bindWorkflowPageControls(){
  const templateSearch=document.getElementById('templateSearch');if(templateSearch&&!templateSearch.dataset.bound){templateSearch.dataset.bound='true';templateSearch.oninput=renderTemplates}
  const workflowSearch=document.getElementById('workflowSearch');if(workflowSearch&&!workflowSearch.dataset.bound){workflowSearch.dataset.bound='true';workflowSearch.oninput=renderWorkflowList}
  const picker=document.getElementById('templatePickerBtn');if(picker&&!picker.dataset.bound){picker.dataset.bound='true';picker.onclick=()=>{if(!can('workflows.read')){toast('Permission required: workflows.read');return}page('workflows')}}
}

document.addEventListener('click',e=>{
  const tab=e.target.closest?.('[data-workflow-tab]');if(tab){e.preventDefault();switchWorkflowTab(tab.dataset.workflowTab);return}
  const createTemplate=e.target.closest?.('#createTemplateBtn');if(createTemplate){e.preventDefault();openTemplateDialog();return}
  const importTemplate=e.target.closest?.('#importTemplateBtn');if(importTemplate){e.preventDefault();importWorkflowDialog('template');return}
  const createWorkflow=e.target.closest?.('#createWorkflowBtn');if(createWorkflow){e.preventDefault();openWorkflowDialog();return}
  const importWorkflow=e.target.closest?.('#importWorkflowBtn');if(importWorkflow){e.preventDefault();importWorkflowDialog('workflow');return}
  const reload=e.target.closest?.('#reloadWorkflowsBtn,#reloadWorkflowRunsBtn');if(reload){e.preventDefault();safe(loadWorkflows);return}
  const templateRun=e.target.closest?.('[data-template-run]');if(templateRun){e.preventDefault();safe(()=>runTemplate(templateRun.dataset.templateRun));return}
  const templateInsert=e.target.closest?.('[data-template-insert]');if(templateInsert){e.preventDefault();insertTemplate(templateInsert.dataset.templateInsert);return}
  const templatePreview=e.target.closest?.('[data-template-preview]');if(templatePreview){e.preventDefault();safe(()=>previewTemplate(templatePreview.dataset.templatePreview));return}
  const templateHistory=e.target.closest?.('[data-template-history]');if(templateHistory){e.preventDefault();safe(()=>showWorkflowHistory('template',templateHistory.dataset.templateHistory));return}
  const templateExport=e.target.closest?.('[data-template-export]');if(templateExport){e.preventDefault();safe(()=>exportWorkflowItem('template',templateExport.dataset.templateExport));return}
  const templateEdit=e.target.closest?.('[data-template-edit]');if(templateEdit){e.preventDefault();openTemplateDialog(state.workflowTemplates.find(t=>t.id===templateEdit.dataset.templateEdit));return}
  const templateDelete=e.target.closest?.('[data-template-delete]');if(templateDelete){e.preventDefault();safe(async()=>{if(confirm('Delete template?')){await api('/api/templates/'+encodeURIComponent(templateDelete.dataset.templateDelete),{method:'DELETE'});await loadWorkflows()}});return}
  const workflowRun=e.target.closest?.('[data-workflow-run]');if(workflowRun){e.preventDefault();safe(()=>runWorkflow(workflowRun.dataset.workflowRun));return}
  const workflowPreview=e.target.closest?.('[data-workflow-preview]');if(workflowPreview){e.preventDefault();safe(()=>previewWorkflow(workflowPreview.dataset.workflowPreview));return}
  const workflowHistory=e.target.closest?.('[data-workflow-history]');if(workflowHistory){e.preventDefault();safe(()=>showWorkflowHistory('workflow',workflowHistory.dataset.workflowHistory));return}
  const workflowExport=e.target.closest?.('[data-workflow-export]');if(workflowExport){e.preventDefault();safe(()=>exportWorkflowItem('workflow',workflowExport.dataset.workflowExport));return}
  const workflowEdit=e.target.closest?.('[data-workflow-edit]');if(workflowEdit){e.preventDefault();openWorkflowDialog(state.workflows.find(w=>w.id===workflowEdit.dataset.workflowEdit));return}
  const workflowDelete=e.target.closest?.('[data-workflow-delete]');if(workflowDelete){e.preventDefault();safe(async()=>{if(confirm('Delete workflow?')){await api('/api/workflows/'+encodeURIComponent(workflowDelete.dataset.workflowDelete),{method:'DELETE'});await loadWorkflows()}})}
});

bindWorkflowPageControls();
