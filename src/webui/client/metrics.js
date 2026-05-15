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
function renderMetrics(d){
  const adapters=d.adapters||{};
  document.getElementById('metricsPanel').innerHTML='<div class="metrics-grid">'+
    card('Runtime',metricStatusRows(d))+
    card('Jobs',metricJobRows(d))+
    card('Telegram rate limits',rateRows('',adapters.telegram).map(([k,v])=>[String(k).trim(),v]))+
    card('Discord rate limits',rateRows('',adapters.discord).map(([k,v])=>[String(k).trim(),v]))+
    '</div>';
}
document.getElementById('reloadMetricsBtn').onclick=()=>safe(loadMetrics);
