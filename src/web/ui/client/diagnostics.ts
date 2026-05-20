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

type DiagnosticsRow = [string, unknown, string?];
type DiagnosticsRecord = Record<string, unknown>;

function asRecord(value: unknown): DiagnosticsRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DiagnosticsRecord : {};
}

function diagnosticsStatus(value: unknown) {
  const text = String(value || '').toLowerCase();
  if (['ready', 'healthy', 'ok', 'current', 'enabled', 'running', 'listening'].includes(text)) return 'ok';
  if (['failed', 'error', 'stopped', 'disabled'].includes(text)) return 'error';
  if (['paused', 'warn', 'warning', 'planned', 'not collected', 'not listening'].includes(text)) return 'warn';
  return '';
}

function diagnosticsText(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function diagnosticsVersionValue(v: DiagnosticsRecord) {
  const status = String(v.status ?? '');
  return uiBadge(versionStatusLabel(status), versionStatusClass(status)) + ' <span class="diagnostics-inline-value">' + esc((v.installedLabel || '-') + ' / latest ' + (v.latestVersion || '-')) + '</span>';
}

function diagnosticsOverviewRows(d: DiagnosticsRecord, h: DiagnosticsRecord, s: DiagnosticsRecord): DiagnosticsRow[] {
  const healthState = asRecord(h.state);
  const runtime = asRecord(d.runtime);
  const warnings = Array.isArray(healthState.adapterWarnings) ? healthState.adapterWarnings : [];
  const mirror = runtime.externalMirror;
  const slack = asRecord(runtime.slackDiagnostics);
  const matrix = asRecord(runtime.matrixDiagnostics);
  const voice = asRecord(runtime.voiceDiagnostics);
  const availableVoiceBackends = Array.isArray(voice.availableBackends) ? voice.availableBackends : [];
  const voiceBackends = availableVoiceBackends.length ? availableVoiceBackends.join(' + ') : 'none';
  return [['Health', healthState.status, diagnosticsStatus(healthState.status)], ['Queue', runtime.queuePaused ? 'paused' : 'running', runtime.queuePaused ? 'warn' : 'ok'], ['Runtime warnings', warnings.join(' | ') || 'none', warnings.length ? 'warn' : 'ok'], ['Agent', s.agentLabel || s.agentId || '-'], ['Thread', s.threadId], ['Workspace', s.workspace], ['Mirror', mirror ? 'active' : 'idle', mirror ? 'ok' : ''], ['Voice', voiceBackends, availableVoiceBackends.length ? 'ok' : 'warn'], ['Slack', slack.enabled ? 'enabled' : 'disabled', slack.enabled ? 'ok' : 'warn'], ['Matrix', matrix.enabled ? 'enabled' : 'disabled', matrix.enabled ? 'ok' : 'warn']];
}

function diagnosticsRuntimeRows(d: DiagnosticsRecord, h: DiagnosticsRecord): DiagnosticsRow[] {
  const healthState = asRecord(h.state);
  const runtime = asRecord(d.runtime);
  const warnings = Array.isArray(healthState.adapterWarnings) ? healthState.adapterWarnings : [];
  return [['Status', healthState.status, diagnosticsStatus(healthState.status)], ['PID', healthState.pid], ['App PID', healthState.appPid], ['State file', h.stateFile], ['Log file', h.logFile], ['State backend', runtime.stateBackend], ['Source workspace', runtime.sourceWorkspace], ['Runtime warnings', warnings.join(' | ') || '-', warnings.length ? 'warn' : 'ok'], ['Queue', runtime.queuePaused ? 'paused' : 'running', runtime.queuePaused ? 'warn' : 'ok'], ['Uptime', h.uptimeSeconds !== undefined ? h.uptimeSeconds + 's' : '-']];
}

function diagnosticsAgentRows(s: DiagnosticsRecord): DiagnosticsRow[] {
  const caps = asRecord(s.capabilities);
  return [['Agent', s.agentLabel], ['Thread', s.threadId], ['Workspace', s.workspace], ['Model', s.model], ['Reasoning', s.reasoningEffort], ['Fast', caps.fastMode ? (s.fastMode ? 'on' : 'off') : 'n/a']];
}

function diagnosticsAgentStateRows(agentDiag: unknown): DiagnosticsRow[] {
  const lines = Array.isArray(asRecord(agentDiag).lines) ? asRecord(agentDiag).lines as DiagnosticsRecord[] : [];
  return lines.length ? lines.map((x) => [String(x.label ?? '-'), diagnosticsText(x.value)]) : [['Status', 'not collected', 'warn']];
}

function diagnosticsVersionRows(vc: unknown): DiagnosticsRow[] {
  const values = Object.values(asRecord(vc)).map(asRecord);
  return values.length ? values.map(v => [String(v.label ?? '-'), diagnosticsVersionValue(v), 'html']) : [['Status', 'not collected', 'warn']];
}

function diagnosticsMirrorRows(mirror: unknown): DiagnosticsRow[] {
  if (!mirror) return [['Status', 'idle', 'ok']];
  return Object.entries(asRecord(mirror)).map(([key, value]) => [key, diagnosticsText(value)]);
}

function diagnosticsSlackRows(slack: unknown): DiagnosticsRow[] {
  if (!slack) return [['Status', 'not collected', 'warn']];
  const record = asRecord(slack);
  const checks = Array.isArray(record.checks) ? record.checks.map(asRecord) : [];
  const channelChecks = Array.isArray(record.channelChecks) ? record.channelChecks.map(asRecord) : [];
  const rows: DiagnosticsRow[] = [['Enabled', record.enabled ? 'yes' : 'no', record.enabled ? 'ok' : 'warn'], ['Mode', record.mode], ['Registered channels', record.registeredChannels]];
  return rows.concat(checks.map((x): DiagnosticsRow => [String(x.label ?? '-'), diagnosticsText(x.detail), diagnosticsStatus(x.status)]), channelChecks.map((x): DiagnosticsRow => ['Channel ' + x.channelId, diagnosticsText(x.detail), diagnosticsStatus(x.status)]));
}

function diagnosticsMatrixRows(matrix: unknown): DiagnosticsRow[] {
  if (!matrix) return [['Status', 'not collected', 'warn']];
  const record = asRecord(matrix);
  const rate = asRecord(record.rateLimit);
  const rows: DiagnosticsRow[] = [
    ['Enabled', record.enabled ? 'yes' : 'no', record.enabled ? 'ok' : 'warn'],
    ['Configured', record.configured ? 'yes' : 'no', record.configured ? 'ok' : 'warn'],
    ['Registered rooms', record.registeredRooms],
  ];
  if (record.auth) {
    const auth = asRecord(record.auth);
    rows.push(['Whoami', auth.detail, auth.ok ? 'ok' : 'error']);
  }
  if (Object.keys(rate).length) {
    rows.push(['Rate limit queued/running/retries/429', [rate.queued, rate.running, rate.retries, rate.rateLimitHits].join(' / ')]);
  }
  const checks = Array.isArray(record.checks) ? record.checks.map(asRecord) : [];
  const roomChecks = Array.isArray(record.roomChecks) ? record.roomChecks.map(asRecord) : [];
  return rows.concat(checks.map((x) => [String(x.label ?? '-'), diagnosticsText(x.detail), diagnosticsStatus(x.status)]), roomChecks.map((x) => ['Room ' + x.roomId, diagnosticsText(x.detail), diagnosticsStatus(x.status)]));
}

function diagnosticsChannelsHtml(d: DiagnosticsRecord) {
  const runtime = asRecord(d.runtime);
  return '<div class="metrics-grid diagnostics-grid">' +
    metricKvCard('Slack Readiness', diagnosticsSlackRows(runtime.slackDiagnostics)) +
    metricKvCard('Matrix Readiness', diagnosticsMatrixRows(runtime.matrixDiagnostics)) +
    '</div>';
}

function diagnosticsVoiceStatus(status: unknown) {
  if (status === 'available' || status === 'configured') return 'ok';
  if (status === 'error') return 'error';
  if (status === 'missing' || status === 'unconfigured' || status === 'not_collected') return 'warn';
  return '';
}

function diagnosticsChip(text: string, status = 'ok') {
  return '<span class="chip ' + (status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'ok') + '">' + esc(text) + '</span>';
}

function diagnosticsChipList(values: unknown[], status = 'ok') {
  const list = (values || []).filter(Boolean);
  return list.length ? '<span class="diagnostics-chip-list">' + list.map(value => diagnosticsChip(String(value), status)).join('') + '</span>' : '<span class="metric-kv-number">none</span>';
}

function diagnosticsVoiceBackendValue(backend: DiagnosticsRecord) {
  const status = backend.status || 'unknown';
  const parts = [];
  if (backend.version) parts.push(backend.version);
  if (backend.path) parts.push('path ' + backend.path);
  if (backend.detail) parts.push(backend.detail);
  const detail = parts.filter(Boolean).join(' · ');
  return '<span class="diagnostics-value-stack">' + diagnosticsChip(String(status), diagnosticsVoiceStatus(status)) + (detail ? '<span class="diagnostics-value-detail">' + esc(detail) + '</span>' : '') + '</span>';
}

function diagnosticsVoiceRows(voice: unknown): DiagnosticsRow[] {
  if (!voice) return [['Status', 'not collected', 'warn']];
  const record = asRecord(voice);
  const available = Array.isArray(record.availableBackends) ? record.availableBackends : [];
  const refreshed = record.refreshedAt ? fmtDate(record.refreshedAt) : '-';
  const mode = record.heavyChecks ? (record.stale ? 'cached/stale' : 'checked') : 'light';
  const rows: DiagnosticsRow[] = [['Preferred backend', record.preferredBackend || 'auto'], ['Default language', record.defaultLanguage || 'auto'], ['Transcribe only', record.transcribeOnly ? 'on' : 'off'], ['Diagnostics mode', mode, record.stale ? 'warn' : 'ok'], ['Refreshed', refreshed], ['Available backends', diagnosticsChipList(available, available.length ? 'ok' : 'warn'), 'html']];
  const backends = Array.isArray(record.backends) ? record.backends.map(asRecord) : [];
  return rows.concat(backends.map((backend) => [String(backend.label || backend.id || '-'), diagnosticsVoiceBackendValue(backend), 'html']));
}

function diagnosticsVoicePanel(voice: unknown) {
  return diagnosticsTabPanel('voice', '<div class="diagnostics-tab-heading"><div></div><div class="row diagnostics-heading-actions"><button type="button" class="secondary" data-voice-refresh>Refresh voice backends</button></div></div>' + diagnosticsPanelGrid('Voice Backends', diagnosticsVoiceRows(voice)));
}

function diagnosticsTabPanel(id: string, html: string) {
  return '<div class="diagnostics-tab ' + (state.diagnosticsTab === id ? 'active' : '') + '" data-diagnostics-tab-panel="' + attr(id) + '">' + html + '</div>';
}

function diagnosticsPanelGrid(title: string, rows: DiagnosticsRow[]) {
  return '<div class="metrics-grid diagnostics-grid diagnostics-single-grid">' + metricKvCard(title, rows) + '</div>';
}

function doctorStatusBadge(item: DiagnosticsRecord) {
  if (item.ok) return uiBadge('pass', 'enabled');
  return uiBadge(item.status === 'fail' ? 'fail' : 'warn', item.status === 'fail' ? 'disabled' : 'planned');
}

function doctorFixButton(item: DiagnosticsRecord) {
  const fix = asRecord(item.fix);
  if (!fix.safe || item.ok) return '-';
  return '<div class="data-table-actions">' + uiButton(String(fix.label || 'Apply fix'), { variant: 'secondary', mini: true, data: { doctorFix: fix.id }, disabled: !can('settings.write'), title: fix.summary || '' }) + '</div>';
}

function doctorRow(item: DiagnosticsRecord) {
  return '<tr><td data-label="Check" class="primary-cell"><span class="truncate-cell" title="' + attr(item.name || item.id) + '">' + esc(item.name || item.id) + '</span></td><td data-label="Status" class="status-cell">' + doctorStatusBadge(item) + '</td><td data-label="Detail"><span class="truncate-cell" title="' + attr(item.detail || '') + '">' + esc(short(item.detail || '-', 220)) + '</span></td><td data-label="Fix" class="actions-cell">' + doctorFixButton(item) + '</td></tr>';
}

function diagnosticsDoctorPanel(report: unknown) {
  if (!report) return diagnosticsPanelGrid('Doctor', [['Status', 'not collected', 'warn']]);
  const record = asRecord(report);
  if (record.error) return '<div class="metrics-grid diagnostics-grid diagnostics-single-grid">' + metricKvCard('Doctor', [['Error', record.error, 'error']]) + '</div>';
  const summary = asRecord(record.summary);
  const header = '<div class="doctor-summary item"><strong>Setup doctor ' + uiBadge((summary.failed || 0) + ' failed', summary.failed ? 'disabled' : 'enabled') + ' ' + uiBadge((summary.warnings || 0) + ' warnings', summary.warnings ? 'planned' : 'enabled') + '</strong><small>' + esc('Env: ' + (record.envPath || '-') + ' | Home: ' + (record.home || '-')) + '</small><div class="row"><button type="button" class="secondary" data-doctor-reload>Reload doctor</button><button type="button" data-doctor-fix-all' + disabledAttr('settings.write') + '>Apply safe fixes</button></div></div>';
  const rows = Array.isArray(record.checks) ? record.checks.map(asRecord) : [];
  const table = rows.length ? '<div class="data-table-wrap"><table class="data-table diagnostics-doctor-table"><thead><tr><th>Check</th><th>Status</th><th>Detail</th><th class="actions-heading">Fix</th></tr></thead><tbody>' + rows.map(doctorRow).join('') + '</tbody></table></div>' : uiEmpty('No doctor checks.');
  return diagnosticsTabPanel('doctor', header + table);
}

function diagnosticsHtml(input: unknown, doctor: unknown = null) {
  const d = asRecord(input);
  const h = asRecord(d.health);
  const snapshot = asRecord(d.snapshot);
  const runtime = asRecord(d.runtime);
  const s = asRecord(snapshot.session);
  return diagnosticsTabPanel('overview', '<div class="metrics-grid diagnostics-grid diagnostics-overview-grid">' + metricKvCard('Overview', diagnosticsOverviewRows(d, h, s)) + metricKvCard('Runtime', diagnosticsRuntimeRows(d, h)) + '</div>') + diagnosticsTabPanel('runtime', diagnosticsPanelGrid('Runtime', diagnosticsRuntimeRows(d, h))) + diagnosticsTabPanel('agent', diagnosticsPanelGrid('Agent', diagnosticsAgentRows(s))) + diagnosticsTabPanel('state', diagnosticsPanelGrid('Agent State', diagnosticsAgentStateRows(runtime.agentDiagnostics))) + diagnosticsTabPanel('versions', diagnosticsPanelGrid('CLI Versions', diagnosticsVersionRows(d.versionChecks || {}))) + diagnosticsTabPanel('channels', diagnosticsChannelsHtml(d)) + diagnosticsVoicePanel(runtime.voiceDiagnostics) + diagnosticsTabPanel('mirror', diagnosticsPanelGrid('External Mirror', diagnosticsMirrorRows(runtime.externalMirror))) + diagnosticsDoctorPanel(doctor);
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
  document.querySelectorAll('[data-voice-refresh]').forEach(b => b.onclick = () => safe(async () => {
    if (!can('diagnostics.read')) { toast('Permission required: diagnostics.read'); return; }
    const button = b as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Refreshing...';
    await api('/api/diagnostics/voice/refresh', { method: 'POST' });
    toast('Voice backend diagnostics refreshed');
    await loadDiagnostics();
  }));
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
