async function loadMetrics(){
  setLoading('metricsPanel','Loading metrics...');
  const d=await api('/api/metrics');
  renderMetrics(d);
}
function metricStatusRows(d){
  return [
    ['Generated',fmtDate(d.generatedAt)],
    ['Queue',String(d.queue?.length??0)+(d.queue?.paused?' paused':' running')],
    ['Active turns',String(d.turns?.active??0)],
    ['Completed turns',String(d.turns?.completed??0)],
    ['Failed turns',String(d.turns?.failed??0)],
    ['Aborted turns',String(d.turns?.aborted??0)],
    ['Average turn duration',d.turns?.averageDurationMs===null?'-':fmtDuration(d.turns?.averageDurationMs)]
  ];
}
function metricJobRows(d){
  const jobs=d.jobs||{};
  return [
    ['Total',jobs.total],
    ['Queued',jobs.queued],
    ['Running',jobs.running],
    ['Completed',jobs.completed],
    ['Failed',jobs.failed],
    ['Aborted',jobs.aborted]
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
    ['Started',fmtDate(p.startedAt)],
    ['RSS',fmtBytes(memory.rssBytes||0)],
    ['Heap used',fmtBytes(memory.heapUsedBytes||0)],
    ['Heap total',fmtBytes(memory.heapTotalBytes||0)],
    ['CPU total',fmtDuration(cpu.totalMs)],
    ['CPU avg',cpu.percentSinceStart===null||cpu.percentSinceStart===undefined?'-':cpu.percentSinceStart+'%'],
    ['Event loop p95',formatMs(loop.delayP95Ms)],
    ['Event loop max',formatMs(loop.delayMaxMs)]
  ];
}
function formatMs(value){
  return value===null||value===undefined?'-':value+'ms';
}
function rateRows(name,rate){
  return [
    ['Queued',rate?.queued??0],
    ['Running',rate?.running??0],
    ['Completed',rate?.completed??0],
    ['Failed',rate?.failed??0],
    ['Retries',rate?.retries??0],
    ['Rate-limit hits',rate?.rateLimitHits??0],
    ['Last rate limit',fmtDate(rate?.lastRateLimitAt)],
    ['Retry after',rate?.lastRetryAfterSeconds?rate.lastRetryAfterSeconds+'s':'-'],
    ['Buckets',(rate?.buckets||[]).length]
  ].map(([k,v])=>[name+' '+k,v]);
}
function webRouteRows(d){
  return (d.web?.routes||[]).slice(0,8).map(route=>[route.method+' '+route.path,route.averageMs+'ms avg / '+route.maxMs+'ms max / '+route.count+' hit(s)']);
}
function webSlowRows(d){
  return (d.web?.slowest||[]).slice(0,8).map(sample=>[sample.method+' '+sample.path,sample.durationMs+'ms / '+sample.statusCode+' / '+fmtDate(sample.at)]);
}
function renderMetrics(d){
  const adapters=d.adapters||{};
  const adapterCards=Object.entries(adapters).map(([name,rate])=>card(name.charAt(0).toUpperCase()+name.slice(1)+' rate limits',rateRows('',rate).map(([k,v])=>[String(k).trim(),v]))).join('');
  document.getElementById('metricsPanel').innerHTML='<div class="metrics-grid">'+
    card('Runtime',metricStatusRows(d))+
    card('Process',metricProcessRows(d))+
    card('Jobs',metricJobRows(d))+
    card('Web API latency',webRouteRows(d))+
    card('Slow Web API calls',webSlowRows(d))+
    adapterCards+
    '</div>';
}
document.getElementById('reloadMetricsBtn').onclick=()=>safe(loadMetrics);
