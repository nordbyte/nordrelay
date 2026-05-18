if(state.metricsTab===undefined)state.metricsTab='overview';
if(state.metricsAutoRefresh===undefined)state.metricsAutoRefresh=localStorage.getItem('nordrelayMetricsAutoRefresh')==='true';
let metricsAutoRefreshTimer=null;
let metricsAgeTimer=null;
async function loadMetrics(options:any={}){
  if(!options.silent)setLoading('metricsPanel','Loading metrics...');
  const d=await api('/api/metrics');
  state.metricsLastData=d;
  state.metricsLastUpdatedAt=Date.now();
  renderMetrics(d);
}
function formatMs(value){
  return value===null||value===undefined?'-':value+'ms';
}
function metricPercent(value){
  return value===null||value===undefined?'-':value+'%';
}
function metricLabel(name){
  return String(name||'').replace(/(^|-)([a-z])/g,(_m,p,c)=>(p?' ':'')+c.toUpperCase());
}
function metricChip(text,status='ok'){
  return '<span class="chip '+(status==='error'?'error':status==='warn'?'warn':'ok')+'">'+esc(text)+'</span>';
}
function metricCountStatus(value,warnAt=1){
  return Number(value||0)>=warnAt?'warn':'ok';
}
function metricFailureStatus(value){
  return Number(value||0)>0?'error':'ok';
}
function metricHttpStatus(statusCode){
  const code=Number(statusCode||0);
  if(code>=500)return'error';
  if(code>=400)return'warn';
  return'ok';
}
function metricLatencyStatus(ms){
  const value=Number(ms||0);
  if(value>=1000)return'error';
  if(value>=500)return'warn';
  return'ok';
}
function metricLoopStatus(ms){
  const value=Number(ms||0);
  if(value>=100)return'error';
  if(value>=50)return'warn';
  return'ok';
}
function metricCpuStatus(value){
  const pct=Number(value||0);
  if(pct>=80)return'error';
  if(pct>=50)return'warn';
  return'ok';
}
function metricRelativeTimeHtml(value,label='Time'){
  if(!value)return'-';
  return '<span class="metric-age" data-metric-age-at="'+attr(value)+'" title="'+attr(label+': '+fmtDate(value))+'">'+esc(fmtRelativeAgo(value))+'</span>';
}
function metricCell(label,html,cls=''){
  return '<td data-label="'+attr(label)+'"'+(cls?' class="'+cls+'"':'')+'>'+html+'</td>';
}
function metricValueHtml(value,status){
  if(status==='html')return String(value??'-');
  const text=value===null||value===undefined||value===''?'-':String(value);
  return status?metricChip(text,status):'<span class="metric-kv-number">'+esc(text)+'</span>';
}
function metricKvRow(label,value,status=''){
  return '<div class="metric-kv-row"><div class="metric-kv-label">'+esc(label)+'</div><div class="metric-kv-value">'+metricValueHtml(value,status)+'</div></div>';
}
function metricKvCard(title,rows=[]){
  return '<div class="item metrics-card"><strong>'+esc(title)+'</strong><div class="metric-kv">'+rows.map(row=>metricKvRow(row[0],row[1],row[2])).join('')+'</div></div>';
}
function metricKpi(label,value,status='',title=''){
  return '<div class="metric metric-kpi '+(status||'')+'"'+(title?' title="'+attr(title)+'"':'')+'><div class="label">'+esc(label)+'</div><div class="value">'+metricValueHtml(value,status)+'</div></div>';
}
function metricSummaryHtml(d){
  const p=d.process||{};
  const loop=p.eventLoop||{};
  const failed=d.turns?.failed??0;
  return '<div class="metrics-summary">'+
    metricKpi('Queue',String(d.queue?.length??0)+(d.queue?.paused?' paused':' running'),d.queue?.paused?'warn':'ok')+
    metricKpi('Active turns',d.turns?.active??0,metricCountStatus(d.turns?.active??0))+
    metricKpi('Failed turns',failed,metricFailureStatus(failed))+
    metricKpi('Uptime',fmtDuration(p.uptimeMs))+
    metricKpi('Heap used',fmtBytes(p.memory?.heapUsedBytes||0))+
    metricKpi('Event loop p95',formatMs(loop.delayP95Ms),metricLoopStatus(loop.delayP95Ms))+
    '</div>';
}
function metricStatusRows(d){
  return [
    ['Queue',String(d.queue?.length??0)+(d.queue?.paused?' paused':' running'),d.queue?.paused?'warn':'ok'],
    ['Active turns',d.turns?.active??0,metricCountStatus(d.turns?.active??0)],
    ['Completed turns',d.turns?.completed??0],
    ['Failed turns',d.turns?.failed??0,metricFailureStatus(d.turns?.failed??0)],
    ['Aborted turns',d.turns?.aborted??0,Number(d.turns?.aborted??0)>0?'warn':'ok'],
    ['Average turn duration',d.turns?.averageDurationMs===null?'-':fmtDuration(d.turns?.averageDurationMs)]
  ];
}
function metricJobRows(d){
  const jobs=d.jobs||{};
  return [
    ['Total',jobs.total],
    ['Queued',jobs.queued,metricCountStatus(jobs.queued)],
    ['Running',jobs.running,metricCountStatus(jobs.running)],
    ['Completed',jobs.completed],
    ['Failed',jobs.failed,metricFailureStatus(jobs.failed)],
    ['Aborted',jobs.aborted,Number(jobs.aborted||0)>0?'warn':'ok']
  ];
}
function metricProcessRows(d){
  const p=d.process||{};
  const memory=p.memory||{};
  const cpu=p.cpu||{};
  const loop=p.eventLoop||{};
  return [
    ['PID',p.pid],
    ['Node',p.nodeVersion],
    ['Platform',[p.platform,p.arch].filter(Boolean).join(' ')],
    ['Uptime',fmtDuration(p.uptimeMs)],
    ['Started',metricRelativeTimeHtml(p.startedAt,'Started'),'html'],
    ['RSS',fmtBytes(memory.rssBytes||0)],
    ['Heap used',fmtBytes(memory.heapUsedBytes||0)],
    ['Heap total',fmtBytes(memory.heapTotalBytes||0)],
    ['External',fmtBytes(memory.externalBytes||0)],
    ['Array buffers',fmtBytes(memory.arrayBuffersBytes||0)],
    ['CPU user',fmtDuration(cpu.userMs)],
    ['CPU system',fmtDuration(cpu.systemMs)],
    ['CPU total',fmtDuration(cpu.totalMs)],
    ['CPU avg',metricPercent(cpu.percentSinceStart),metricCpuStatus(cpu.percentSinceStart)],
    ['Event loop mean',formatMs(loop.delayMeanMs),metricLoopStatus(loop.delayMeanMs)],
    ['Event loop p95',formatMs(loop.delayP95Ms),metricLoopStatus(loop.delayP95Ms)],
    ['Event loop max',formatMs(loop.delayMaxMs),metricLoopStatus(loop.delayMaxMs)]
  ];
}
function metricWebRouteRow(route){
  const routeText=route.method+' '+route.path;
  return '<tr>'+
    metricCell('Route','<span class="truncate-cell" title="'+attr(routeText)+'">'+esc(short(routeText,140))+'</span>','primary-cell')+
    metricCell('Avg',metricValueHtml(formatMs(route.averageMs),metricLatencyStatus(route.averageMs)),'number-cell')+
    metricCell('Max',metricValueHtml(formatMs(route.maxMs),metricLatencyStatus(route.maxMs)),'number-cell')+
    metricCell('Last',metricValueHtml(formatMs(route.lastMs),metricLatencyStatus(route.lastMs)),'number-cell')+
    metricCell('Hits','<span class="metric-kv-number">'+esc(route.count??0)+'</span>','number-cell')+
    metricCell('Status',metricChip(route.lastStatusCode??'-',metricHttpStatus(route.lastStatusCode)),'status-cell')+
    metricCell('Last seen',metricRelativeTimeHtml(route.lastAt,'Last seen'),'updated-cell')+
    '</tr>';
}
function metricWebRoutesTable(routes){
  const rows=(routes||[]).slice(0,25);
  if(!rows.length)return uiEmpty('No Web API route metrics yet.');
  return '<div class="data-table-wrap"><table class="data-table metrics-table metrics-web-routes"><thead><tr><th>Route</th><th>Avg</th><th>Max</th><th>Last</th><th>Hits</th><th>Status</th><th>Last seen</th></tr></thead><tbody>'+rows.map(metricWebRouteRow).join('')+'</tbody></table></div>';
}
function metricSlowWebRow(sample){
  const routeText=sample.method+' '+sample.path;
  return '<tr>'+
    metricCell('Route','<span class="truncate-cell" title="'+attr(routeText)+'">'+esc(short(routeText,160))+'</span>','primary-cell')+
    metricCell('Duration',metricValueHtml(formatMs(sample.durationMs),metricLatencyStatus(sample.durationMs)),'number-cell')+
    metricCell('Status',metricChip(sample.statusCode??'-',metricHttpStatus(sample.statusCode)),'status-cell')+
    metricCell('Time',metricRelativeTimeHtml(sample.at,'Time'),'updated-cell')+
    '</tr>';
}
function metricSlowWebTable(samples){
  const rows=(samples||[]).slice(0,10);
  if(!rows.length)return uiEmpty('No slow Web API calls recorded.');
  return '<div class="data-table-wrap"><table class="data-table metrics-table metrics-web-slow"><thead><tr><th>Route</th><th>Duration</th><th>Status</th><th>Time</th></tr></thead><tbody>'+rows.map(metricSlowWebRow).join('')+'</tbody></table></div>';
}
function metricRateRow(entry){
  const name=entry[0];
  const rate=entry[1]||{};
  return '<tr>'+
    metricCell('Adapter',esc(metricLabel(name)),'primary-cell')+
    metricCell('Queued',metricValueHtml(rate.queued??0,metricCountStatus(rate.queued??0)),'number-cell')+
    metricCell('Running',metricValueHtml(rate.running??0,metricCountStatus(rate.running??0)),'number-cell')+
    metricCell('Completed','<span class="metric-kv-number">'+esc(rate.completed??0)+'</span>','number-cell')+
    metricCell('Failed',metricValueHtml(rate.failed??0,metricFailureStatus(rate.failed??0)),'number-cell')+
    metricCell('Retries',metricValueHtml(rate.retries??0,metricCountStatus(rate.retries??0)),'number-cell')+
    metricCell('Rate-limit hits',metricValueHtml(rate.rateLimitHits??0,metricCountStatus(rate.rateLimitHits??0)),'number-cell')+
    metricCell('Retry after','<span class="metric-kv-number">'+esc(rate.lastRetryAfterSeconds?rate.lastRetryAfterSeconds+'s':'-')+'</span>','number-cell')+
    metricCell('Last limit',metricRelativeTimeHtml(rate.lastRateLimitAt,'Last rate limit'),'updated-cell')+
    metricCell('Buckets','<span class="metric-kv-number">'+esc((rate.buckets||[]).length)+'</span>','number-cell')+
    '</tr>';
}
function metricRateLimitTable(adapters){
  const rows=Object.entries(adapters||{});
  if(!rows.length)return uiEmpty('No rate-limit metrics.');
  return '<div class="data-table-wrap"><table class="data-table metrics-table metrics-rate-table"><thead><tr><th>Adapter</th><th>Queued</th><th>Running</th><th>Completed</th><th>Failed</th><th>Retries</th><th>Rate-limit hits</th><th>Retry after</th><th>Last limit</th><th>Buckets</th></tr></thead><tbody>'+rows.map(metricRateRow).join('')+'</tbody></table></div>';
}
function metricsTabPanel(id,html){
  return '<div class="metrics-tab '+(state.metricsTab===id?'active':'')+'" data-metrics-tab-panel="'+attr(id)+'">'+html+'</div>';
}
function renderMetrics(d){
  bindMetricsTabs();
  bindMetricsToolbar();
  document.getElementById('metricsPanel').innerHTML=
    metricSummaryHtml(d)+
    metricsTabPanel('overview','<div class="metrics-grid">'+metricKvCard('Runtime',metricStatusRows(d))+metricKvCard('Jobs',metricJobRows(d))+'</div>')+
    metricsTabPanel('process','<div class="metrics-grid">'+metricKvCard('Process',metricProcessRows(d))+'</div>')+
    metricsTabPanel('web','<h2 class="task-section-title">Web API latency</h2>'+metricWebRoutesTable(d.web?.routes||[])+'<h2 class="task-section-title">Slow Web API calls</h2>'+metricSlowWebTable(d.web?.slowest||[]))+
    metricsTabPanel('rate','<h2 class="task-section-title">Rate limits</h2>'+metricRateLimitTable(d.adapters||{}));
  switchMetricsTab(state.metricsTab||'overview');
  updateMetricsToolbar();
  startMetricAgeCounter();
}
function switchMetricsTab(tab){
  state.metricsTab=tab||'overview';
  document.querySelectorAll('[data-metrics-tab]').forEach(b=>{const active=b.dataset.metricsTab===state.metricsTab;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');b.tabIndex=active?0:-1});
  document.querySelectorAll('[data-metrics-tab-panel]').forEach(panel=>panel.classList.toggle('active',panel.dataset.metricsTabPanel===state.metricsTab));
}
function bindMetricsTabs(){
  document.querySelectorAll('[data-metrics-tab]').forEach(b=>{if(b.dataset.bound)return;b.dataset.bound='true';b.onclick=()=>switchMetricsTab(b.dataset.metricsTab)});
}
function bindMetricsToolbar(){
  const reload=document.getElementById('reloadMetricsBtn');
  if(reload&&!reload.dataset.bound){reload.dataset.bound='true';reload.onclick=()=>safe(loadMetrics)}
  const auto=document.getElementById('metricsAutoRefresh');
  if(auto){
    auto.checked=Boolean(state.metricsAutoRefresh);
    if(!auto.dataset.bound){auto.dataset.bound='true';auto.onchange=()=>setMetricsAutoRefresh(auto.checked)}
  }
  ensureMetricsAutoRefresh();
}
function setMetricsAutoRefresh(enabled){
  state.metricsAutoRefresh=Boolean(enabled);
  localStorage.setItem('nordrelayMetricsAutoRefresh',state.metricsAutoRefresh?'true':'false');
  updateMetricsToolbar();
  ensureMetricsAutoRefresh();
}
function ensureMetricsAutoRefresh(){
  if(state.metricsAutoRefresh&&!metricsAutoRefreshTimer){
    metricsAutoRefreshTimer=setInterval(()=>{if(state.currentPage==='metrics')safe(()=>loadMetrics({silent:true}))},5000);
  }
  if(!state.metricsAutoRefresh&&metricsAutoRefreshTimer){
    clearInterval(metricsAutoRefreshTimer);
    metricsAutoRefreshTimer=null;
  }
}
function updateMetricsToolbar(){
  const auto=document.getElementById('metricsAutoRefresh');
  if(auto)auto.checked=Boolean(state.metricsAutoRefresh);
  updateMetricAgeCounters();
}
function updateMetricAgeCounters(){
  document.querySelectorAll('[data-metric-age-at]').forEach(el=>{el.textContent=fmtRelativeAgo(el.dataset.metricAgeAt)});
  const label=document.getElementById('metricsLastUpdated');
  if(label){
    label.textContent=state.metricsLastUpdatedAt?'Last updated '+fmtAge(Date.now()-state.metricsLastUpdatedAt):'Last updated -';
    if(state.metricsLastData?.generatedAt)label.title='Generated: '+fmtDate(state.metricsLastData.generatedAt);
  }
}
function startMetricAgeCounter(){
  updateMetricAgeCounters();
  if(metricsAgeTimer)return;
  metricsAgeTimer=setInterval(()=>{if(state.currentPage!=='metrics'){clearInterval(metricsAgeTimer);metricsAgeTimer=null;return}updateMetricAgeCounters()},1000);
}
bindMetricsToolbar();
