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
  const [templates,workflows]=await Promise.all([api('/api/templates'),api('/api/workflows')]);
  state.workflowTemplates=templates.templates||[];
  state.workflows=workflows.workflows||[];
  state.workflowRuns=workflows.runs||[];
  renderWorkflowSections();
}

function renderWorkflowSections(){renderTemplates();renderWorkflowList();renderWorkflowRuns();applyPermissions()}
function workflowFilter(value,id){const q=(document.getElementById(id)?.value||'').toLowerCase();if(!q)return true;return [value.name,value.description,(value.tags||[]).join(' '),value.id].join(' ').toLowerCase().includes(q)}
function workflowTags(tags){return (tags||[]).map(t=>'<span class="chip">'+esc(t)+'</span>').join('')}
function workflowCell(label,html,cls=''){return '<td data-label="'+attr(label)+'"'+(cls?' class="'+cls+'"':'')+'>'+html+'</td>'}
function templateUpdatedHtml(t){return t.updatedAt?'<span title="'+attr(fmtDate(t.updatedAt))+'">'+esc(fmtSessionAge(t.updatedAt))+'</span>':'-'}
function templateVariablesText(t){const count=(t.variables||[]).length;return count+' variable'+(count===1?'':'s')}
function renderTemplateRow(t){const summary=t.description||t.prompt||'';const tags=workflowTags(t.tags)||'-';const scope='<span class="adapter-status '+(t.scope==='shared'?'enabled':'planned')+'">'+esc(t.scope||'private')+'</span>';const actions='<div class="data-table-actions"><button data-template-run="'+attr(t.id)+'"'+disabledAttr('workflows.run')+'>Run</button><button class="secondary" data-template-insert="'+attr(t.id)+'">Insert</button><button class="secondary" data-template-preview="'+attr(t.id)+'">Preview</button><button class="secondary" data-template-edit="'+attr(t.id)+'"'+disabledAttr('workflows.write')+'>Edit</button><button class="danger" data-template-delete="'+attr(t.id)+'"'+disabledAttr('workflows.write')+'>Delete</button></div>';return '<tr>'+workflowCell('Updated',templateUpdatedHtml(t),'updated-cell')+workflowCell('Name','<span class="truncate-cell" title="'+attr(t.name||'')+'">'+esc(short(t.name||'-',120))+'</span>','primary-cell')+workflowCell('Scope',scope,'scope-cell')+workflowCell('Tags',tags,'tags-cell')+workflowCell('Variables',esc(templateVariablesText(t)),'variables-cell')+workflowCell('Prompt','<span class="truncate-cell" title="'+attr(summary)+'">'+esc(short(summary||'-',180))+'</span>','prompt-cell')+workflowCell('Actions',actions,'actions-cell')+'</tr>'}
function renderTemplatesTable(templates){if(!templates.length)return uiEmpty('No templates.');return '<div class="data-table-wrap"><table class="data-table templates-table"><thead><tr><th>Updated</th><th>Name</th><th>Scope</th><th>Tags</th><th>Variables</th><th>Prompt</th><th class="actions-heading">Actions</th></tr></thead><tbody>'+templates.map(renderTemplateRow).join('')+'</tbody></table></div>'}

function renderTemplates(){
  const list=(state.workflowTemplates||[]).filter(t=>workflowFilter(t,'templateSearch'));
  document.getElementById('templateList').innerHTML=renderTemplatesTable(list);
  bindTemplateButtons();
}

function renderWorkflowList(){
  const list=(state.workflows||[]).filter(w=>workflowFilter(w,'workflowSearch'));
  document.getElementById('workflowList').innerHTML=list.map(w=>'<div class="item"><strong>'+esc(w.name)+' <span class="adapter-status '+(w.scope==='shared'?'enabled':'planned')+'">'+esc(w.scope)+'</span></strong><small>'+esc(short(w.description||'',260))+'</small><small>'+workflowTags(w.tags)+' '+esc((w.steps||[]).length+' step(s) · updated '+fmtDate(w.updatedAt))+'</small><div class="row"><button data-workflow-run="'+attr(w.id)+'"'+disabledAttr('workflows.run')+'>Run</button><button class="secondary" data-workflow-preview="'+attr(w.id)+'">Preview</button><button class="secondary" data-workflow-edit="'+attr(w.id)+'"'+disabledAttr('workflows.write')+'>Edit</button><button class="danger" data-workflow-delete="'+attr(w.id)+'"'+disabledAttr('workflows.write')+'>Delete</button></div></div>').join('')||uiEmpty('No workflows.');
  bindWorkflowButtons();
}

function renderWorkflowRuns(){
  document.getElementById('workflowRunList').innerHTML=(state.workflowRuns||[]).map(r=>'<div class="item"><strong>'+esc(r.name)+' <span class="adapter-status '+runStatusClass(r.status)+'">'+esc(r.status)+'</span></strong><small>'+esc('Created '+fmtDate(r.createdAt)+' · updated '+fmtDate(r.updatedAt))+'</small>'+(r.error?'<small class="error">'+esc(r.error)+'</small>':'')+'<details><summary>'+esc((r.steps||[]).filter(s=>s.status==='completed').length+'/'+(r.steps||[]).length+' steps')+'</summary><div class="list">'+(r.steps||[]).map(s=>'<div class="item"><strong>'+esc(s.name+' · '+s.status)+'</strong>'+(s.correlationId?'<small>'+uiTraceControls(s.correlationId)+'</small>':'')+(s.error?'<small class="error">'+esc(s.error)+'</small>':'')+'<small>'+esc(short(s.prompt||'',300))+'</small></div>').join('')+'</div></details><div class="row">'+(r.status==='paused'?'<button class="secondary" data-workflow-run-resume="'+attr(r.id)+'"'+disabledAttr('workflows.run')+'>Resume</button>':'')+(['queued','running','paused'].includes(r.status)?'<button class="danger" data-workflow-run-cancel="'+attr(r.id)+'"'+disabledAttr('workflows.run')+'>Cancel</button>':'')+'</div></div>').join('')||uiEmpty('No workflow runs.');
  bindUiTraceButtons(document.getElementById('workflowRunList'));
  document.querySelectorAll('[data-workflow-run-cancel]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('workflows.run')){toast('Permission required: workflows.run');return}await api('/api/workflow-runs/'+encodeURIComponent(b.dataset.workflowRunCancel)+'/cancel',{method:'POST'});toast('Workflow run cancelled');await loadWorkflows()}));
  document.querySelectorAll('[data-workflow-run-resume]').forEach(b=>b.onclick=()=>safe(async()=>{if(!can('workflows.run')){toast('Permission required: workflows.run');return}await api('/api/jobs/'+encodeURIComponent('workflow-run:'+b.dataset.workflowRunResume)+'/action',{method:'POST',body:JSON.stringify({action:'retry'})});toast('Workflow resumed');await loadWorkflows()}));
  applyPermissions();
}

function runStatusClass(status){if(status==='completed')return'enabled';if(status==='failed'||status==='aborted')return'disabled';return'planned'}
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

function showPreview(p){toast((p.prompts||[]).map((step,i)=>(i+1)+'. '+step.name+'\n'+step.prompt).join('\n\n---\n\n').slice(0,3500),{duration:12000})}
function insertTemplate(id){const t=state.workflowTemplates.find(x=>x.id===id);if(!t)return;document.getElementById('promptInput').value=t.prompt;page('chat');document.getElementById('promptInput').focus()}

function openTemplateDialog(t){
  if(!can('workflows.write')){toast('Permission required: workflows.write');return}
  adminDialog(t?'Edit template':'Create template','<label>Name<input id="dlgTemplateName" value="'+attr(t?.name||'')+'"></label><label>Scope<select id="dlgTemplateScope"><option value="private">Private</option><option value="shared">Shared</option></select></label><label class="full-span">Description<input id="dlgTemplateDescription" value="'+attr(t?.description||'')+'"></label><label class="full-span">Tags<input id="dlgTemplateTags" value="'+attr((t?.tags||[]).join(', '))+'"></label><label class="full-span">Prompt<textarea id="dlgTemplatePrompt" rows="10">'+esc(t?.prompt||'')+'</textarea></label>',async()=>{
    const promptText=val('dlgTemplatePrompt');
    const body={name:val('dlgTemplateName'),description:val('dlgTemplateDescription'),tags:csvToList(val('dlgTemplateTags')),prompt:promptText,variables:collectVariablesFromPrompt(promptText).map(name=>({name,required:true})),scope:val('dlgTemplateScope')};
    if(t)await api('/api/templates/'+encodeURIComponent(t.id),{method:'PUT',body:JSON.stringify(body)});
    else await api('/api/templates',{method:'POST',body:JSON.stringify(body)});
  },{afterSubmit:loadWorkflows});
  document.getElementById('dlgTemplateScope').value=t?.scope||'private';
}

function workflowBuilderUid(){return 'step_'+Math.random().toString(36).slice(2,9)}
function workflowStepSource(step){return step.type==='workflow'||step.workflowId?'workflow':step.templateId?'template':'prompt'}
function workflowBuilderStep(step={},index=0){
  return {
    _uid: step._uid||workflowBuilderUid(),
    id: step.id||'',
    name: step.name||'Step '+(index+1),
    source: step.source||workflowStepSource(step),
    prompt: step.prompt||'',
    templateId: step.templateId||'',
    workflowId: step.workflowId||'',
    conditionVariable: step.condition?.variable||'',
    conditionOperator: step.condition?.operator||'exists',
    conditionValue: step.condition?.value||'',
    retryAttempts: step.retryPolicy?.maxAttempts||1,
    retryDelayMs: step.retryPolicy?.delayMs||0,
    agentId: step.agentId||'',
    workspace: step.workspace||'',
    model: step.model||'',
    reasoningEffort: step.reasoningEffort||'',
    launchProfileId: step.launchProfileId||'',
    sessionMode: step.sessionMode||'current',
    threadId: step.threadId||'',
    target: step.target||'local',
    requiresApproval:Boolean(step.requiresApproval),
    continueOnError:Boolean(step.continueOnError),
  };
}

function workflowBuilderState(w){return {workflowId:w?.id||'',steps:(w?.steps?.length?w.steps:[{name:'Step 1',type:'prompt',prompt:'',sessionMode:'current',target:'local'}]).map(workflowBuilderStep)}}
function workflowTemplateOptions(selected){return '<option value="">Select template...</option>'+(state.workflowTemplates||[]).map(t=>'<option value="'+attr(t.id)+'" '+(t.id===selected?'selected':'')+'>'+esc(t.name)+'</option>').join('')}
function workflowOptions(selected,currentId){return '<option value="">Select workflow...</option>'+(state.workflows||[]).filter(w=>w.id!==currentId).map(w=>'<option value="'+attr(w.id)+'" '+(w.id===selected?'selected':'')+'>'+esc(w.name)+'</option>').join('')}
function workflowAgentOptions(selected){return '<option value="">Active agent</option>'+(state.enabledAgents||[]).map(id=>'<option value="'+attr(id)+'" '+(id===selected?'selected':'')+'>'+esc(id)+'</option>').join('')}
function workflowReasoningOptions(selected){return '<option value="">Default</option>'+((state.controls?.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'" '+(v===selected?'selected':'')+'>'+esc(v)+'</option>').join(''))}
function workflowLaunchOptions(selected){return '<option value="">Default</option>'+((state.controls?.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'" '+(p.id===selected?'selected':'')+'>'+esc(p.label+' - '+p.behavior+(p.unsafe?' - unsafe':''))+'</option>').join(''))}
function workflowModelDatalist(){return '<datalist id="workflowModelOptions">'+((state.controls?.models||[]).map(m=>'<option value="'+attr(m.slug)+'">'+esc(modelLabel(m))+'</option>').join(''))+'</datalist>'}
function workflowWorkspaceDatalist(){return '<datalist id="workflowWorkspaceOptions">'+((state.controls?.workspaces||state.snapshot?.workspaces||[]).map(w=>'<option value="'+attr(w)+'"></option>').join(''))+'</datalist>'}

function workflowBuilderStepHtml(step,index){
  const source=step.source||workflowStepSource(step);
  const template=source==='template'?(state.workflowTemplates||[]).find(t=>t.id===step.templateId):null;
  const showNew=step.sessionMode==='new';
  const showAttach=step.sessionMode==='attach';
  return '<div class="workflow-builder-step" data-workflow-builder-step="'+attr(step._uid)+'">'+
    '<div class="workflow-step-header"><strong>Step '+esc(index+1)+'</strong><div class="row workflow-step-actions">'+
    '<button type="button" class="secondary mini-button" data-workflow-builder-move="up" '+(index===0?'disabled':'')+'>Up</button>'+
    '<button type="button" class="secondary mini-button" data-workflow-builder-move="down" '+(index===state.workflowBuilder.steps.length-1?'disabled':'')+'>Down</button>'+
    '<button type="button" class="secondary mini-button" data-workflow-builder-duplicate>Duplicate</button>'+
    '<button type="button" class="danger mini-button" data-workflow-builder-delete '+(state.workflowBuilder.steps.length<2?'disabled':'')+'>Delete</button>'+
    '</div></div>'+
    '<div class="workflow-builder-grid">'+
    '<label>Step name<input data-builder-field="name" value="'+attr(step.name)+'"></label>'+
    '<label>Source<select data-builder-field="source"><option value="prompt" '+(source==='prompt'?'selected':'')+'>Prompt text</option><option value="template" '+(source==='template'?'selected':'')+'>Template</option><option value="workflow" '+(source==='workflow'?'selected':'')+'>Subflow</option></select></label>'+
    (source==='template'
      ? '<label class="full-span">Template<select data-builder-field="templateId">'+workflowTemplateOptions(step.templateId)+'</select></label>'+(template?'<div class="workflow-template-preview full-span"><strong>'+esc(template.name)+'</strong><small>'+esc(short(template.description||template.prompt,320))+'</small></div>':'<div class="workflow-template-preview full-span">Select a template for this step.</div>')
      : source==='workflow'
        ? '<label class="full-span">Subflow<select data-builder-field="workflowId">'+workflowOptions(step.workflowId,state.workflowBuilder.workflowId)+'</select></label>'
        : '<label class="full-span">Prompt<textarea data-builder-field="prompt" rows="6" placeholder="Write the prompt for this workflow step...">'+esc(step.prompt||'')+'</textarea></label>')+
    '<label>Session<select data-builder-field="sessionMode"><option value="current" '+(step.sessionMode==='current'?'selected':'')+'>Current session</option><option value="new" '+(step.sessionMode==='new'?'selected':'')+'>New session</option><option value="attach" '+(step.sessionMode==='attach'?'selected':'')+'>Attach to thread</option></select></label>'+
    '<label>Agent<select data-builder-field="agentId">'+workflowAgentOptions(step.agentId)+'</select></label>'+
    (showAttach?'<label class="full-span">Thread ID<input data-builder-field="threadId" value="'+attr(step.threadId)+'" placeholder="Thread ID to attach"></label>':'')+
    (showNew?'<label>Workspace<input data-builder-field="workspace" value="'+attr(step.workspace)+'" list="workflowWorkspaceOptions" placeholder="Default workspace"></label><label>Model<input data-builder-field="model" value="'+attr(step.model)+'" list="workflowModelOptions" placeholder="Default model"></label><label>Reasoning<select data-builder-field="reasoningEffort">'+workflowReasoningOptions(step.reasoningEffort)+'</select></label><label>Launch profile<select data-builder-field="launchProfileId">'+workflowLaunchOptions(step.launchProfileId)+'</select></label>':'')+
    '<label>Target<select data-builder-field="target"><option value="local" '+(step.target==='local'?'selected':'')+'>Local node</option></select></label>'+
    '<label>Condition variable<input data-builder-field="conditionVariable" value="'+attr(step.conditionVariable)+'" placeholder="optional variable"></label>'+
    '<label>Condition<select data-builder-field="conditionOperator"><option value="exists" '+(step.conditionOperator==='exists'?'selected':'')+'>exists</option><option value="equals" '+(step.conditionOperator==='equals'?'selected':'')+'>equals</option><option value="not_equals" '+(step.conditionOperator==='not_equals'?'selected':'')+'>not equals</option><option value="contains" '+(step.conditionOperator==='contains'?'selected':'')+'>contains</option><option value="not_contains" '+(step.conditionOperator==='not_contains'?'selected':'')+'>not contains</option></select></label>'+
    '<label>Condition value<input data-builder-field="conditionValue" value="'+attr(step.conditionValue)+'"></label>'+
    '<label>Retry attempts<input type="number" min="1" max="10" data-builder-field="retryAttempts" value="'+attr(step.retryAttempts)+'"></label>'+
    '<label>Retry delay ms<input type="number" min="0" data-builder-field="retryDelayMs" value="'+attr(step.retryDelayMs)+'"></label>'+
    '<label class="checkbox workflow-builder-check"><input type="checkbox" data-builder-field="requiresApproval" '+(step.requiresApproval?'checked':'')+'> Require approval</label>'+
    '<label class="checkbox workflow-builder-check"><input type="checkbox" data-builder-field="continueOnError" '+(step.continueOnError?'checked':'')+'> Continue on error</label>'+
    '</div></div>';
}

function workflowBuilderJsonFromState(){return JSON.stringify(workflowBuilderStepsPayload(false),null,2)}
function workflowBuilderPreviewText(){
  return workflowBuilderStepsPayload(false).map((step,index)=>{
    const template=step.templateId?state.workflowTemplates.find(t=>t.id===step.templateId):null;
    const subflow=step.workflowId?state.workflows.find(w=>w.id===step.workflowId):null;
    const prompt=subflow?('Run subflow: '+subflow.name):template?.prompt||step.prompt||'';
    return (index+1)+'. '+(step.name||'Step '+(index+1))+'\n'+prompt;
  }).join('\n\n---\n\n');
}

function workflowBuilderVariablesHtml(){
  const items=workflowBuilderStepsPayload(false).map(step=>step.templateId?state.workflowTemplates.find(t=>t.id===step.templateId)||step:step);
  const vars=workflowVariableDefinitions(items);
  if(!vars.length)return '<small>No variables detected.</small>';
  return '<small>Variables: '+vars.map(v=>'<span class="chip">'+esc(v.name)+'</span>').join('')+'</small>';
}

function renderWorkflowBuilder(){
  const target=document.getElementById('workflowBuilderSteps');
  if(!target)return;
  target.innerHTML=(state.workflowBuilder.steps||[]).map(workflowBuilderStepHtml).join('');
  document.getElementById('workflowBuilderDataLists').innerHTML=workflowModelDatalist()+workflowWorkspaceDatalist();
  bindWorkflowBuilderControls();
  updateWorkflowBuilderPreview();
  applyPermissions();
}

function collectWorkflowBuilderFromDom(){
  if(!state.workflowBuilder)return;
  state.workflowBuilder.steps=(state.workflowBuilder.steps||[]).map(step=>{
    const card=document.querySelector('[data-workflow-builder-step="'+cssEscape(step._uid)+'"]');
    if(!card)return step;
    const field=name=>card.querySelector('[data-builder-field="'+name+'"]');
    return {
      ...step,
      name:(field('name')?.value||'').trim(),
      source:field('source')?.value||step.source||'prompt',
      prompt:field('prompt')?.value||'',
      templateId:field('templateId')?.value||'',
      workflowId:field('workflowId')?.value||'',
      conditionVariable:field('conditionVariable')?.value||'',
      conditionOperator:field('conditionOperator')?.value||'exists',
      conditionValue:field('conditionValue')?.value||'',
      retryAttempts:Number(field('retryAttempts')?.value||1),
      retryDelayMs:Number(field('retryDelayMs')?.value||0),
      agentId:field('agentId')?.value||'',
      workspace:field('workspace')?.value||'',
      model:field('model')?.value||'',
      reasoningEffort:field('reasoningEffort')?.value||'',
      launchProfileId:field('launchProfileId')?.value||'',
      sessionMode:field('sessionMode')?.value||'current',
      threadId:field('threadId')?.value||'',
      target:field('target')?.value||'local',
      requiresApproval:Boolean(field('requiresApproval')?.checked),
      continueOnError:Boolean(field('continueOnError')?.checked),
    };
  });
}

function workflowBuilderStepsPayload(collect=true){
  if(collect)collectWorkflowBuilderFromDom();
  return (state.workflowBuilder?.steps||[]).map((step,index)=>{
    const source=step.source||workflowStepSource(step);
    return {
      id:step.id||undefined,
      name:step.name||'Step '+(index+1),
      type:source==='workflow'?'workflow':'prompt',
      prompt:source==='prompt'?(step.prompt||''):undefined,
      templateId:source==='template'?(step.templateId||undefined):undefined,
      workflowId:source==='workflow'?(step.workflowId||undefined):undefined,
      condition:step.conditionVariable?{variable:step.conditionVariable,operator:step.conditionOperator||'exists',value:step.conditionValue||undefined}:undefined,
      retryPolicy:(Number(step.retryAttempts)>1||Number(step.retryDelayMs)>0)?{maxAttempts:Number(step.retryAttempts)||1,delayMs:Number(step.retryDelayMs)||0}:undefined,
      agentId:step.agentId||undefined,
      workspace:step.sessionMode==='new'?(step.workspace||undefined):undefined,
      model:step.sessionMode==='new'?(step.model||undefined):undefined,
      reasoningEffort:step.sessionMode==='new'?(step.reasoningEffort||undefined):undefined,
      launchProfileId:step.sessionMode==='new'?(step.launchProfileId||undefined):undefined,
      sessionMode:step.sessionMode||'current',
      threadId:step.sessionMode==='attach'?(step.threadId||undefined):undefined,
      target:step.target||'local',
      requiresApproval:Boolean(step.requiresApproval),
      continueOnError:Boolean(step.continueOnError),
    };
  });
}

function validateWorkflowBuilder(){
  collectWorkflowBuilderFromDom();
  const rawSteps=state.workflowBuilder?.steps||[];
  const steps=workflowBuilderStepsPayload(false);
  const errors=[];
  if(!steps.length)errors.push('Add at least one step.');
  steps.forEach((step,index)=>{
    const rawStep=rawSteps[index]||{};
    const label=step.name||'Step '+(index+1);
    if((rawStep.source||workflowStepSource(rawStep))==='template'&&!step.templateId)errors.push(label+': template is required.');
    if(step.templateId&&!state.workflowTemplates.some(t=>t.id===step.templateId))errors.push(label+': selected template was not found.');
    if((rawStep.source||workflowStepSource(rawStep))==='workflow'&&!step.workflowId)errors.push(label+': subflow is required.');
    if(step.workflowId&&!state.workflows.some(w=>w.id===step.workflowId))errors.push(label+': selected subflow was not found.');
    if((rawStep.source||workflowStepSource(rawStep))==='prompt'&&!String(step.prompt||'').trim())errors.push(label+': prompt text is required.');
    if(step.sessionMode==='attach'&&!step.threadId)errors.push(label+': thread ID is required for attach mode.');
  });
  const target=document.getElementById('workflowBuilderValidation');
  if(target)target.innerHTML=errors.map(error=>'<div class="workflow-builder-error">'+esc(error)+'</div>').join('');
  return errors;
}

function updateWorkflowBuilderPreview(){
  const json=document.getElementById('dlgWorkflowStepsJson');
  if(json&&!json.matches(':focus'))json.value=workflowBuilderJsonFromState();
  const preview=document.getElementById('workflowBuilderPreview');
  if(preview)preview.innerHTML='<pre>'+esc(workflowBuilderPreviewText()||'Add a prompt or template step to preview the workflow.')+'</pre>'+workflowBuilderVariablesHtml();
  validateWorkflowBuilder();
}

function bindWorkflowBuilderControls(){
  document.querySelectorAll('[data-workflow-builder-step] [data-builder-field]').forEach(el=>{
    el.oninput=()=>{collectWorkflowBuilderFromDom();updateWorkflowBuilderPreview()};
    el.onchange=()=>{collectWorkflowBuilderFromDom();if(['source','sessionMode','templateId'].includes(el.dataset.builderField))renderWorkflowBuilder();else updateWorkflowBuilderPreview()};
  });
  document.querySelectorAll('[data-workflow-builder-move]').forEach(b=>b.onclick=()=>{collectWorkflowBuilderFromDom();const uid=b.closest('[data-workflow-builder-step]').dataset.workflowBuilderStep;const index=state.workflowBuilder.steps.findIndex(s=>s._uid===uid);const next=b.dataset.workflowBuilderMove==='up'?index-1:index+1;if(index<0||next<0||next>=state.workflowBuilder.steps.length)return;const steps=state.workflowBuilder.steps;[steps[index],steps[next]]=[steps[next],steps[index]];renderWorkflowBuilder()});
  document.querySelectorAll('[data-workflow-builder-delete]').forEach(b=>b.onclick=()=>{collectWorkflowBuilderFromDom();const uid=b.closest('[data-workflow-builder-step]').dataset.workflowBuilderStep;state.workflowBuilder.steps=state.workflowBuilder.steps.filter(s=>s._uid!==uid);if(!state.workflowBuilder.steps.length)state.workflowBuilder.steps.push(workflowBuilderStep({},0));renderWorkflowBuilder()});
  document.querySelectorAll('[data-workflow-builder-duplicate]').forEach(b=>b.onclick=()=>{collectWorkflowBuilderFromDom();const uid=b.closest('[data-workflow-builder-step]').dataset.workflowBuilderStep;const index=state.workflowBuilder.steps.findIndex(s=>s._uid===uid);if(index<0)return;const copy={...state.workflowBuilder.steps[index],_uid:workflowBuilderUid(),id:'',name:(state.workflowBuilder.steps[index].name||'Step')+' copy'};state.workflowBuilder.steps.splice(index+1,0,copy);renderWorkflowBuilder()});
  document.querySelectorAll('[data-workflow-builder-add]').forEach(b=>b.onclick=()=>{collectWorkflowBuilderFromDom();state.workflowBuilder.steps.push(workflowBuilderStep({},state.workflowBuilder.steps.length));renderWorkflowBuilder()});
  const syncJson=document.getElementById('workflowBuilderSyncJsonBtn');
  if(syncJson)syncJson.onclick=()=>{collectWorkflowBuilderFromDom();document.getElementById('dlgWorkflowStepsJson').value=workflowBuilderJsonFromState();toast('Workflow JSON updated')};
  const copyJson=document.getElementById('workflowBuilderCopyJsonBtn');
  if(copyJson)copyJson.onclick=()=>copyText(workflowBuilderJsonFromState(),'Workflow JSON copied');
  const importJson=document.getElementById('workflowBuilderImportJsonBtn');
  if(importJson)importJson.onclick=()=>safe(()=>{const raw=document.getElementById('dlgWorkflowStepsJson').value;const parsed=JSON.parse(raw);if(!Array.isArray(parsed))throw new Error('Workflow JSON must be an array of steps.');state.workflowBuilder.steps=parsed.map(workflowBuilderStep);renderWorkflowBuilder();toast('Workflow JSON imported')});
  const previewBtn=document.getElementById('workflowBuilderPreviewBtn');
  if(previewBtn)previewBtn.onclick=()=>{collectWorkflowBuilderFromDom();toast(workflowBuilderPreviewText().slice(0,3500),{duration:12000})};
}

function workflowDialogBody(w){
  return '<label>Name<input id="dlgWorkflowName" value="'+attr(w?.name||'')+'"></label>'+
    '<label>Scope<select id="dlgWorkflowScope"><option value="private">Private</option><option value="shared">Shared</option></select></label>'+
    '<label class="full-span">Description<input id="dlgWorkflowDescription" value="'+attr(w?.description||'')+'"></label>'+
    '<label class="full-span">Tags<input id="dlgWorkflowTags" value="'+attr((w?.tags||[]).join(', '))+'"></label>'+
    '<label class="checkbox"><input id="dlgWorkflowScheduleEnabled" type="checkbox" '+(w?.schedule?.enabled?'checked':'')+'> Schedule enabled</label>'+
    '<label>Run at<input id="dlgWorkflowScheduleRunAt" type="datetime-local" value="'+attr(datetimeLocalValue(w?.schedule?.nextRunAt||w?.schedule?.runAt||''))+'"></label>'+
    '<label>Repeat minutes<input id="dlgWorkflowScheduleInterval" type="number" min="0" value="'+attr(w?.schedule?.intervalMinutes||0)+'"></label>'+
    '<div class="workflow-builder full-span">'+
    '<div class="workflow-builder-toolbar"><strong>Workflow builder</strong><div class="row"><button type="button" data-workflow-builder-add>Add step</button><button type="button" id="workflowBuilderPreviewBtn" class="secondary">Preview workflow</button></div></div>'+
    '<div id="workflowBuilderSteps" class="workflow-builder-steps"></div>'+
    '<div id="workflowBuilderValidation" class="workflow-builder-validation"></div>'+
    '<details class="workflow-builder-json"><summary>Advanced JSON import/export</summary><textarea id="dlgWorkflowStepsJson" rows="8"></textarea><div class="row"><button type="button" id="workflowBuilderImportJsonBtn" class="secondary">Import JSON</button><button type="button" id="workflowBuilderSyncJsonBtn" class="secondary">Update JSON from builder</button><button type="button" id="workflowBuilderCopyJsonBtn" class="secondary">Copy JSON</button></div></details>'+
    '<div class="workflow-builder-preview"><strong>Live preview</strong><div id="workflowBuilderPreview"></div></div>'+
    '<div id="workflowBuilderDataLists"></div>'+
    '</div>';
}

function openWorkflowDialog(w){
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
function workflowSchedulePayload(){const enabled=Boolean(document.getElementById('dlgWorkflowScheduleEnabled')?.checked);const runAtLocal=val('dlgWorkflowScheduleRunAt');const intervalMinutes=Number(val('dlgWorkflowScheduleInterval')||0);const runAt=runAtLocal?new Date(runAtLocal).toISOString():undefined;return enabled||runAt||intervalMinutes?{enabled,runAt,nextRunAt:runAt,intervalMinutes}:undefined}

function bindWorkflowPageControls(){
  const templateSearch=document.getElementById('templateSearch');if(templateSearch&&!templateSearch.dataset.bound){templateSearch.dataset.bound='true';templateSearch.oninput=renderTemplates}
  const workflowSearch=document.getElementById('workflowSearch');if(workflowSearch&&!workflowSearch.dataset.bound){workflowSearch.dataset.bound='true';workflowSearch.oninput=renderWorkflowList}
  const picker=document.getElementById('templatePickerBtn');if(picker&&!picker.dataset.bound){picker.dataset.bound='true';picker.onclick=()=>{if(!can('workflows.read')){toast('Permission required: workflows.read');return}page('workflows')}}
}

document.addEventListener('click',e=>{
  const tab=e.target.closest?.('[data-workflow-tab]');if(tab){e.preventDefault();switchWorkflowTab(tab.dataset.workflowTab);return}
  const createTemplate=e.target.closest?.('#createTemplateBtn');if(createTemplate){e.preventDefault();openTemplateDialog();return}
  const createWorkflow=e.target.closest?.('#createWorkflowBtn');if(createWorkflow){e.preventDefault();openWorkflowDialog();return}
  const reload=e.target.closest?.('#reloadWorkflowsBtn,#reloadWorkflowRunsBtn');if(reload){e.preventDefault();safe(loadWorkflows);return}
  const templateRun=e.target.closest?.('[data-template-run]');if(templateRun){e.preventDefault();safe(()=>runTemplate(templateRun.dataset.templateRun));return}
  const templateInsert=e.target.closest?.('[data-template-insert]');if(templateInsert){e.preventDefault();insertTemplate(templateInsert.dataset.templateInsert);return}
  const templatePreview=e.target.closest?.('[data-template-preview]');if(templatePreview){e.preventDefault();safe(()=>previewTemplate(templatePreview.dataset.templatePreview));return}
  const templateEdit=e.target.closest?.('[data-template-edit]');if(templateEdit){e.preventDefault();openTemplateDialog(state.workflowTemplates.find(t=>t.id===templateEdit.dataset.templateEdit));return}
  const templateDelete=e.target.closest?.('[data-template-delete]');if(templateDelete){e.preventDefault();safe(async()=>{if(confirm('Delete template?')){await api('/api/templates/'+encodeURIComponent(templateDelete.dataset.templateDelete),{method:'DELETE'});await loadWorkflows()}});return}
  const workflowRun=e.target.closest?.('[data-workflow-run]');if(workflowRun){e.preventDefault();safe(()=>runWorkflow(workflowRun.dataset.workflowRun));return}
  const workflowPreview=e.target.closest?.('[data-workflow-preview]');if(workflowPreview){e.preventDefault();safe(()=>previewWorkflow(workflowPreview.dataset.workflowPreview));return}
  const workflowEdit=e.target.closest?.('[data-workflow-edit]');if(workflowEdit){e.preventDefault();openWorkflowDialog(state.workflows.find(w=>w.id===workflowEdit.dataset.workflowEdit));return}
  const workflowDelete=e.target.closest?.('[data-workflow-delete]');if(workflowDelete){e.preventDefault();safe(async()=>{if(confirm('Delete workflow?')){await api('/api/workflows/'+encodeURIComponent(workflowDelete.dataset.workflowDelete),{method:'DELETE'});await loadWorkflows()}})}
});

bindWorkflowPageControls();
