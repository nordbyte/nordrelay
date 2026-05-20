async function loadDiagnostics() {
  bindDiagnosticsTabs();
  switchDiagnosticsTab(state.diagnosticsTab || 'overview');
  setLoading('diagnostics', 'Loading diagnostics...');
  const [data, doctor] = await Promise.all([
    api('/api/diagnostics'),
    can('diagnostics.read') ? api('/api/doctor').catch(error => ({ error: error.message || String(error) })) : Promise.resolve(null),
  ]);
  document.getElementById('diagnostics').innerHTML = diagnosticsHtml(data, doctor);
  switchDiagnosticsTab(state.diagnosticsTab || 'overview');
  bindDoctorButtons();
  applyPermissions();
}

const exportDiagnosticsBundleBtn = document.getElementById('exportDiagnosticsBundleBtn');
if (exportDiagnosticsBundleBtn) exportDiagnosticsBundleBtn.onclick = () => safe(async () => {
  if (!can('diagnostics.read')) { toast('Permission required: diagnostics.read'); return; }
  if (!state.selectedPeer || state.selectedPeer === 'local') {
    window.open('/api/diagnostics/bundle', '_blank');
    return;
  }
  const bundle = await api('/api/diagnostics/bundle');
  downloadBase64(bundle.name || 'nordrelay-support-bundle.zip', bundle.dataBase64 || '', bundle.mimeType || 'application/zip');
  toast('Remote diagnostics bundle downloaded');
});

function diagnosticsStatus(value: any) {
  const text = String(value || '').toLowerCase();
  if (['ready', 'healthy', 'ok', 'current', 'enabled', 'running', 'listening'].includes(text)) return 'ok';
  if (['failed', 'error', 'stopped', 'disabled'].includes(text)) return 'error';
  if (['paused', 'warn', 'warning', 'planned', 'not collected', 'not listening'].includes(text)) return 'warn';
  return '';
}

function diagnosticsText(value: any) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function diagnosticsVersionValue(v: any) {
  return uiBadge(versionStatusLabel(v.status), versionStatusClass(v.status)) + ' <span class="diagnostics-inline-value">' + esc((v.installedLabel || '-') + ' / latest ' + (v.latestVersion || '-')) + '</span>';
}

function diagnosticsOverviewRows(d: any, h: any, s: any) {
  const warnings = h.state?.adapterWarnings || [];
  const mirror = d.runtime?.externalMirror;
  const slack = d.runtime?.slackDiagnostics;
  const matrix = d.runtime?.matrixDiagnostics;
  const voice = d.runtime?.voiceDiagnostics;
  const voiceBackends = voice?.availableBackends?.length ? voice.availableBackends.join(' + ') : 'none';
  return [['Health', h.state?.status, diagnosticsStatus(h.state?.status)], ['Queue', d.runtime?.queuePaused ? 'paused' : 'running', d.runtime?.queuePaused ? 'warn' : 'ok'], ['Runtime warnings', warnings.join(' | ') || 'none', warnings.length ? 'warn' : 'ok'], ['Agent', s.agentLabel || s.agentId || '-'], ['Thread', s.threadId], ['Workspace', s.workspace], ['Mirror', mirror ? 'active' : 'idle', mirror ? 'ok' : ''], ['Voice', voiceBackends, voice?.availableBackends?.length ? 'ok' : 'warn'], ['Slack', slack ? (slack.enabled ? 'enabled' : 'disabled') : 'not collected', slack ? (slack.enabled ? 'ok' : 'warn') : 'warn'], ['Matrix', matrix ? (matrix.enabled ? 'enabled' : 'disabled') : 'not collected', matrix ? (matrix.enabled ? 'ok' : 'warn') : 'warn']];
}

function diagnosticsRuntimeRows(d: any, h: any) {
  return [['Status', h.state?.status, diagnosticsStatus(h.state?.status)], ['PID', h.state?.pid], ['App PID', h.state?.appPid], ['State file', h.stateFile], ['Log file', h.logFile], ['State backend', d.runtime?.stateBackend], ['Source workspace', d.runtime?.sourceWorkspace], ['Runtime warnings', (h.state?.adapterWarnings || []).join(' | ') || '-', (h.state?.adapterWarnings || []).length ? 'warn' : 'ok'], ['Queue', d.runtime?.queuePaused ? 'paused' : 'running', d.runtime?.queuePaused ? 'warn' : 'ok'], ['Uptime', h.uptimeSeconds !== undefined ? h.uptimeSeconds + 's' : '-']];
}

function diagnosticsAgentRows(s: any) {
  const caps = s.capabilities || {};
  return [['Agent', s.agentLabel], ['Thread', s.threadId], ['Workspace', s.workspace], ['Model', s.model], ['Reasoning', s.reasoningEffort], ['Fast', caps.fastMode ? (s.fastMode ? 'on' : 'off') : 'n/a']];
}

function diagnosticsAgentStateRows(agentDiag: any) {
  const lines = agentDiag?.lines || [];
  return lines.length ? lines.map((x: any) => [x.label, diagnosticsText(x.value)]) : [['Status', 'not collected', 'warn']];
}

function diagnosticsVersionRows(vc: any) {
  const values: any[] = Object.values(vc || {});
  return values.length ? values.map(v => [v.label, diagnosticsVersionValue(v), 'html']) : [['Status', 'not collected', 'warn']];
}

function diagnosticsMirrorRows(mirror: any) {
  if (!mirror) return [['Status', 'idle', 'ok']];
  return Object.entries(mirror).map(([key, value]) => [key, diagnosticsText(value)]);
}

function diagnosticsSlackRows(slack: any) {
  if (!slack) return [['Status', 'not collected', 'warn']];
  return [['Enabled', slack.enabled ? 'yes' : 'no', slack.enabled ? 'ok' : 'warn'], ['Mode', slack.mode], ['Registered channels', slack.registeredChannels]].concat((slack.checks || []).map((x: any) => [x.label, diagnosticsText(x.detail), diagnosticsStatus(x.status)]), (slack.channelChecks || []).map((x: any) => ['Channel ' + x.channelId, diagnosticsText(x.detail), diagnosticsStatus(x.status)]));
}

function diagnosticsMatrixRows(matrix: any) {
  if (!matrix) return [['Status', 'not collected', 'warn']];
  const rate = matrix.rateLimit;
  const rows = [
    ['Enabled', matrix.enabled ? 'yes' : 'no', matrix.enabled ? 'ok' : 'warn'],
    ['Configured', matrix.configured ? 'yes' : 'no', matrix.configured ? 'ok' : 'warn'],
    ['Registered rooms', matrix.registeredRooms],
  ];
  if (matrix.auth) {
    rows.push(['Whoami', matrix.auth.detail, matrix.auth.ok ? 'ok' : 'error']);
  }
  if (rate) {
    rows.push(['Rate limit queued/running/retries/429', [rate.queued, rate.running, rate.retries, rate.rateLimitHits].join(' / ')]);
  }
  return rows.concat((matrix.checks || []).map((x: any) => [x.label, diagnosticsText(x.detail), diagnosticsStatus(x.status)]), (matrix.roomChecks || []).map((x: any) => ['Room ' + x.roomId, diagnosticsText(x.detail), diagnosticsStatus(x.status)]));
}

function diagnosticsChannelsHtml(d: any) {
  return '<div class="metrics-grid diagnostics-grid">' +
    metricKvCard('Slack Readiness', diagnosticsSlackRows(d.runtime?.slackDiagnostics)) +
    metricKvCard('Matrix Readiness', diagnosticsMatrixRows(d.runtime?.matrixDiagnostics)) +
    '</div>';
}

function diagnosticsVoiceStatus(status: any) {
  if (status === 'available' || status === 'configured') return 'ok';
  if (status === 'error') return 'error';
  if (status === 'missing' || status === 'unconfigured') return 'warn';
  return '';
}

function diagnosticsChip(text: string, status = 'ok') {
  return '<span class="chip ' + (status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'ok') + '">' + esc(text) + '</span>';
}

function diagnosticsChipList(values: any[], status = 'ok') {
  const list = (values || []).filter(Boolean);
  return list.length ? '<span class="diagnostics-chip-list">' + list.map(value => diagnosticsChip(value, status)).join('') + '</span>' : '<span class="metric-kv-number">none</span>';
}

function diagnosticsVoiceBackendValue(backend: any) {
  const status = backend.status || 'unknown';
  const parts = [];
  if (backend.version) parts.push(backend.version);
  if (backend.path) parts.push('path ' + backend.path);
  if (backend.detail) parts.push(backend.detail);
  const detail = parts.filter(Boolean).join(' · ');
  return '<span class="diagnostics-value-stack">' + diagnosticsChip(status, diagnosticsVoiceStatus(status)) + (detail ? '<span class="diagnostics-value-detail">' + esc(detail) + '</span>' : '') + '</span>';
}

function diagnosticsVoiceRows(voice: any) {
  if (!voice) return [['Status', 'not collected', 'warn']];
  const available = voice.availableBackends || [];
  const rows = [['Preferred backend', voice.preferredBackend || 'auto'], ['Default language', voice.defaultLanguage || 'auto'], ['Transcribe only', voice.transcribeOnly ? 'on' : 'off'], ['Available backends', diagnosticsChipList(available, available.length ? 'ok' : 'warn'), 'html']];
  return rows.concat((voice.backends || []).map((backend: any) => [backend.label || backend.id, diagnosticsVoiceBackendValue(backend), 'html']));
}

function diagnosticsTabPanel(id: string, html: string) {
  return '<div class="diagnostics-tab ' + (state.diagnosticsTab === id ? 'active' : '') + '" data-diagnostics-tab-panel="' + attr(id) + '">' + html + '</div>';
}

function diagnosticsPanelGrid(title: string, rows: any[]) {
  return '<div class="metrics-grid diagnostics-grid diagnostics-single-grid">' + metricKvCard(title, rows) + '</div>';
}

function doctorStatusBadge(item: any) {
  if (item.ok) return uiBadge('pass', 'enabled');
  return uiBadge(item.status === 'fail' ? 'fail' : 'warn', item.status === 'fail' ? 'disabled' : 'planned');
}

function doctorFixButton(item: any) {
  if (!item.fix?.safe || item.ok) return '-';
  return '<div class="data-table-actions">' + uiButton(item.fix.label || 'Apply fix', { variant: 'secondary', mini: true, data: { doctorFix: item.fix.id }, disabled: !can('settings.write'), title: item.fix.summary || '' }) + '</div>';
}

function doctorRow(item: any) {
  return '<tr><td data-label="Check" class="primary-cell"><span class="truncate-cell" title="' + attr(item.name || item.id) + '">' + esc(item.name || item.id) + '</span></td><td data-label="Status" class="status-cell">' + doctorStatusBadge(item) + '</td><td data-label="Detail"><span class="truncate-cell" title="' + attr(item.detail || '') + '">' + esc(short(item.detail || '-', 220)) + '</span></td><td data-label="Fix" class="actions-cell">' + doctorFixButton(item) + '</td></tr>';
}

function diagnosticsDoctorPanel(report: any) {
  if (!report) return diagnosticsPanelGrid('Doctor', [['Status', 'not collected', 'warn']]);
  if (report.error) return '<div class="metrics-grid diagnostics-grid diagnostics-single-grid">' + metricKvCard('Doctor', [['Error', report.error, 'error']]) + '</div>';
  const summary = report.summary || {};
  const header = '<div class="doctor-summary item"><strong>Setup doctor ' + uiBadge((summary.failed || 0) + ' failed', summary.failed ? 'disabled' : 'enabled') + ' ' + uiBadge((summary.warnings || 0) + ' warnings', summary.warnings ? 'planned' : 'enabled') + '</strong><small>' + esc('Env: ' + (report.envPath || '-') + ' | Home: ' + (report.home || '-')) + '</small><div class="row"><button type="button" class="secondary" data-doctor-reload>Reload doctor</button><button type="button" data-doctor-fix-all' + disabledAttr('settings.write') + '>Apply safe fixes</button></div></div>';
  const rows = report.checks || [];
  const table = rows.length ? '<div class="data-table-wrap"><table class="data-table diagnostics-doctor-table"><thead><tr><th>Check</th><th>Status</th><th>Detail</th><th class="actions-heading">Fix</th></tr></thead><tbody>' + rows.map(doctorRow).join('') + '</tbody></table></div>' : uiEmpty('No doctor checks.');
  return diagnosticsTabPanel('doctor', header + table);
}

function diagnosticsHtml(d: any, doctor: any = null) {
  const h = d.health || {};
  const s = d.snapshot?.session || {};
  return diagnosticsTabPanel('overview', '<div class="metrics-grid diagnostics-grid diagnostics-overview-grid">' + metricKvCard('Overview', diagnosticsOverviewRows(d, h, s)) + metricKvCard('Runtime', diagnosticsRuntimeRows(d, h)) + '</div>') + diagnosticsTabPanel('runtime', diagnosticsPanelGrid('Runtime', diagnosticsRuntimeRows(d, h))) + diagnosticsTabPanel('agent', diagnosticsPanelGrid('Agent', diagnosticsAgentRows(s))) + diagnosticsTabPanel('state', diagnosticsPanelGrid('Agent State', diagnosticsAgentStateRows(d.runtime?.agentDiagnostics))) + diagnosticsTabPanel('versions', diagnosticsPanelGrid('CLI Versions', diagnosticsVersionRows(d.versionChecks || {}))) + diagnosticsTabPanel('channels', diagnosticsChannelsHtml(d)) + diagnosticsTabPanel('voice', diagnosticsPanelGrid('Voice Backends', diagnosticsVoiceRows(d.runtime?.voiceDiagnostics))) + diagnosticsTabPanel('mirror', diagnosticsPanelGrid('External Mirror', diagnosticsMirrorRows(d.runtime?.externalMirror))) + diagnosticsDoctorPanel(doctor);
}

function switchDiagnosticsTab(tab: string) {
  state.diagnosticsTab = tab || 'overview';
  document.querySelectorAll('[data-diagnostics-tab]').forEach(b => {
    const active = b.dataset.diagnosticsTab === state.diagnosticsTab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
    b.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-diagnostics-tab-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.diagnosticsTabPanel === state.diagnosticsTab));
}

function bindDiagnosticsTabs() {
  document.querySelectorAll('[data-diagnostics-tab]').forEach(b => {
    if (b.dataset.bound) return;
    b.dataset.bound = 'true';
    b.onclick = () => switchDiagnosticsTab(b.dataset.diagnosticsTab);
  });
}

function bindDoctorButtons() {
  document.querySelectorAll('[data-doctor-reload]').forEach(b => b.onclick = () => safe(loadDiagnostics));
  document.querySelectorAll('[data-doctor-fix]').forEach(b => b.onclick = () => safe(async () => {
    if (!can('settings.write')) { toast('Permission required: settings.write'); return; }
    const result = await api('/api/doctor/fix', { method: 'POST', body: JSON.stringify({ fixIds: [b.dataset.doctorFix] }) });
    toast((result.results || []).map(r => (r.ok ? 'Fixed: ' : 'Fix failed: ') + r.message).join('\n') || 'No safe fix applied', { duration: 7000 });
    await loadDiagnostics();
  }));
  document.querySelectorAll('[data-doctor-fix-all]').forEach(b => b.onclick = () => safe(async () => {
    if (!can('settings.write')) { toast('Permission required: settings.write'); return; }
    const result = await api('/api/doctor/fix', { method: 'POST', body: JSON.stringify({}) });
    toast((result.results || []).map(r => (r.ok ? 'Fixed: ' : 'Fix failed: ') + r.message).join('\n') || 'No safe fixes available', { duration: 9000 });
    await loadDiagnostics();
  }));
}
