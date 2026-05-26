function workflowBuilderUid(){return 'step_'+Math.random().toString(36).slice(2,9)}
function workflowStepSource(step){return step.type==='plugin'||step.pluginId?'plugin':step.type==='workflow'||step.workflowId?'workflow':step.templateId?'template':'prompt'}
function workflowBuilderStep(step:WebuiWorkflowBuilderStep={},index=0){
  return {
    _uid: step._uid||workflowBuilderUid(),
    id: step.id||'',
    name: step.name||'Step '+(index+1),
    source: step.source||workflowStepSource(step),
    prompt: step.prompt||'',
    templateId: step.templateId||'',
    workflowId: step.workflowId||'',
    pluginId: step.pluginId||'',
    pluginActionId: step.pluginActionId||'',
    pluginInputJson: step.pluginInputJson||JSON.stringify(step.pluginInput||{},null,2),
    pluginOutputVariablesJson: step.pluginOutputVariablesJson||JSON.stringify(step.pluginOutputVariables||{},null,2),
    conditionVariable: step.condition?.variable||'',
    conditionOperator: step.condition?.operator||'exists',
    conditionValue: step.condition?.value||'',
    retryAttempts: step.retryPolicy?.maxAttempts||1,
    retryDelayMs: step.retryPolicy?.delayMs||0,
    agentId: step.agentId||'',
    workspace: step.workspace||'',
    workspaceMode: step.workspaceMode||'',
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
function workflowPluginActionOptions(selectedPlugin,selectedAction){const actions=Array.isArray(state.pluginCatalog?.workflowActions)?state.pluginCatalog.workflowActions:[];if(!actions.length)return '<option value="">No plugin workflow actions</option>';return '<option value="">Select plugin action...</option>'+actions.map(action=>{const value=action.pluginId+'::'+action.actionId;const selected=value===(selectedPlugin+'::'+selectedAction);return '<option value="'+attr(value)+'" '+(selected?'selected':'')+'>'+esc((action.title||action.actionId)+' ('+action.pluginId+')')+'</option>'}).join('')}
function workflowPluginAction(pluginId,actionId){const actions=Array.isArray(state.pluginCatalog?.workflowActions)?state.pluginCatalog.workflowActions:[];return actions.find(action=>action.pluginId===pluginId&&action.actionId===actionId)||null}
function workflowAgentOptions(selected){return '<option value="">Active agent</option>'+(state.enabledAgents||[]).map(id=>'<option value="'+attr(id)+'" '+(id===selected?'selected':'')+'>'+esc(id)+'</option>').join('')}
function workflowReasoningOptions(selected){return '<option value="">Default</option>'+((state.controls?.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'" '+(v===selected?'selected':'')+'>'+esc(v)+'</option>').join(''))}
function workflowLaunchOptions(selected){return '<option value="">Default</option>'+((state.controls?.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'" '+(p.id===selected?'selected':'')+'>'+esc(p.label+' - '+p.behavior+(p.unsafe?' - unsafe':''))+'</option>').join(''))}
function workflowWorkspaceModeOptions(selected){return '<option value="">Default</option><option value="shared" '+(selected==='shared'?'selected':'')+'>Shared workspace</option><option value="worktree" '+(selected==='worktree'?'selected':'')+'>Isolated worktree</option><option value="attached" '+(selected==='attached'?'selected':'')+'>Attached/manual</option>'}
function workflowTargetOptions(selected){const peers=(state.peers?.peers||[]).filter(p=>p.enabled);const known=new Set(peers.map(p=>'peer:'+p.id));const fallback=selected&&selected!=='local'&&!known.has(selected)?'<option value="'+attr(selected)+'" selected>'+esc(selected+' (unavailable)')+'</option>':'';return '<option value="local" '+(!selected||selected==='local'?'selected':'')+'>Local node</option>'+peers.map(p=>'<option value="peer:'+attr(p.id)+'" '+(selected==='peer:'+p.id?'selected':'')+'>'+esc('Peer: '+(p.name||p.id))+'</option>').join('')+fallback}
function workflowModelDatalist(){return '<datalist id="workflowModelOptions">'+((state.controls?.models||[]).map(m=>'<option value="'+attr(m.slug)+'">'+esc(modelLabel(m))+'</option>').join(''))+'</datalist>'}
function workflowWorkspaceDatalist(){return '<datalist id="workflowWorkspaceOptions">'+((state.controls?.workspaces||state.snapshot?.workspaces||[]).map(w=>'<option value="'+attr(w)+'"></option>').join(''))+'</datalist>'}

function workflowBuilderStepHtml(step,index){
  const source=step.source||workflowStepSource(step);
  const template=source==='template'?(state.workflowTemplates||[]).find(t=>t.id===step.templateId):null;
  const pluginAction=source==='plugin'?workflowPluginAction(step.pluginId,step.pluginActionId):null;
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
    '<label>Source<select data-builder-field="source"><option value="prompt" '+(source==='prompt'?'selected':'')+'>Prompt text</option><option value="template" '+(source==='template'?'selected':'')+'>Template</option><option value="workflow" '+(source==='workflow'?'selected':'')+'>Subflow</option><option value="plugin" '+(source==='plugin'?'selected':'')+'>Plugin action</option></select></label>'+
    (source==='template'
      ? '<label class="full-span">Template<select data-builder-field="templateId">'+workflowTemplateOptions(step.templateId)+'</select></label>'+(template?'<div class="workflow-template-preview full-span"><strong>'+esc(template.name)+'</strong><small>'+esc(short(template.description||template.prompt,320))+'</small></div>':'<div class="workflow-template-preview full-span">Select a template for this step.</div>')
      : source==='workflow'
        ? '<label class="full-span">Subflow<select data-builder-field="workflowId">'+workflowOptions(step.workflowId,state.workflowBuilder.workflowId)+'</select></label>'
        : source==='plugin'
          ? '<label class="full-span">Plugin action<select data-builder-field="pluginAction">'+workflowPluginActionOptions(step.pluginId,step.pluginActionId)+'</select></label>'+workflowPluginInputBuilderHtml(step,pluginAction)+'<label class="full-span">Output variables JSON<textarea data-builder-field="pluginOutputVariablesJson" rows="4" placeholder="{ &quot;variableName&quot;: &quot;output.path&quot; }">'+esc(step.pluginOutputVariablesJson||JSON.stringify(pluginAction?.outputVariables||{},null,2))+'</textarea><small>Map plugin output paths to workflow variables for later steps.</small></label>'
          : '<label class="full-span">Prompt<textarea data-builder-field="prompt" rows="6" placeholder="Write the prompt for this workflow step...">'+esc(step.prompt||'')+'</textarea></label>')+
    '<label>Session<select data-builder-field="sessionMode"><option value="current" '+(step.sessionMode==='current'?'selected':'')+'>Current session</option><option value="new" '+(step.sessionMode==='new'?'selected':'')+'>New session</option><option value="attach" '+(step.sessionMode==='attach'?'selected':'')+'>Attach to thread</option></select></label>'+
    '<label>Agent<select data-builder-field="agentId">'+workflowAgentOptions(step.agentId)+'</select></label>'+
    (showAttach?'<label class="full-span">Thread ID<input data-builder-field="threadId" value="'+attr(step.threadId)+'" placeholder="Thread ID to attach"></label>':'')+
    (showNew?'<label>Workspace<input data-builder-field="workspace" value="'+attr(step.workspace)+'" list="workflowWorkspaceOptions" placeholder="Default workspace"></label><label>Workspace mode<select data-builder-field="workspaceMode">'+workflowWorkspaceModeOptions(step.workspaceMode)+'</select></label><label>Model<input data-builder-field="model" value="'+attr(step.model)+'" list="workflowModelOptions" placeholder="Default model"></label><label>Reasoning<select data-builder-field="reasoningEffort">'+workflowReasoningOptions(step.reasoningEffort)+'</select></label><label>Launch profile<select data-builder-field="launchProfileId">'+workflowLaunchOptions(step.launchProfileId)+'</select></label>':'')+
    '<label>Target<select data-builder-field="target">'+workflowTargetOptions(step.target)+'</select></label>'+
    '<label>Condition variable<input data-builder-field="conditionVariable" value="'+attr(step.conditionVariable)+'" placeholder="optional variable"></label>'+
    '<label>Condition<select data-builder-field="conditionOperator"><option value="exists" '+(step.conditionOperator==='exists'?'selected':'')+'>exists</option><option value="equals" '+(step.conditionOperator==='equals'?'selected':'')+'>equals</option><option value="not_equals" '+(step.conditionOperator==='not_equals'?'selected':'')+'>not equals</option><option value="contains" '+(step.conditionOperator==='contains'?'selected':'')+'>contains</option><option value="not_contains" '+(step.conditionOperator==='not_contains'?'selected':'')+'>not contains</option></select></label>'+
    '<label>Condition value<input data-builder-field="conditionValue" value="'+attr(step.conditionValue)+'"></label>'+
    '<label>Retry attempts<input type="number" min="1" max="10" data-builder-field="retryAttempts" value="'+attr(step.retryAttempts)+'"></label>'+
    '<label>Retry delay ms<input type="number" min="0" data-builder-field="retryDelayMs" value="'+attr(step.retryDelayMs)+'"></label>'+
    '<label class="checkbox workflow-builder-check"><input type="checkbox" data-builder-field="requiresApproval" '+(step.requiresApproval?'checked':'')+'> Require approval</label>'+
    '<label class="checkbox workflow-builder-check"><input type="checkbox" data-builder-field="continueOnError" '+(step.continueOnError?'checked':'')+'> Continue on error</label>'+
    '</div></div>';
}
function workflowPluginInputBuilderHtml(step,action){
  const schema=action?.inputSchema;
  const props=schema&&typeof schema==='object'&&!Array.isArray(schema)&&schema.properties&&typeof schema.properties==='object'?schema.properties:null;
  if(!props)return '<label class="full-span">Plugin input JSON<textarea data-builder-field="pluginInputJson" rows="6" placeholder="{ }">'+esc(step.pluginInputJson||'{}')+'</textarea><small>String values can use workflow variables like {{name}}.</small></label>';
  const current=safeJsonObject(step.pluginInputJson)||{};
  const fields=Object.entries(props).map(([key,rawMeta])=>{
    const meta=rawMeta as WebuiRecord;
    const type=meta?.type||'string';
    const value=current[key]??meta?.default??(type==='boolean'?false:type==='number'?0:'');
    if(type==='boolean')return '<label class="checkbox workflow-builder-check"><input type="checkbox" data-builder-plugin-input-key="'+attr(key)+'" '+(value?'checked':'')+'> '+esc(meta?.title||key)+'</label>';
    return '<label><span>'+esc(meta?.title||key)+'</span><input data-builder-plugin-input-key="'+attr(key)+'" type="'+(type==='number'?'number':'text')+'" value="'+attr(value)+'" placeholder="'+attr(meta?.description||'')+'"></label>';
  }).join('');
  return '<div class="full-span workflow-template-preview"><strong>Plugin input</strong><div class="workflow-builder-grid">'+fields+'</div><small>Generated from the plugin inputSchema. Values can use {{variables}}.</small></div>';
}

function workflowBuilderJsonFromState(){return JSON.stringify(workflowBuilderStepsPayload(false),null,2)}
function workflowBuilderPreviewText(){
  return workflowBuilderStepsPayload(false).map((step,index)=>{
    const template=step.templateId?state.workflowTemplates.find(t=>t.id===step.templateId):null;
    const subflow=step.workflowId?state.workflows.find(w=>w.id===step.workflowId):null;
    const actions=Array.isArray(state.pluginCatalog?.workflowActions)?state.pluginCatalog.workflowActions:[];
    const action=step.pluginActionId?actions.find(a=>a.pluginId===step.pluginId&&a.actionId===step.pluginActionId):null;
    const prompt=action?('Run plugin action: '+action.title+' ('+step.pluginId+'/'+step.pluginActionId+')'):subflow?('Run subflow: '+subflow.name):template?.prompt||step.prompt||'';
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
      pluginId:(field('pluginAction')?.value||'').split('::')[0]||'',
      pluginActionId:(field('pluginAction')?.value||'').split('::')[1]||'',
      pluginInputJson:collectPluginInputJson(card,field('pluginInputJson')?.value||'{}'),
      pluginOutputVariablesJson:field('pluginOutputVariablesJson')?.value||'{}',
      conditionVariable:field('conditionVariable')?.value||'',
      conditionOperator:field('conditionOperator')?.value||'exists',
      conditionValue:field('conditionValue')?.value||'',
      retryAttempts:Number(field('retryAttempts')?.value||1),
      retryDelayMs:Number(field('retryDelayMs')?.value||0),
      agentId:field('agentId')?.value||'',
      workspace:field('workspace')?.value||'',
      workspaceMode:field('workspaceMode')?.value||'',
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
      type:source==='workflow'?'workflow':source==='plugin'?'plugin':'prompt',
      prompt:source==='prompt'?(step.prompt||''):undefined,
      templateId:source==='template'?(step.templateId||undefined):undefined,
      workflowId:source==='workflow'?(step.workflowId||undefined):undefined,
      pluginId:source==='plugin'?(step.pluginId||undefined):undefined,
      pluginActionId:source==='plugin'?(step.pluginActionId||undefined):undefined,
      pluginInput:source==='plugin'?parseWorkflowPluginInput(step.pluginInputJson):undefined,
      pluginOutputVariables:source==='plugin'?parseWorkflowPluginOutputVariables(step.pluginOutputVariablesJson):undefined,
      condition:step.conditionVariable?{variable:step.conditionVariable,operator:step.conditionOperator||'exists',value:step.conditionValue||undefined}:undefined,
      retryPolicy:(Number(step.retryAttempts)>1||Number(step.retryDelayMs)>0)?{maxAttempts:Number(step.retryAttempts)||1,delayMs:Number(step.retryDelayMs)||0}:undefined,
      agentId:step.agentId||undefined,
      workspace:step.sessionMode==='new'?(step.workspace||undefined):undefined,
      workspaceMode:step.sessionMode==='new'?(step.workspaceMode||undefined):undefined,
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

function parseWorkflowPluginInput(text){
  const raw=String(text||'{}').trim()||'{}';
  const parsed=JSON.parse(raw);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Plugin input must be a JSON object.');
  return parsed;
}
function parseWorkflowPluginOutputVariables(text){
  const raw=String(text||'{}').trim()||'{}';
  const parsed=JSON.parse(raw);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Plugin output variables must be a JSON object.');
  return Object.fromEntries(Object.entries(parsed).filter(([,value])=>String(value||'').trim()).map(([key,value])=>[key,String(value)]));
}
function safeJsonObject(text){try{const parsed=JSON.parse(String(text||'{}'));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null}catch{return null}}
function collectPluginInputJson(card,fallback){
  const fields=Array.from(card.querySelectorAll('[data-builder-plugin-input-key]'));
  if(!fields.length)return fallback;
  const output={};
  fields.forEach(rawInput=>{const input=rawInput as HTMLInputElement;const key=input.dataset.builderPluginInputKey;if(!key)return;output[key]=input.type==='checkbox'?Boolean(input.checked):input.type==='number'?Number(input.value||0):input.value||''});
  return JSON.stringify(output,null,2);
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
    if((rawStep.source||workflowStepSource(rawStep))==='plugin'&&!step.pluginActionId)errors.push(label+': plugin action is required.');
    if((rawStep.source||workflowStepSource(rawStep))==='plugin'){try{parseWorkflowPluginInput(rawStep.pluginInputJson)}catch(error){errors.push(label+': plugin input JSON is invalid.');}}
    if((rawStep.source||workflowStepSource(rawStep))==='plugin'){try{parseWorkflowPluginOutputVariables(rawStep.pluginOutputVariablesJson)}catch(error){errors.push(label+': output variables JSON is invalid.');}}
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
    el.onchange=()=>{collectWorkflowBuilderFromDom();if(['source','sessionMode','templateId','pluginAction'].includes(el.dataset.builderField))renderWorkflowBuilder();else updateWorkflowBuilderPreview()};
  });
  document.querySelectorAll('[data-builder-plugin-input-key]').forEach(el=>{
    el.oninput=()=>{collectWorkflowBuilderFromDom();updateWorkflowBuilderPreview()};
    el.onchange=()=>{collectWorkflowBuilderFromDom();updateWorkflowBuilderPreview()};
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
