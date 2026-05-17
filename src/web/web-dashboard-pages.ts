import { renderDashboardNav } from "./web-dashboard-ui.js";

export interface DashboardAppOptions {
  cspNonce?: string;
  assetVersion?: string;
}

const faviconLinks = `
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/assets/favicon.png">
  <link rel="apple-touch-icon" href="/assets/logo.png">`;

export function renderLoginPage(options: { adminConfigured: boolean; cspNonce?: string }): string {
  const nonce = nonceAttr(options.cspNonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Login</title>
${faviconLinks}
  <style${nonce}>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f2;color:#181c19;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}
    form{width:min(420px,calc(100vw - 32px));background:white;border:1px solid #dfe3dc;border-radius:8px;padding:24px;box-shadow:0 20px 60px rgba(20,30,24,.08)}
    h1{font-size:24px;margin:0 0 8px}
    p{color:#5d665d;margin:0 0 18px}
    label{display:block;font-size:13px;color:#4b544d;margin:14px 0 6px}
    input{box-sizing:border-box;width:100%;height:40px;border:1px solid #cfd6ce;border-radius:6px;padding:0 10px;font:inherit}
    button{margin-top:18px;width:100%;height:42px;border:0;border-radius:6px;background:#205c43;color:white;font-weight:650;cursor:pointer}
    .error{color:#9b1c1c;min-height:22px;margin-top:12px}
  </style>
</head>
<body>
  <form id="login">
    <h1>NordRelay Dashboard</h1>
    <p>${options.adminConfigured ? "Sign in with your NordRelay user account." : "No admin user exists. Run nordrelay user create-admin on this host first."}</p>
    <label>Email</label><input id="email" name="email" type="email" autocomplete="username" ${options.adminConfigured ? "" : "disabled"}>
    <label>Password</label><input id="password" name="password" type="password" autocomplete="current-password" ${options.adminConfigured ? "" : "disabled"}>
    <button ${options.adminConfigured ? "" : "disabled"}>Sign in</button>
    <div class="error" id="error"></div>
  </form>
  <script${nonce}>
    document.getElementById('login').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        email: document.getElementById('email')?.value || undefined,
        password: document.getElementById('password')?.value || undefined,
      };
      const res = await fetch('/api/auth', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) {
        document.getElementById('error').textContent = 'Invalid credentials';
        return;
      }
      location.href = '/';
    });
  </script>
</body>
</html>`;
}

export function renderFirstRunSetupPage(options: { tokenRequired: boolean; cspNonce?: string }): string {
  const nonce = nonceAttr(options.cspNonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay First Run</title>
${faviconLinks}
  <style${nonce}>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f2;color:#181c19;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}
    form{width:min(460px,calc(100vw - 32px));background:white;border:1px solid #dfe3dc;border-radius:8px;padding:24px;box-shadow:0 20px 60px rgba(20,30,24,.08)}
    h1{font-size:24px;margin:0 0 8px}
    p{color:#5d665d;margin:0 0 18px;line-height:1.45}
    label{display:block;font-size:13px;color:#4b544d;margin:14px 0 6px}
    input{box-sizing:border-box;width:100%;height:40px;border:1px solid #cfd6ce;border-radius:6px;padding:0 10px;font:inherit}
    button{margin-top:18px;width:100%;height:42px;border:0;border-radius:6px;background:#205c43;color:white;font-weight:650;cursor:pointer}
    .error{color:#9b1c1c;min-height:22px;margin-top:12px}
    small{display:block;color:#667267;margin-top:8px;line-height:1.4}
  </style>
</head>
<body>
  <form id="setup">
    <h1>NordRelay Setup</h1>
    <p>Create the first admin account. After this, every dashboard page and API route requires login.</p>
    <label>Email</label><input id="email" name="email" type="email" autocomplete="username" required>
    <label>Name</label><input id="displayName" name="displayName" autocomplete="name" required>
    <label>Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
    <label>Setup token</label><input id="setupToken" name="setupToken" autocomplete="one-time-code" ${options.tokenRequired ? "required" : ""}>
    <small>${options.tokenRequired ? "Use the token printed in the NordRelay console." : "Local setup does not require the token, but the console token also works."}</small>
    <button>Create admin</button>
    <div class="error" id="error"></div>
  </form>
  <script${nonce}>
    document.getElementById('setup').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        email: document.getElementById('email')?.value || undefined,
        displayName: document.getElementById('displayName')?.value || undefined,
        password: document.getElementById('password')?.value || undefined,
        setupToken: document.getElementById('setupToken')?.value || undefined,
      };
      const res = await fetch('/api/setup/admin', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        document.getElementById('error').textContent = data.error || 'Setup failed';
        return;
      }
      location.href = '/';
    });
  </script>
</body>
</html>`;
}

export function renderDashboardApp(options: DashboardAppOptions = {}): string {
  const nonce = nonceAttr(options.cspNonce);
  const assetVersion = encodeURIComponent(options.assetVersion ?? "dev");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Dashboard</title>
${faviconLinks}
  <script${nonce}>
    (() => {
      const preference = localStorage.getItem('nordrelayThemePreference') || localStorage.getItem('nordrelayTheme') || 'light';
      const resolved = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : preference === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = resolved;
    })();
  </script>
  <link rel="stylesheet" href="/assets/dashboard.css?v=${assetVersion}">
</head>
<body>
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <button id="brandHomeBtn" class="brand brand-home" type="button" aria-label="Open overview"><img class="brand-mark" src="/assets/logo.png" alt="" width="44" height="44" aria-hidden="true"><span class="brand-copy"><strong>NordRelay</strong><small>Remote control</small></span></button>
      <div class="brand-separator" aria-hidden="true"></div>
      <nav>
        ${renderDashboardNav()}
      </nav>
    </aside>
    <main>
      <header>
        <div class="header-title">
          <h1 id="pageTitle">Overview</h1>
          <div id="sessionLine" class="header-target-line">Loading session...</div>
        </div>
        <div class="header-actions">
          <div class="account-menu" id="accountMenu">
            <button id="userMenuBtn" class="secondary account-menu-button" type="button" aria-haspopup="menu" aria-expanded="false" title="Account">
              <span id="userMenuInitials" class="account-avatar">?</span>
              <span id="userMenuName">Account</span>
            </button>
            <div id="userMenuPanel" class="account-menu-panel" role="menu" hidden>
              <button id="profileBtn" class="secondary" type="button" role="menuitem">Profile</button>
              <div class="account-menu-group" role="group" aria-label="Theme">
                <button class="secondary" type="button" role="menuitemradio" data-theme-choice="light" aria-checked="false">Theme: Light</button>
                <button class="secondary" type="button" role="menuitemradio" data-theme-choice="dark" aria-checked="false">Theme: Dark</button>
                <button class="secondary" type="button" role="menuitemradio" data-theme-choice="system" aria-checked="false">Theme: System</button>
              </div>
              <button id="logoutBtn" class="secondary" type="button" role="menuitem">Logout</button>
            </div>
          </div>
          <button class="menu" id="menuBtn" type="button" aria-label="Open navigation" aria-expanded="false">
            <span class="menu-icon" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <section class="page active" id="page-overview">
        <div class="metrics" id="metrics"></div>
        <div class="stack">
          <div class="panel"><h2>Active Sessions</h2><div id="activeSessions" class="list"></div></div>
          <div class="overview-adapter-grid">
            <div class="panel"><h2>Agent Adapters</h2><div id="agentAdapters"></div></div>
            <div class="panel"><h2>Chat Adapters</h2><div id="chatAdapters"></div></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-chat">
        <div class="chat-layout tools-hidden" id="chatLayout">
          <div class="panel chat-panel">
            <div class="chat-toolbar">
              <button id="newSessionBtn">New session</button>
              <button id="retryBtn" class="secondary">Retry</button>
              <button id="editLastBtn" class="secondary">Edit last</button>
              <button id="templatePickerBtn" class="secondary" type="button">Templates</button>
              <button id="syncBtn" class="secondary">Sync</button>
              <button id="notifyBtn" class="secondary">Notify</button>
              <label class="mirror-control" title="Mirror local CLI activity into this WebUI chat">
                Mirror
                <select id="mirrorModeSelect">
                  <option value="off">Off</option>
                  <option value="status">Status</option>
                  <option value="final">Final</option>
                  <option value="full">Full</option>
                </select>
              </label>
              <button id="clearChatBtn" class="secondary">Clear history</button>
              <button id="abortBtn">Abort</button>
              <button id="handbackBtn">Handback</button>
              <button id="toggleToolsBtn" class="secondary" type="button" aria-controls="toolPanel" aria-expanded="false">Show Tools</button>
            </div>
            <div class="control-grid" id="sessionControls"></div>
            <div id="messages" class="messages"></div>
            <form id="promptForm" class="composer">
              <div class="composer-fields">
                <textarea id="promptInput" placeholder="Send a message to the active coding agent..." rows="3"></textarea>
                <div class="attachment-row">
                  <label class="file-button" for="fileInput">Attach files</label>
                  <input id="fileInput" type="file" multiple>
                  <button type="button" id="recordBtn" class="secondary">Record voice</button>
                  <span id="fileSummary">No files selected</span>
                  <button type="button" id="clearFilesBtn" class="secondary">Clear</button>
                </div>
              </div>
              <button>Send</button>
            </form>
          </div>
          <div class="panel side-panel" id="toolPanel" hidden><h2>Tools / Plan</h2><div id="toolStream" class="tool-stream"></div></div>
        </div>
      </section>

      <section class="page" id="page-workflows">
        <div class="panel">
          <div class="section-header workflow-section-header">
            <div id="workflowTabs" class="section-tabs workflow-tabs" role="tablist" aria-label="Workflow sections">
              <button type="button" role="tab" aria-selected="true" tabindex="0" data-workflow-tab="templates" class="active">Templates</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-workflow-tab="workflows">Workflows</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-workflow-tab="runs">Runs</button>
            </div>
          </div>
          <div class="workflow-tab active" data-workflow-tab-panel="templates">
            <div class="workflow-tab-heading">
              <div class="row workflow-heading-actions"><button id="reloadWorkflowsBtn" class="secondary">Reload</button><button id="createTemplateBtn">Create template</button></div>
              <div class="workflow-filter-row"><input id="templateSearch" placeholder="Search templates"></div>
            </div>
            <div id="templateList" class="list"></div>
          </div>
          <div class="workflow-tab" data-workflow-tab-panel="workflows">
            <div class="workflow-tab-heading">
              <div class="row workflow-heading-actions"><button id="createWorkflowBtn">Create workflow</button></div>
              <div class="workflow-filter-row"><input id="workflowSearch" placeholder="Search workflows"></div>
            </div>
            <div id="workflowList" class="list"></div>
          </div>
          <div class="workflow-tab" data-workflow-tab-panel="runs">
            <div class="workflow-tab-heading">
              <div class="row workflow-heading-actions"><button id="reloadWorkflowRunsBtn" class="secondary">Reload runs</button></div>
            </div>
            <div id="workflowRunList" class="list"></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-metrics">
        <div class="panel">
          <div class="row"><button id="reloadMetricsBtn">Reload metrics</button></div>
          <div id="metricsPanel" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-sessions">
        <div class="panel">
          <div class="sessions-toolbar">
            <div class="row search-row"><input id="sessionSearch" placeholder="Search sessions"><button id="sessionSearchBtn">Search</button></div>
            <div class="row attach-row"><input id="attachInput" placeholder="Thread ID to attach/switch"><button id="attachBtn">Attach</button></div>
          </div>
          <div id="sessionsList" class="sessions-table-host"></div>
          <div id="sessionsPager" class="pager"></div>
        </div>
      </section>

      <section class="page" id="page-queue">
        <div class="panel">
          <div class="section-header queue-section-header">
            <div id="queueTabs" class="section-tabs queue-tabs" role="tablist" aria-label="Queue sections">
              <button type="button" role="tab" aria-selected="true" tabindex="0" data-queue-tab="queue" class="active">Queue</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-queue-tab="planner">Planner</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-queue-tab="progress">In Progress</button>
            </div>
          </div>
          <div class="queue-tab active" data-queue-tab-panel="queue">
            <div class="queue-tab-heading">
              <div class="row"><button data-queue="pause">Pause</button><button data-queue="resume">Resume</button><button data-queue="clear" class="danger">Clear</button><span id="queueStatus"></span></div>
            </div>
            <div id="queueList" class="list"></div>
          </div>
          <div class="queue-tab" data-queue-tab-panel="planner">
            <div class="queue-tab-heading">
              <div class="row"><button id="createQueuePlanBtn">Create planned prompt</button><button id="reloadQueuePlansBtn" class="secondary">Reload</button></div>
              <div class="row queue-filter-row"><input id="queuePlanSearch" placeholder="Search planned prompts"></div>
            </div>
            <div id="queuePlannerBoard" class="queue-kanban"></div>
          </div>
          <div class="queue-tab" data-queue-tab-panel="progress">
            <div class="queue-tab-heading">
              <div class="row"><button id="reloadQueueProgressBtn" class="secondary">Reload</button></div>
            </div>
            <div id="queueProgressBoard" class="queue-kanban queue-progress-board"></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-monitor">
        <div class="panel">
          <div class="section-header monitor-section-header">
            <div id="monitorTabs" class="section-tabs monitor-tabs" role="tablist" aria-label="Monitor sections">
              <button type="button" role="tab" aria-selected="true" tabindex="0" data-monitor-tab="activity" data-permission="sessions.read" class="active">Activity</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-monitor-tab="tasks" data-permission="inspect">Tasks</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-monitor-tab="trace" data-permission="sessions.read">Trace</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-monitor-tab="artifacts" data-permission="files.read">Artifacts</button>
            </div>
          </div>
          <div class="monitor-tab active" data-monitor-tab-panel="activity">
            <div class="monitor-tab-heading">
              <div class="row"><select id="activitySource"><option value="all">All sources</option><option value="web">Web</option><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="slack">Slack</option><option value="cli">CLI</option></select><select id="activityCategory"><option value="all">All categories</option><option value="prompt">Prompt</option><option value="session">Session</option><option value="queue">Queue</option><option value="agent-update">Agent update</option><option value="artifact">Artifact</option><option value="system">System</option><option value="auth">Auth</option><option value="security">Security</option><option value="tool">Tool</option></select><select id="activityStatus"><option value="all">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="aborted">Aborted</option><option value="info">Info</option></select><input id="activityActor" placeholder="Actor"><input id="activityAgent" placeholder="Agent"><input id="activityThread" placeholder="Thread ID"><input id="activityWorkspace" placeholder="Workspace"><input id="activityType" placeholder="Type"><input id="activitySince" type="datetime-local"><input id="activityLimit" type="number" value="100" min="1" max="500"><button id="loadActivityBtn">Load activity</button><button id="exportActivityBtn" class="secondary">Export</button></div>
            </div>
            <div id="activityList" class="list"></div>
            <div id="activityPager" class="pager"></div>
          </div>
          <div class="monitor-tab" data-monitor-tab-panel="tasks">
            <div class="monitor-tab-heading">
              <div class="row"><button id="reloadTasksBtn">Reload tasks</button></div>
            </div>
            <div id="tasksList" class="list"></div>
            <div id="jobsPager" class="pager"></div>
          </div>
          <div class="monitor-tab" data-monitor-tab-panel="trace">
            <div class="monitor-tab-heading">
              <div class="row"><input id="traceCorrelationId" placeholder="Correlation ID"><button id="loadTraceBtn">Load trace</button></div>
            </div>
            <div id="traceDetail" class="list"></div>
          </div>
          <div class="monitor-tab" data-monitor-tab-panel="artifacts">
            <div class="monitor-tab-heading">
              <div class="row"><button id="reloadArtifactsBtn">Reload artifacts</button><input id="artifactSearch" placeholder="Search artifacts"><select id="artifactKind"><option value="all">All files</option><option value="images">Images</option><option value="docs">Docs/code</option></select><button id="zipSelectedArtifactsBtn" class="secondary">ZIP selected</button><button id="deleteSelectedArtifactsBtn" class="danger">Delete selected</button></div>
            </div>
            <div id="artifactPreview" class="preview"></div>
            <div id="artifactList" class="list"></div>
            <div id="artifactPager" class="pager"></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-adapters">
        <div class="panel">
          <div class="adapter-section-header">
            <div id="adapterTabs" class="section-tabs adapter-tabs" role="tablist" aria-label="Adapter sections">
              <button type="button" role="tab" aria-selected="true" tabindex="0" data-adapter-tab="adapters" class="active">Adapters</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-adapter-tab="conformance">Adapter Conformance</button>
            </div>
          </div>
          <div id="adapterPanel" class="adapter-panel">
            <div class="adapter-tab active" data-adapter-tab-panel="adapters">
              <div class="adapter-heading-actions"><button id="reloadAdaptersBtn">Reload adapters</button></div>
              <div id="adapterHealth" class="list"></div>
            </div>
            <div class="adapter-tab" data-adapter-tab-panel="conformance">
              <div class="adapter-heading-actions"><button id="reloadAdapterConformanceBtn" class="secondary">Reload conformance</button></div>
              <div id="adapterConformance" class="list"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="page" id="page-peers">
        <div class="panel">
          <div class="section-header peer-section-header">
            <div id="peerTabs" class="section-tabs peer-tabs" role="tablist" aria-label="Peer sections">
              <button type="button" role="tab" aria-selected="true" tabindex="0" data-peer-tab="status" class="active">Status</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-peer-tab="peers">Peers</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-peer-tab="invitations">Invitations</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-peer-tab="discovery">Discovery</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-peer-tab="global">Global Sessions</button>
            </div>
          </div>
          <div class="peer-tab active" data-peer-tab-panel="status">
            <div class="peer-tab-heading">
              <div class="row peer-heading-actions"><button id="loadPeersBtn">Reload status</button><button id="exportPeerIdentityBtn" class="secondary">Export identity</button><button id="restorePeerIdentityBtn" class="secondary">Restore identity</button></div>
            </div>
            <div id="peerStatus" class="list"></div>
          </div>
          <div class="peer-tab" data-peer-tab-panel="peers">
            <div class="peer-tab-heading">
              <div class="row peer-heading-actions"><button id="addPeerBtn" class="secondary">Add peer</button><button id="reloadPeersListBtn" class="secondary">Reload peers</button></div>
            </div>
            <div id="peersList" class="list"></div>
          </div>
          <div class="peer-tab" data-peer-tab-panel="invitations">
            <div class="peer-tab-heading">
              <div class="row peer-heading-actions"><button id="createPeerInviteBtn">Create invite</button><button id="reloadPeerInvitesBtn" class="secondary">Reload invitations</button></div>
            </div>
            <div id="peerInvites" class="list"></div>
          </div>
          <div class="peer-tab" data-peer-tab-panel="discovery">
            <div class="peer-tab-heading">
              <div class="row peer-heading-actions"><button id="discoverPeersBtn" class="secondary">Discover LAN peers</button><button id="cancelPeerDiscoveryBtn" class="secondary">Cancel discovery</button></div>
            </div>
            <div class="row peer-discovery-controls"><input id="peerDiscoveryTargets" placeholder="Optional targets: 192.168.178.0/24, 192.168.178.10-50, host.local, https://host:31979"><input id="peerDiscoveryMaxHosts" type="number" min="1" max="65536" value="512" title="Max hosts"><input id="peerDiscoveryConcurrency" type="number" min="1" max="128" value="32" title="Concurrency"></div>
            <div id="peerDiscovery" class="list"></div>
          </div>
          <div class="peer-tab" data-peer-tab-panel="global">
            <div class="peer-tab-heading">
              <div class="row peer-heading-actions"><input id="globalPeerSessionSearch" placeholder="Search sessions across peers"><button id="loadGlobalPeerSessionsBtn">Load global sessions</button></div>
            </div>
            <div id="globalPeerSessionsPanel" class="list"><div class="item"><div id="globalPeerSessionsList">Load global sessions to inspect sessions across connected peers.</div></div></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-access">
        <div class="panel">
          <div class="section-header access-section-header">
            <div id="accessTabs" class="section-tabs access-tabs" role="tablist" aria-label="Users sections">
              <button type="button" role="tab" aria-selected="true" tabindex="0" data-access-tab="users" class="active">Users</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-access-tab="groups">Groups</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-access-tab="telegram">Telegram</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-access-tab="discord">Discord</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-access-tab="slack">Slack</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-access-tab="locks">Locks</button>
              <button type="button" role="tab" aria-selected="false" tabindex="-1" data-access-tab="audit">Audit</button>
            </div>
          </div>
          <div class="access-tab active" data-access-tab-panel="users">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="loadAccessBtn" class="secondary">Reload</button><button id="createUserBtn">Create user</button></div>
              <div class="access-filter-row">
                <input id="userSearch" placeholder="Search users">
                <select id="userStatusFilter"><option value="all">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option></select>
                <select id="userGroupFilter"><option value="all">All groups</option></select>
                <select id="userIdentityFilter"><option value="all">All identities</option><option value="telegram">Telegram linked</option><option value="discord">Discord linked</option><option value="slack">Slack linked</option><option value="web">Web sessions</option><option value="unlinked">No chat identity</option></select>
              </div>
            </div>
            <div id="accessPanel" class="list user-list"></div>
            <div id="usersPager" class="pager"></div>
          </div>
          <div class="access-tab" data-access-tab-panel="groups">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="createGroupBtn" class="secondary">Create group</button></div>
              <div class="access-filter-row"><input id="groupSearch" placeholder="Search groups"></div>
            </div>
            <div id="groupsList" class="list"></div>
          </div>
          <div class="access-tab" data-access-tab-panel="telegram">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="createChatBtn" class="secondary">Add Telegram chat</button></div>
              <input id="telegramChatSearch" placeholder="Search Telegram chats">
            </div>
            <div id="telegramChatsList" class="list"></div>
          </div>
          <div class="access-tab" data-access-tab-panel="discord">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="createDiscordChannelBtn" class="secondary">Add Discord channel</button></div>
              <input id="discordChannelSearch" placeholder="Search Discord channels">
            </div>
            <div id="discordChannelsList" class="list"></div>
          </div>
          <div class="access-tab" data-access-tab-panel="slack">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="createSlackChannelBtn" class="secondary">Add Slack channel</button></div>
              <input id="slackChannelSearch" placeholder="Search Slack channels">
            </div>
            <div id="slackChannelsList" class="list"></div>
          </div>
          <div class="access-tab" data-access-tab-panel="locks">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="lockSessionBtn" class="secondary">Lock web session</button><button id="unlockSessionBtn" class="secondary">Unlock web session</button></div>
            </div>
            <div id="locksList" class="list"></div>
          </div>
          <div class="access-tab" data-access-tab-panel="audit">
            <div class="access-tab-heading">
              <div class="row access-heading-actions"><button id="loadAuditBtn">Load audit</button><button id="exportAuditBtn" class="secondary">Export</button></div>
            </div>
            <div class="row audit-filter-row"><select id="auditChannel"><option value="all">All channels</option><option value="web">Web</option><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="slack">Slack</option></select><select id="auditCategory"><option value="all">All categories</option><option value="prompt">Prompt</option><option value="session">Session</option><option value="queue">Queue</option><option value="agent-update">Agent update</option><option value="artifact">Artifact</option><option value="system">System</option><option value="auth">Auth</option><option value="security">Security</option><option value="tool">Tool</option></select><select id="auditStatus"><option value="all">All statuses</option><option value="ok">OK</option><option value="failed">Failed</option><option value="denied">Denied</option></select><input id="auditActor" placeholder="Actor"><input id="auditAgent" placeholder="Agent"><input id="auditThread" placeholder="Thread ID"><input id="auditWorkspace" placeholder="Workspace"><input id="auditSince" type="datetime-local"><input id="auditLimit" type="number" value="50" min="1" max="500"></div>
            <div id="auditList" class="list"></div>
            <div id="auditPager" class="pager"></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-version">
        <div class="panel">
          <div class="row version-actions"><button id="loadVersionBtn">Check versions</button><button id="updateBtn" class="secondary">Update NordRelay</button></div>
          <div id="versionPanel" class="list"></div>
          <h2 class="version-update-title">Agent update jobs</h2>
          <div id="agentUpdateJobs" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-settings">
        <div class="panel">
          <div id="settingsTabHeader" class="section-header settings-section-header">
            <div id="settingsTabs" class="section-tabs settings-tabs" role="tablist" aria-label="Settings sections"></div>
          </div>
          <div id="settingsSubnav" class="settings-subnav" hidden></div>
          <div id="settingsActions" class="row settings-actions"><button id="saveSettingsBtn">Save settings</button><button id="settingsWizardBtn" class="secondary">Setup wizard</button><button id="restartBtn" class="secondary">Restart NordRelay</button><span id="settingsStatus"></span></div>
          <div id="settingsForm" class="settings-grid"></div>
        </div>
      </section>

      <section class="page" id="page-logs">
        <div class="panel">
          <div class="row"><select id="logTarget"><option value="connector">Connector</option><option value="update">NordRelay Update</option><option value="agent-updates">Agent Updates</option></select><select id="logLevel"><option value="all">All levels</option><option value="ERROR">Error</option><option value="WARN">Warn</option><option value="INFO">Info</option></select><input id="logSearch" placeholder="Search logs"><input id="logSince" type="datetime-local" title="Show entries after this time"><input id="logLines" type="number" value="120" min="1" max="300"><label class="checkbox"><input id="logAutoRefresh" type="checkbox"> Auto</label><label class="checkbox"><input id="logFollow" type="checkbox"> Follow</label><button id="loadLogsBtn">Load logs</button><button id="downloadLogsBtn" class="secondary">Download</button><button id="clearLogsBtn" class="danger">Clear</button></div>
          <pre id="logs" class="log-view"></pre>
        </div>
      </section>

      <section class="page" id="page-diagnostics">
        <div class="panel">
          <div class="row"><button id="exportDiagnosticsBundleBtn" class="secondary">Export diagnostics bundle</button></div>
          <div id="diagnostics" class="list"></div>
        </div>
      </section>

      <footer>
        <span id="footerVersion">NordRelay</span>
        <span id="footerHealth">Health: loading</span>
        <span id="connectionStatus" class="footer-connection connection-warn">Connection: Connecting</span>
        <span id="footerUser">User: loading</span>
      </footer>
    </main>
  </div>
  <dialog id="newSessionDialog">
    <form method="dialog" id="newSessionForm">
      <h2>New Session</h2>
      <div class="form-grid">
        <label>Agent<select id="newAgent"></select></label>
        <label>Workspace<input id="newWorkspace" list="workspaceOptions" placeholder="Current workspace"></label>
        <label>Model<select id="newModel"></select></label>
        <label id="newReasoningWrap">Reasoning<select id="newReasoning"></select></label>
        <label id="newLaunchWrap">Launch profile<select id="newLaunch"></select></label>
        <label id="newFastWrap" class="checkbox"><input id="newFast" type="checkbox"> Fast mode</label>
      </div>
      <datalist id="workspaceOptions"></datalist>
      <div class="row dialog-actions"><button type="button" id="cancelSessionBtn" class="secondary">Cancel</button><button id="createSessionBtn" value="default">Create session</button></div>
    </form>
  </dialog>
  <dialog id="sessionDetailDialog">
    <div id="sessionDetail"></div>
    <div class="row dialog-actions"><button id="closeSessionDetailBtn" class="secondary">Close</button></div>
  </dialog>
  <dialog id="userDetailDialog">
    <div id="userDetail"></div>
    <div class="row dialog-actions"><button id="closeUserDetailBtn" class="secondary">Close</button></div>
  </dialog>
  <dialog id="adminDialog">
    <form method="dialog" id="adminDialogForm">
      <h2 id="adminDialogTitle">Edit</h2>
      <div id="adminDialogBody" class="form-grid"></div>
      <div class="row dialog-actions"><button type="button" id="adminDialogCancel" class="secondary">Cancel</button><button id="adminDialogSubmit" value="default">Save</button></div>
    </form>
  </dialog>
  <dialog id="profileDialog">
    <form method="dialog" id="profileForm">
      <h2>Profile</h2>
      <div class="profile-grid">
        <section class="profile-section">
          <h3>Account</h3>
          <div class="form-grid">
            <label>Email<input id="profileEmail" type="email" disabled></label>
            <label>Name<input id="profileNameInput" autocomplete="name"></label>
            <label>Theme<select id="profileThemeSelect"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label>
          </div>
          <div id="profileStatus" class="profile-status"></div>
          <div class="row dialog-actions"><button type="button" id="saveProfileBtn">Save profile</button></div>
        </section>
        <section class="profile-section">
          <h3>Change password</h3>
          <div class="form-grid">
            <label>Current password<input id="profileCurrentPassword" type="password" autocomplete="current-password"></label>
            <label>New password<input id="profileNewPassword" type="password" autocomplete="new-password"></label>
            <label>Confirm password<input id="profileConfirmPassword" type="password" autocomplete="new-password"></label>
          </div>
          <div id="profilePasswordStatus" class="profile-status"></div>
          <div class="row dialog-actions"><button type="button" id="changeProfilePasswordBtn" class="secondary">Change password</button></div>
        </section>
        <section class="profile-section full-span">
          <h3>Linked accounts</h3>
          <div id="profileLinkedAccounts" class="profile-list"></div>
        </section>
        <section class="profile-section full-span">
          <div class="profile-section-title"><h3>Web sessions</h3><button type="button" id="logoutOtherSessionsBtn" class="danger">Logout other sessions</button></div>
          <div id="profileWebSessions" class="profile-list"></div>
        </section>
      </div>
      <div class="row dialog-actions"><button type="button" id="closeProfileBtn" class="secondary">Close</button></div>
    </form>
  </dialog>
  <div id="toolTooltip" class="tool-tooltip"></div>
  <div id="toast"></div>
  <script src="/assets/dashboard.js?v=${assetVersion}"></script>
</body>
</html>`;
}

function nonceAttr(cspNonce?: string): string {
  return cspNonce ? ` nonce="${cspNonce.replace(/"/g, "")}"` : "";
}
