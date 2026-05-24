import { readFileSync } from "node:fs";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { dashboardBundleAsset, dashboardCss, dashboardJs, dashboardStaticAsset } from "../src/web/web-dashboard-assets.js";

describe("web dashboard browser-flow assets", () => {
  it("includes the agent feature matrix and dedicated agent update log flow", () => {
    const css = dashboardCss();
    const js = dashboardJs();

    expect(css).toContain(".feature-matrix");
    expect(css).toContain(".conformance-grid .item+.item{margin-top:8px}");
    expect(css).toContain(".adapters-table th:nth-child(7)");
    expect(js).toContain("function featureMatrix");
    expect(js).toContain("function renderAdapterHealthTable");
    expect(js).toContain('class="data-table adapters-table"');
    expect(js).not.toContain("+'</small>'+featureMatrix(a.capabilities)+'<div class=\"row\">");
    expect(js).not.toContain("'CLI: '+(a.cli.label||'-')+' / path '+(a.cli.path||'-')");
    expect(js).toContain("agent-updates");
    expect(js).toContain("/api/agent-updates");
  });

  it("includes unified jobs on the Monitor Tasks tab", () => {
    const js = dashboardJs();
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(js).toContain("function renderUnifiedJobs");
    expect(js).not.toContain("function renderRecentTurnsTable");
    expect(js).not.toContain('class="data-table activity-table recent-turns-table"');
    expect(js).not.toContain("renderRecentTurnsTable(d.recent||[])");
    expect(js).not.toContain("Recent turns");
    expect(js).toContain("function uiTraceControls");
    expect(js).toContain("bindUiCopyButtons(target)");
    expect(js).toContain("bindUiTraceButtons(target)");
    expect(js).toContain("/api/jobs");
    expect(js).toContain("data-job-action");
    expect(js).toContain("state.monitorTab==='activity'||state.monitorTab==='tasks'||state.monitorTab==='trace'");
    expect(contract).toContain('exact("/api/jobs"');
    expect(contract).toContain('dynamic("/api/jobs/:id/action"');
  });

  it("groups activity, tasks, trace, and artifacts under the Monitor page", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const navSource = readFileSync("src/web/web-dashboard-ui.ts", "utf8");

    expect(navSource).toContain('{ id: "monitor", label: "Monitor"');
    expect(navSource).not.toContain('{ id: "tasks", label: "Tasks"');
    expect(navSource).not.toContain('{ id: "activity", label: "Activity"');
    expect(navSource).not.toContain('{ id: "trace", label: "Trace"');
    expect(navSource).not.toContain('{ id: "artifacts", label: "Artifacts"');
    expect(pageSource).toContain('id="page-monitor"');
    expect(pageSource).toContain('data-monitor-tab="activity"');
    expect(pageSource).toContain('data-monitor-tab="tasks"');
    expect(pageSource).toContain('data-monitor-tab="trace"');
    expect(pageSource).toContain('data-monitor-tab="artifacts"');
    expect(pageSource).toContain('data-monitor-filter-toggle="activity"');
    expect(pageSource).toContain('data-monitor-filter-toggle="tasks"');
    expect(pageSource).toContain('data-monitor-filter-toggle="trace"');
    expect(pageSource).toContain('data-monitor-filter-toggle="artifacts"');
    expect(pageSource).toContain('data-monitor-filter-panel="activity" hidden');
    expect(pageSource).not.toContain('id="page-tasks"');
    expect(pageSource).not.toContain('id="page-activity"');
    expect(pageSource).not.toContain('id="page-trace"');
    expect(pageSource).not.toContain('id="page-artifacts"');
    expect(js).toContain("function loadMonitor");
    expect(js).toContain("function switchMonitorTab");
    expect(js).toContain("function toggleMonitorFilters");
    expect(js).toContain("function bindMonitorFilterToggles");
    expect(js).toContain("function renderActivityTable");
    expect(js).toContain("function renderTraceTimelineTable");
    expect(js).toContain('class="data-table activity-table"');
    expect(js).toContain('class="data-table activity-table trace-table"');
    expect(js).toContain("data-activity-age-at");
    expect(js).toContain("fmtRelativeAgo(e.timestamp)");
    expect(js).toContain("fmtRelativeAgo(item.at)");
    expect(js).toContain("page('monitor')");
    expect(css).toContain(".monitor-tab-heading");
    expect(css).toContain(".monitor-filter-toggle{display:inline-flex;align-items:center;gap:6px");
    expect(css).toContain(".monitor-filter-content[hidden]{display:none!important}");
    expect(css).toContain(".activity-table th:nth-child(8)");
  });

  it("groups Matrix settings with the other chat adapters", () => {
    const settingsPanelSource = readFileSync("src/web/ui/client/settings-panel.ts", "utf8");

    expect(settingsPanelSource).toContain("{id:'chat',label:'Chat',groups:['Telegram','Discord','Slack','Matrix']}");
  });

  it("includes workflow templates and workflow runs in the WebUI", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");
    const workflowsSource = readFileSync("src/web/ui/client/workflows-page.ts", "utf8");

    expect(pageSource).toContain('id="page-workflows"');
    expect(pageSource).toContain('id="createTemplateBtn"');
    expect(pageSource).toContain('id="importTemplateBtn"');
    expect(pageSource).toContain('id="createWorkflowBtn"');
    expect(pageSource).toContain('id="importWorkflowBtn"');
    expect(pageSource).toContain('data-template-picker-menu');
    expect(pageSource).toContain('id="templatePickerMenu"');
    expect(js).toContain("function loadWorkflows");
    expect(js).toContain("document.addEventListener('click'");
    expect(js).toContain("[data-workflow-tab]");
    expect(js).toContain("function renderTemplatesTable");
    expect(js).toContain("function openTemplatePickerMenu");
    expect(js).toContain("data-template-pick");
    expect(js).toContain("setPromptInputText(t.prompt)");
    expect(workflowsSource).toContain('title="\'+attr(t.prompt||summary||t.name||\'\')+\'"');
    expect(js).toContain('class="data-table templates-table"');
    expect(js).toContain("function workflowBuilderState");
    expect(js).toContain("function showWorkflowHistory");
    expect(js).toContain("function exportWorkflowItem");
    expect(js).toContain("function openWorkflowVariableDialog");
    expect(js).toContain("Advanced JSON import/export");
    expect(js).not.toContain("Steps JSON");
    expect(js).not.toContain("JSON.parse(val('dlgWorkflowSteps'))");
    expect(readFileSync("scripts/build-web-assets.mjs", "utf8")).toContain("src/web/ui/client/workflows-page.ts");
    expect(readFileSync("scripts/build-web-assets.mjs", "utf8")).toContain("src/web/ui/client/workflow-builder.ts");
    expect(js).toContain("/api/templates");
    expect(js).toContain("/versions/");
    expect(js).toContain("/api/workflows");
    expect(js).toContain("/api/workflow-runs/");
    expect(css).toContain(".workflow-section-header");
    expect(css).toContain(".workflow-tab-heading");
    expect(css).toContain(".workflow-builder-step");
    expect(css).toContain(".workflow-builder-json");
    expect(css).toContain(".template-picker-list");
    expect(css).toContain(".template-picker-item span{font-size:14px}");
    expect(css).toContain(".templates-table th:nth-child(7)");
    expect(contract).toContain('exact("/api/templates"');
    expect(contract).toContain('exact("/api/templates/import"');
    expect(contract).toContain('dynamic("/api/templates/:id/versions"');
    expect(contract).toContain('exact("/api/workflows"');
    expect(contract).toContain('exact("/api/workflows/import"');
    expect(contract).toContain('dynamic("/api/workflows/:id/versions"');
    expect(contract).toContain('dynamic("/api/workflow-runs/:id/cancel"');
  });

  it("forces fresh version checks from the manual Version page action", () => {
    const js = dashboardJs();
    const routeSource = readFileSync("src/web/web-dashboard-runtime-routes.ts", "utf8");

    expect(js).toContain("loadVersion({forceRefresh:true})");
    expect(js).toContain("api('/api/version',{query:options.forceRefresh?{force:true}:undefined})");
    expect(routeSource).toContain('url.searchParams.get("force") === "true"');
    expect(routeSource).toContain("runtime.version({ forceRefresh })");
  });

  it("passes WebUI correlation IDs through prompts and queued feedback", () => {
    const js = dashboardJs();

    expect(js).toContain("function createWebCorrelationId");
    expect(js).toContain("body:JSON.stringify({text,correlationId})");
    expect(js).toContain("body:JSON.stringify({text,correlationId,files:payloadFiles})");
    expect(js).toContain("appendQueuedMessage(r.queueId,r.correlationId||correlationId)");
    expect(js).toContain("function appendQueuedMessage(id,correlationId)");
  });

  it("includes queue planner kanban tabs on the Queue page", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(pageSource).toContain('data-queue-tab="planner"');
    expect(pageSource).toContain("queue-section-header");
    expect(pageSource).toContain('id="queuePlannerBoard"');
    expect(pageSource).toContain('id="queueProgressBoard"');
    expect(js).toContain("function loadQueue");
    expect(js).toContain("async function loadQueue(options:WebuiRecord={})");
    expect(js).toContain("loadQueue({silent:true})");
    expect(js).toContain("function renderQueueTable");
    expect(js).toContain("class=\"data-table queue-table\"");
    expect(js).toContain("function bindQueueTable");
    expect(js).toContain("Queue ID copied");
    expect(js).toContain("function renderQueueKanban");
    expect(js).toContain("loadQueuePlanner(options:WebuiRecord={})");
    expect(js).toContain("setLoading('queuePlannerBoard','Loading planned prompts...')");
    expect(js).toContain("loadQueuePlanner({notify:true})");
    expect(js).toContain("/api/queue/plans");
    expect(js).toContain("data-plan-enqueue");
    expect(css).toContain(".queue-kanban");
    expect(css).toContain(".queue-table{--table-min-width");
    expect(css).toContain(".queue-tab-heading");
    expect(contract).toContain('exact("/api/queue/plans"');
    expect(contract).toContain('dynamic("/api/queue/plans/:id/enqueue"');
    expect(readFileSync("scripts/build-web-assets.mjs", "utf8")).toContain("src/web/ui/client/queue-planner.ts");
  });

  it("renders Discord setting help icons from setting metadata", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const metadata = readFileSync("src/core/config-metadata.ts", "utf8");

    expect(metadata).toContain("DISCORD_SETTING_HELP");
    expect(metadata).toContain("DISCORD_BOT_TOKEN");
    expect(metadata).toContain("Discord Developer Portal");
    expect(js).toContain("function settingHelp");
    expect(js).toContain("class=\"setting-info\"");
    expect(css).toContain(".setting-info");
  });

  it("includes Discord invite and channel registration guidance in the setup wizard", () => {
    const js = dashboardJs();
    const css = dashboardCss();

    expect(js).toContain("OAuth2 URL Generator");
    expect(js).toContain("applications.commands scopes");
    expect(js).toContain("View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, and Embed Links");
    expect(js).toContain("Message Content Intent");
    expect(js).toContain("/register_channel");
    expect(js).toContain("DISCORD_ALLOWED_GUILD_IDS");
    expect(js).toContain("function wizardChecklist");
    expect(css).toContain(".wizard-checklist");
  });

  it("does not treat setup wizard defaults as pending settings changes", () => {
    const js = dashboardJs();

    expect(js).toContain("function wizardInputValue");
    expect(js).toContain("function wizardEffectiveValue");
    expect(js).toContain("state.settingsWizard={channel,step:0,values:{}");
    expect(js).toContain("collectWizardSettings(wizard)");
    expect(js).toContain("settings[key]=wizardEffectiveValue(key)");
    expect(js).not.toContain("Object.entries(wizard.defaults||{})");
  });

  it("refreshes the active page after an agent switch", () => {
    const js = dashboardJs();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const headerTargetSource = readFileSync("src/web/ui/client/header-target.ts", "utf8");

    expect(js).toContain("function selectHeaderTarget");
    expect(js).toContain("function headerSessionLabel");
    expect(js).toContain("session.sessionName");
    expect(js).toContain("headerSessionLabel(session)");
    expect(headerTargetSource).toContain("await loadBootstrap(); await reloadCurrentPage({ agentId: selected });");
    expect(headerTargetSource).toContain("headerSessionLabel(snapshot)");
    expect(readFileSync("src/agents/shared/agent.ts", "utf8")).toContain("sessionName?: string;");
    expect(readFileSync("src/runtime/relay-runtime-active-sessions.ts", "utf8")).toContain("sessionNameRecord?.name");
    expect(readFileSync("src/web/ui/client/workflows.ts", "utf8")).toContain("await loadBootstrap();await loadActiveSessions();");
    expect(js).toContain("data-target-peer");
    expect(js).toContain("data-target-agent");
    expect(js).toContain("data-target-sessions-toggle");
    expect(js).toContain("function toggleHeaderTargetSessions");
    expect(js).toContain("function selectHeaderTargetSession");
    expect(js).toContain("limit:5");
    expect(js).toContain("async function apiPeer");
    expect(pageSource).not.toContain('id="peerSelect"');
    expect(pageSource).not.toContain('id="agentSelect"');
    expect(pageSource).toContain('id="sessionLine" class="header-target-line"');
    expect(js).toContain("if(name==='overview') await loadActiveSessions()");
    expect(js).toContain("if(name==='sessions'){await loadSessions(true,options.agentId);if(state.sessionTab==='worktrees')await loadWorktrees()}");
  });

  it("shows the selected remote node in page headers outside local administration pages", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const runtimeSource = readFileSync("src/web/ui/client/core/runtime.ts", "utf8");

    expect(pageSource).toContain('id="pageTitle" class="page-title-heading"');
    expect(runtimeSource).toContain("const LOCAL_ONLY_PAGES=new Set(['access','settings','peers','workflows'])");
    expect(runtimeSource).toContain("function availableNodeCount()");
    expect(runtimeSource).toContain("function pageUsesSelectedPeer");
    expect(runtimeSource).toContain("function selectedNodeBadgeHtml");
    expect(runtimeSource).toContain("peerId==='local'||availableNodeCount()<2");
    expect(runtimeSource).toContain("headerTargetName(peerId)");
    expect(js).toContain("function renderPageTitle");
    expect(js).toContain("renderPageTitle(name)");
    expect(js).toContain("renderPageTitle()");
    expect(css).toContain(".page-title-heading{display:flex;align-items:center;gap:8px");
    expect(css).toContain(".page-node-badge{display:inline-flex;align-items:center");
  });

  it("keeps workflow resources local while a remote peer is selected", () => {
    const apiClientSource = readFileSync("src/web/ui/client/core/api-client.ts", "utf8");

    expect(apiClientSource).toContain("function isLocalWorkflowApi");
    expect(apiClientSource).toContain("path === '/api/templates'");
    expect(apiClientSource).toContain("path === '/api/workflows'");
    expect(apiClientSource).toContain("/^\\/api\\/templates\\//.test(path)");
    expect(apiClientSource).toContain("/^\\/api\\/workflows\\//.test(path)");
    expect(apiClientSource).toContain("/^\\/api\\/workflow-runs\\//.test(path)");
  });

  it("shows compact relative age for sessions and keeps absolute time in the tooltip", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const runtimeSessions = readFileSync("src/runtime/relay-runtime-sessions.ts", "utf8");

    expect(js).toContain("function fmtSessionAge");
    expect(js).toContain("function updateSessionAgeCounters");
    expect(js).toContain("function startSessionAgeCounter");
    expect(js).toContain("state.sessionAgeTimer=setInterval");
    expect(js).toContain("function sessionRelativeTimeHtml");
    expect(js).toContain("function shortMiddle");
    expect(js).toContain("function renderSessionsTable");
    expect(js).toContain("class=\"data-table sessions-table\"");
    expect(js).toContain("<th>Updated</th><th>Title");
    expect(js).toContain("sessionCell('Updated',sessionRelativeTimeHtml(s.updatedAt)");
    expect(js).toContain("esc(shortMiddle(s.id))");
    expect(js).toContain('data-copy-id="\'+attr(s.id)+\'" title="\'+attr(s.id)+\'"');
    expect(js).toContain("data-label=\"'+attr(label)+'\"");
    expect(js).toContain('class="session-age"');
    expect(js).toContain("data-session-age-at");
    expect(js).toContain("startSessionAgeCounter()");
    expect(js).not.toContain("short((s.cwd||'')+' / '+fmtDate(s.updatedAt))");
    expect(css).toContain(".data-table-wrap{max-width:100%;margin-top:12px;overflow-x:auto");
    expect(css).toContain(".data-table{width:100%;min-width:var(--table-min-width,860px);border-collapse:collapse;table-layout:fixed;font-size:14px");
    expect(css).toContain(".data-table th{background:var(--surface);color:var(--muted);font-size:13px");
    expect(css).toContain(".data-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--surface) 55%,var(--surface-soft))}");
    expect(css).toContain(".data-table-actions button{min-height:28px;height:28px;padding:0 8px;font-size:13px");
    expect(css).toContain(".actions-cell,.actions-heading{white-space:nowrap}");
    expect(css).toContain(".sessions-table");
    expect(css).toContain(".sessions-table{--table-min-width:1160px}");
    expect(css).toContain(".sessions-table:not(.worktrees-table) th:nth-child(9)");
    expect(css).toContain(".access-users-table th:nth-child(8)");
    expect(css).toContain(".access-audit-table th:nth-child(7)");
    expect(css).not.toContain(".data-table,.data-table thead,.data-table tbody,.data-table tr,.data-table th,.data-table td{display:block;width:100%}");
    expect(css).not.toContain("content:attr(data-label)");
    expect(css).toContain("@media(max-width:760px){.diagnostics-overview-grid{grid-template-columns:1fr}");
    expect(css).toContain("justify-content:flex-start;text-align:left");
    expect(pageSource).toContain('id="sessionsList" class="sessions-table-host"');
    expect(runtimeSessions).toContain("sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left)");
  });

  it("keeps the mobile menu closable and readable in light theme", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");

    expect(js).toContain("function setMobileMenuOpen");
    expect(js).toContain("function toggleMobileMenu");
    expect(js).toContain("aria-expanded");
    expect(js).toContain("event.stopPropagation();toggleMobileMenu()");
    expect(js).toContain("if (sidebar.contains(event.target)) return;");
    expect(js).toContain("event.key==='Escape'");
    expect(css).toContain(".menu:hover,.menu:focus{background:var(--accent-strong);border-color:var(--accent-strong);color:white");
    expect(css).toContain("header{z-index:30}");
    expect(css).toContain(".sidebar{position:fixed;inset:0 auto 0 0;width:270px;height:100vh");
    expect(css).toContain("z-index:40");
    expect(css).toContain(".menu-icon,.menu-icon::before,.menu-icon::after");
    expect(css).toContain(".header-actions{margin-left:auto;flex-wrap:nowrap}");
    expect(pageSource).toContain('aria-label="Open navigation"');
    expect(pageSource).toContain('class="menu-icon"');
    expect(pageSource).not.toContain('id="menuBtn">Menu</button>');
  });

  it("selects the current launch mode in the launch dropdown", () => {
    const js = dashboardJs();

    expect(js).toContain("selectedLaunch=activeLaunchProfileId(s,c)");
    expect(js).toContain("function activeLaunchProfileId");
    expect(js).toContain("function launchProfileBehaviorMatches");
    expect(js).toContain("behavior===sandbox+' / '+approval");
    expect(js).toContain("function launchMenuItems");
    expect(js).toContain("function activeLaunchLabel");
    expect(js).toContain("function knownUnsafeLaunchProfilesForSession");
    expect(js).toContain("function confirmUnsafeLaunchProfile");
    expect(js).toContain("Full Access");
    expect(js).toContain("Bypass Permissions");
    expect(js).toContain("confirmUnsafe:Boolean(profile.unsafe)");
    expect(js).toContain("items.unshift({value:selectedLaunch,label:activeLaunchLabel(session,selectedLaunch)})");
    expect(js).toContain("function configuredLaunchProfile");
    expect(js).toContain("Select a configured launch profile first");
    expect(js).toContain("compactControlMenu('controlLaunch','Launch'");
    expect(js).toContain("compactControlMenu('controlMirror','Mirror'");
    expect(js).toContain("if(id==='controlMirror')");
    expect(js).toContain("button.textContent='Saving...'");
    expect(js).toContain("await setMirrorPreference(nextValue||'off')");
    expect(js).toContain("body:{mode:argument}");
    expect(js).toContain("function bindCompactControlMenus");
    expect(js).toContain("function chatSessionControlLockTitle");
    expect(js).toContain("stateDisabledAttr(lockedTitle)");
    expect(js).toContain("currentChatWorkingSession()?'Wait until the current session finishes");
    expect(js).toContain("['controlModel','controlReasoning','controlFast','controlLaunch'].includes(id)&&currentChatWorkingSession()");
    expect(js).toContain("renderChatWorkingIndicator();renderSessionControls();renderChatTabs()");
    expect(js).toContain("selectedCompactControlValue('controlLaunch')");
    expect(js).toContain(">Apply</button>");
    expect(js).not.toContain("Apply to Current");
    expect(js).not.toContain("<label>Launch<select id=\"controlLaunch\"");
    expect(js).not.toContain("mirrorModeSelect");
    expect(js).not.toContain("Active launch");
    expect(js).not.toContain("Next launch");
  });

  it("renders chat notifications and completion sounds as toggle icons", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");

    expect(pageSource).toContain('id="notifyBtn" class="secondary icon-button notify-toggle"');
    expect(pageSource).toContain('id="soundBtn" class="secondary icon-button sound-toggle"');
    expect(pageSource).toContain('class="notify-outline"');
    expect(pageSource).toContain('class="notify-filled"');
    expect(pageSource).toContain('class="sound-outline"');
    expect(pageSource).toContain('class="sound-filled"');
    expect(pageSource).not.toContain(">Notify</button>");
    expect(js).toContain("function toggleNotifications");
    expect(js).toContain("function toggleCompletionSound");
    expect(js).toContain("function syncCompletionSoundActivity");
    expect(js).toContain("function playCompletionSound");
    expect(js).toContain("function bindCompletionSoundUnlockGesture");
    expect(js).toContain("beep.type='square'");
    expect(js).toContain("beep.frequency.setValueAtTime(880");
    expect(js).toContain("output.gain.exponentialRampToValueAtTime(0.42");
    expect(js).toContain("COMPLETION_SOUND_PREF_KEY");
    expect(js).toContain("active_sessions_update");
    expect(js).toContain("syncCompletionSoundActivity();renderChatWorkingIndicator()");
    expect(js).toContain("localStorage.setItem(NOTIFICATION_PREF_KEY");
    expect(js).toContain("localStorage.setItem(COMPLETION_SOUND_PREF_KEY");
    expect(css).toContain(".notify-toggle.notifications-enabled");
    expect(css).toContain(".notify-toggle.notifications-enabled .notify-filled,.sound-toggle.sound-enabled .sound-filled{display:block}");
    expect(css).toContain(".sound-toggle.sound-enabled");
  });

  it("keeps secondary chat actions in the More menu", () => {
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const toolbar = pageSource.slice(pageSource.indexOf('<div class="chat-toolbar">'), pageSource.indexOf('<div class="control-grid" id="sessionControls">'));

    expect(toolbar).toContain('id="chatMoreMenu"');
    expect(toolbar).toContain('id="clearChatBtn"');
    expect(toolbar).toContain('id="syncBtn"');
    expect(toolbar).toContain('id="toggleToolsBtn"');
    expect(toolbar).toContain('Clears only the WebUI chat history shown for this session');
    expect(toolbar).toContain('Sync the current WebUI session controls');
    expect(toolbar).toContain('Show or hide the Tools / Plan sidebar');
    expect(toolbar.indexOf('id="clearChatBtn"')).toBeGreaterThan(toolbar.indexOf('id="chatMoreMenu"'));
    expect(toolbar.indexOf('id="clearChatBtn"')).toBeLessThan(toolbar.indexOf('id="syncBtn"'));
  });

  it("shows the active workspace right-aligned in the WebUI chat attachment row", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const attachmentStart = pageSource.indexOf('<div class="attachment-row">');
    const attachmentEnd = pageSource.indexOf('</div>', pageSource.indexOf('id="chatWorkspaceLine"'));
    const attachmentRow = pageSource.slice(attachmentStart, attachmentEnd);

    expect(pageSource).toContain('id="chatWorkspaceLine" class="chat-workspace-line" hidden');
    expect(pageSource.indexOf('id="messages"')).toBeLessThan(pageSource.indexOf('id="chatWorkspaceLine"'));
    expect(pageSource.indexOf('id="clearFilesBtn"')).toBeLessThan(pageSource.indexOf('id="chatWorkspaceLine"'));
    expect(pageSource.indexOf('id="chatWorkspaceLine"')).toBeLessThan(pageSource.indexOf('<div class="composer-actions">'));
    expect(attachmentRow).toContain('id="clearFilesBtn"');
    expect(attachmentRow).toContain('id="chatWorkspaceLine"');
    expect(js).toContain("function renderChatWorkspaceLine");
    expect(js).toContain("Workspace path copied");
    expect(js).toContain("Copy workspace path");
    expect(js).toContain("renderChatWorkspaceLine()");
    expect(js).not.toContain("chat-workspace-copy");
    expect(css).toContain(".chat-workspace-line{");
    expect(css).toContain(".attachment-row .chat-workspace-line{");
    expect(css).toContain("margin:0 0 0 auto");
    expect(css).not.toContain(".copy-id.chat-workspace-copy");
  });

  it("renders active sessions on the overview instead of the single current session panel", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const navSource = readFileSync("src/web/web-dashboard-ui.ts", "utf8");

    expect(pageSource).toContain("Active Sessions");
    expect(pageSource).toContain('id="activeSessionsCount"');
    expect(pageSource).toContain('id="activeSessionsTarget"');
    expect(pageSource).toContain('id="activeSessions"');
    expect(navSource).toContain('id="overviewActiveBadge"');
    expect(navSource).toContain('class="nav-badge" aria-hidden="true" hidden');
    expect(pageSource).not.toContain("Current Session");
    expect(js).toContain("function renderActiveSessions");
    expect(js).toContain("function updateActiveSessionsCount");
    expect(js).toContain("nordrelayActiveSessionsTarget");
    expect(js).toContain("function activeSessionsTargetItems");
    expect(js).toContain("compactControlMenu('activeSessionsNode',''");
    expect(js).toContain('data-control-menu="activeSessionsNode"] .control-menu-list');
    expect(js).toContain("if(openList&&!openList.hidden)return");
    expect(js).toContain("apiPeer(target.id,'/api/active-sessions')");
    expect(js).toContain("label:'All nodes'");
    expect(js).toContain("function activeSessionDurationHtml");
    expect(js).toContain("function updateActiveSessionDurationCounters");
    expect(js).toContain("state.activeSessionDurationTimer=setInterval");
    expect(js).toContain("data-active-duration-started");
    expect(js).toContain("badge.hidden=count<1");
    expect(js).toContain("updateActiveSessionsCount(state.activeSessions?.sessions||[])");
    expect(js).toContain("metricHtml('Workspace'");
    expect(js).toContain("metricHtml('Agent / Model'");
    expect(js).toContain("function sessionAgentModelText");
    expect(js).toContain("/api/active-sessions");
    expect(js).toContain("active_sessions_update");
    expect(js).toContain("function renderChatWorkingIndicator");
    expect(js).toContain("Working...");
    expect(js).toContain("id=\"chatWorkingElapsed\"");
    expect(js).toContain("function syncChatWorkingTimer");
    expect(js).toContain("function fmtChatWorkingElapsed");
    expect(readFileSync("src/runtime/relay-runtime-active-sessions.ts", "utf8")).toContain("right.durationMs - left.durationMs");
    expect(readFileSync("src/runtime/relay-runtime-active-sessions.ts", "utf8")).toContain("function safeActiveSessionList");
    expect(readFileSync("src/agents/shared/agent-activity.ts", "utf8")).toContain("snapshot = null");
    expect(readFileSync("src/runtime/relay-external-activity-monitor.ts", "utf8")).toContain("shouldIgnoreExternalTurn");
    expect(readFileSync("src/runtime/relay-external-activity-monitor.ts", "utf8")).toContain("message.source === \"cli\"");
    expect(css).toContain(".active-sessions-count");
    expect(css).toContain(".active-sessions-header");
    expect(css).toContain(".nav-badge{");
    expect(js).toContain("state.activeSessionsTimer=setInterval");
    expect(js).toContain("safe(loadActiveSessions)");
    expect(js).toContain("Prompt unavailable for process scan.");
    expect(js).toContain("Codex exec process");
  });

  it("renders compact chat lists and copy controls for chat messages", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const workflowsSource = readFileSync("src/web/ui/client/workflows.ts", "utf8");

    expect(js).toContain("function normalizeChatListSpacing");
    expect(js).toContain("function normalizeChatCodeBlockSpacing");
    expect(js).toContain('replace(/<\\/(ul|ol)>\\n+(?=\\S)/g');
    expect(js).toContain('replace(/(<\\/pre>)[ \\t]*\\n(?:[ \\t]*\\n)+/g');
    expect(js).toContain("chat-list-continuation");
    expect(js).toContain("start=\"'+start+'\"");
    expect(js).toContain("function chatMessageActionsHtml");
    expect(js).toContain("function chatMessageClass");
    expect(js).toContain("function isChatUserPromptMessage");
    expect(js).toContain("message?.source==='cli'&&/^Working on\\b/i");
    expect(js).toContain("data-message-index");
    expect(js).toContain("function chatMessageAttachmentsHtml");
    expect(js).toContain("function hydrateChatAttachments");
    expect(js).toContain("api('/api/chat/attachment'");
    expect(css).toContain(".chat-attachment-image");
    expect(js).toContain("function bindChatMessageActionButtons");
    expect(js).toContain("queue:cancel");
    expect(js).toContain("!currentAgentMessage||!currentAgentMessage.isConnected");
    expect(js).toContain("function retryChatMessage");
    expect(js).toContain("Message copied");
    expect(js).toContain("Retry message");
    expect(js).toContain("await api('/api/prompt',{method:'POST',body:{text,correlationId:createWebCorrelationId()}})");
    expect(js).toContain("if(r.queued&&r.queueId)appendQueuedMessage(r.queueId,r.correlationId)");
    expect(js).toContain("'.message-retry-button','prompt.send'");
    expect(pageSource).not.toContain('id="retryBtn"');
    expect(pageSource).toContain("Requires browser microphone permission");
    expect(workflowsSource).toContain("function ensureMicrophoneRecordingAvailable");
    expect(workflowsSource).toContain("Microphone access requires HTTPS or localhost");
    expect(workflowsSource).toContain("Microphone access is blocked for this site");
    expect(workflowsSource).toContain("lock/site controls");
    expect(workflowsSource).toContain("Your browser should show a microphone permission prompt");
    expect(workflowsSource).toContain("permission==='prompt'");
    expect(workflowsSource).toContain("function transcribeVoiceNote");
    expect(workflowsSource).toContain("function insertPromptTranscript");
    expect(workflowsSource).toContain("function currentAgentSupportsRawAudioAttachments");
    expect(workflowsSource).toContain("'pi','hermes','openclaw'");
    expect(workflowsSource).toContain("transcribeOnly:true");
    expect(workflowsSource).toContain("Voice transcribed");
    expect(workflowsSource).toContain("Voice transcription failed; audio attached instead");
    expect(workflowsSource).toContain("audio was not attached for");
    expect(workflowsSource).not.toContain("if(permission==='denied')throw new Error(microphoneBlockedMessage())");
    expect(css).toContain(".message{position:relative;width:fit-content;max-width:92%");
    expect(css).toContain("padding:10px 106px 10px 12px");
    expect(css).toContain(".message.user,.message.user-prompt{max-width:min(88%,calc(100% - 36px));margin-left:auto;margin-right:0");
    expect(css).toContain(".message.user,.message.user-prompt{max-width:calc(100% - 24px);margin-left:auto;margin-right:0");
    expect(css).toContain(".message-body{white-space:pre-wrap;font-size:14px;line-height:1.45}");
    expect(css).toContain(".message-copy-button");
    expect(css).toContain(".message-retry-button{right:70px}");
    expect(css).toContain(".message-retry-button::before");
    expect(css).toContain("box-sizing:border-box;width:10px;height:12px");
    expect(css).toContain(".message-copy-button::before{left:9px;top:6px}");
    expect(css).toContain(".message-copy-button::after{left:7px;top:8px}");
    expect(css).toContain(".message:hover .message-action-button");
    expect(css).toContain(".message .chat-list-continuation");
  });

  it("persists unsent WebUI chat drafts per chat tab", () => {
    const js = dashboardJs();
    const chatTabsSource = readFileSync("src/web/ui/client/chat-tabs.ts", "utf8");
    const runtimeSource = readFileSync("src/web/ui/client/core/runtime.ts", "utf8");
    const eventsSource = readFileSync("src/web/ui/client/events.ts", "utf8");

    expect(chatTabsSource).toContain("draft: raw?.draft ? String(raw.draft) : ''");
    expect(chatTabsSource).toContain("function bindPromptDraftPersistence");
    expect(chatTabsSource).toContain("const CHAT_TAB_DRAFT_STORAGE_PREFIX = 'nordrelayChatDraft:'");
    expect(chatTabsSource).toContain("function readChatTabDraft");
    expect(chatTabsSource).toContain("function writeChatTabDraft");
    expect(chatTabsSource).toContain("input.addEventListener('input', saveActiveChatTabDraft)");
    expect(chatTabsSource).toContain("window.addEventListener('pagehide', saveActiveChatTabDraft)");
    expect(chatTabsSource).toContain("window.addEventListener('beforeunload', saveActiveChatTabDraft)");
    expect(chatTabsSource).toContain("if (document.hidden) saveActiveChatTabDraft()");
    expect(chatTabsSource).toContain("input.value = readChatTabDraft(tab)");
    expect(chatTabsSource).toContain("bindPromptDraftPersistence();");
    expect(runtimeSource).toContain("if(state.currentPage==='chat')saveActiveChatTabDraft()");
    expect(runtimeSource).toContain("if(input&&!input.value)restoreActiveChatTabDraft()");
    expect(eventsSource).toContain("input.dispatchEvent(new Event('input',{bubbles:true}))");
    expect(js).toContain("nordrelayChatTabs");
    expect(js).toContain("nordrelayChatDraft:");
    expect(js).toContain("function saveActiveChatTabDraft");
    expect(js).toContain("function restoreActiveChatTabDraft");
  });

  it("uses a friendly dashboard API network failure message", () => {
    const js = dashboardJs();

    expect(js).toContain("function fetchApi");
    expect(js).toContain("NordRelay API is unreachable. Check that the dashboard is still running, then reload the page.");
    expect(js).not.toContain("await fetch(url.pathname + url.search");
  });

  it("refreshes stale dashboard auth state instead of rendering CSRF as a peer error", () => {
    const js = dashboardJs();

    expect(js).toContain("function handleApiResponse");
    expect(js).toContain("function shouldRefreshDashboardForAuth");
    expect(js).toContain("function waitForDashboardAuthState");
    expect(js).toContain("await handleApiResponse<P>(await retry(), undefined, true)");
    expect(js).toContain("res.status === 401");
    expect(js).toContain("res.status !== 403");
    expect(js).toContain("/csrf/i.test(apiErrorMessage(data, ''))");
    expect(js).toContain("AUTH_REFRESH_STORAGE_KEY");
    expect(js).toContain("Dashboard session changed. Waiting for NordRelay API...");
    expect(js).toContain("NordRelay is restarting. Actions will resume when the API is reachable.");
    expect(js).not.toContain("location.reload()");
  });

  it("allows every dashboard dialog to close from backdrop clicks", () => {
    const js = dashboardJs();

    expect(js).toContain("function bindDialogBackdropClose");
    expect(js).toContain("function isDialogBackdropClick");
    expect(js).toContain("event.target.close()");
  });

  it("binds version agent update buttons after rendering version cards", () => {
    const js = dashboardJs();
    const runtimeSource = readFileSync("src/runtime/relay-runtime-updates-jobs.ts", "utf8");
    const operationsSource = readFileSync("src/support/operations.ts", "utf8");

    expect(js).toContain("data-update-agent");
    expect(js).toContain("updateOperation");
    expect(js).toContain("Install");
    expect(js).toContain("data-update-delete-log");
    expect(js).toContain("Delete Log");
    expect(js).toContain("data.stateDisabled='true'");
    expect(js).toContain("const stateDisabled=el.dataset.stateDisabled==='true'");
    expect(js).not.toContain("data-update-log");
    expect(js).toContain("function renderVersionTable");
    expect(js).toContain('class="data-table version-table"');
    expect(js).not.toContain("versionPanel').innerHTML='<div class=\"version-grid\"");
    expect(js).toContain("bindAgentUpdateButtons();applyPermissions()");
    expect(js).toContain("const delays=[500,2000,5000,10000]");
    expect(runtimeSource).toContain("clearAgentCliVersionCache(job.agentId, runtime.cliPathOptions())");
    expect(runtimeSource).toContain('runtime.dashboardService.invalidate("version")');
    expect(runtimeSource).toContain('runtime.dashboardService.invalidate("adapterHealth")');
    expect(operationsSource).toContain("export function clearAgentCliVersionCache");
  });

  it("loads dashboard CSS and JavaScript through static asset routes", () => {
    const serverSource = readFileSync("src/web/web-dashboard.ts", "utf8");
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const buildSource = readFileSync("scripts/build-web-assets.mjs", "utf8");

    expect(serverSource).toContain('/assets/dashboard.css');
    expect(serverSource).toContain('/assets/dashboard.js');
    expect(serverSource).toContain('/assets/logo.png');
    expect(serverSource).toContain('/favicon.ico');
    expect(pageSource).toContain('href="/assets/dashboard.css?v=');
    expect(pageSource).toContain('href="/favicon.ico"');
    expect(pageSource).toContain('src="/assets/logo.png"');
    expect(pageSource).toContain('id="brandHomeBtn"');
    expect(pageSource).toContain('aria-label="Open overview"');
    expect(pageSource).toContain('class="footer-label">Connection:</span>');
    expect(pageSource).toContain('width="44" height="44"');
    expect(pageSource).toContain('class="brand-separator"');
    expect(pageSource).toContain('src="/assets/dashboard.js?v=');
    expect(pageSource).not.toContain("<style>${dashboardCss()}</style>");
    expect(pageSource).not.toContain("<script>${dashboardJs()}</script>");
    expect(dashboardCss()).toContain("--sidebar-border:#2a3a30");
    expect(dashboardCss()).toContain("--scrollbar-thumb:#b6c5b8");
    expect(dashboardCss()).toContain("--scrollbar-thumb:#3a4c40");
    expect(dashboardCss()).toContain("scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(dashboardCss()).toContain(".brand-separator{height:1px;background:var(--sidebar-border)");
    expect(dashboardCss()).toContain("button.brand-home{width:100%;min-height:calc(var(--dashboard-header-height) - 1px)");
    expect(dashboardCss()).toContain(".footer-connection{font-weight:650}");
    expect(dashboardCss()).toContain(".footer-label{color:var(--muted);font-weight:400}");
    expect(dashboardJs()).toContain("document.getElementById('brandHomeBtn').onclick=()=>page('overview')");
    expect(dashboardJs()).toContain("footerHealthLabel");
    expect(dashboardJs()).toContain("footer-profile-link");
    expect(dashboardJs()).toContain("el.innerHTML='<span class=\"footer-label\">Connection:</span>");
    expect(dashboardCss()).toContain(".sidebar{position:sticky;top:0;height:100vh");
    expect(dashboardCss()).toContain("height:calc(var(--dashboard-header-height) - 1px);padding:0 18px");
    expect(dashboardCss()).toContain("input,select,textarea{font-size:15px}");
    expect(dashboardCss()).toContain(".workflow-builder-json textarea{width:100%;min-width:0;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}");
    expect(buildSource).toContain('process.env.NORDRELAY_WEBUI_MINIFY !== "false"');
    expect(buildSource).toContain("minify: minifyAssets");
    expect(buildSource).toContain("gzipSync(body, { level: 9 })");
    expect(buildSource).toContain("brotliCompressSync(body");
    expect(serverSource).toContain("dashboardBundleAsset");
    expect(serverSource).toContain("private, max-age=31536000, immutable");
  });

  it("resolves WebUI logo and favicon assets from source files", () => {
    expect(dashboardStaticAsset("logo.png")?.contentType).toBe("image/png");
    expect(dashboardStaticAsset("favicon.png")?.contentType).toBe("image/png");
    expect(dashboardStaticAsset("favicon.ico")?.contentType).toBe("image/x-icon");
  });

  it("resolves precompressed dashboard bundles when built assets exist", () => {
    const jsAsset = dashboardBundleAsset("dashboard.js");
    const cssAsset = dashboardBundleAsset("dashboard.css");

    if (jsAsset && cssAsset) {
      expect(jsAsset.brotliPath).toContain("dashboard.js.br");
      expect(jsAsset.gzipPath).toContain("dashboard.js.gz");
      expect(cssAsset.brotliPath).toContain("dashboard.css.br");
      expect(cssAsset.gzipPath).toContain("dashboard.css.gz");
    }
  });

  it("guards dashboard stream and session data with scoped user access", () => {
    const source = readFileSync("src/web/web-dashboard.ts", "utf8");
    const sessionRoutes = readFileSync("src/web/web-dashboard-session-routes.ts", "utf8");

    expect(source).toContain('users.hasPermission(authUser, "sessions.read")');
    expect(source).toContain("scopeRelayEvent(authUser, event, canUseCurrentSession)");
    expect(sessionRoutes).toContain("assertSessionDetailScope(authUser, threadId, detail)");
    expect(sessionRoutes).toContain("scopedSessionPage(authUser, page)");
    expect(sessionRoutes).toContain("filterActivityByScope(authUser");
  });

  it("includes first-run admin setup guarded by a setup token", () => {
    const source = readFileSync("src/web/web-dashboard.ts", "utf8");
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");

    expect(source).toContain("firstRunSetupToken");
    expect(source).toContain("/api/setup/admin");
    expect(source).toContain("firstRunSetupTokenError");
    expect(pageSource).toContain("NordRelay Setup");
    expect(pageSource).toContain("setupToken");
  });

  it("includes account profile APIs and header profile controls", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(contract).toContain('exact("/api/profile"');
    expect(contract).toContain('exact("/api/profile/password"');
    expect(contract).toContain('exact("/api/profile/logout-other-sessions"');
    expect(pageSource).toContain('id="userMenuBtn"');
    expect(pageSource).toContain('id="profileDialog"');
    expect(pageSource).toContain('id="profileThemeSelect"');
    expect(js).toContain("function applyAccountChrome");
    expect(js).toContain("/api/profile/logout-other-sessions");
    expect(js).toContain("applyThemePreference(accountTheme||savedThemePreference()");
    expect(js).toContain("local:true");
    expect(css).toContain(".account-menu-panel");
    expect(css).toContain(".profile-grid");
  });

  it("composes dashboard assets from focused WebUI modules", () => {
    expect(readFileSync("src/web/ui/client/core/api-client.ts", "utf8")).toContain("async function api");
    expect(readFileSync("src/web/ui/client/core/runtime.ts", "utf8")).toContain("const state");
    expect(readFileSync("src/web/ui/client/core/components.ts", "utf8")).toContain("function uiItem");
    expect(readFileSync("src/web/ui/client/profile.ts", "utf8")).toContain("function openProfileDialog");
    const headerTarget = readFileSync("src/web/ui/client/header-target.ts", "utf8");
    const overview = readFileSync("src/web/ui/client/overview.ts", "utf8");
    expect(overview).toContain("function renderSnapshot");
    expect(headerTarget).toContain("function headerThreadCopyButton");
    expect(headerTarget).toContain('title="Copy thread ID"');
    expect(headerTarget).toContain("bindUiCopyButtons(line)");
    expect(overview).toContain("function renderChatWorkspaceLine");
    expect(overview).toContain("Workspace path copied");
    const workflows = readFileSync("src/web/ui/client/workflows.ts", "utf8");
    expect(workflows).toContain("function loadSessions");
    expect(workflows).toContain("function sessionDetailNodeLabel");
    expect(workflows).toContain("headerTargetName(peerId)");
    expect(readFileSync("src/web/ui/client/jobs.ts", "utf8")).toContain("function renderUnifiedJobs");
    const metrics = readFileSync("src/web/ui/client/metrics.ts", "utf8");
    const components = readFileSync("src/web/ui/styles/components.css", "utf8");
    const pages = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    expect(metrics).toContain("function loadMetrics");
    expect(metrics).toContain("function metricKvCard");
    expect(metrics).toContain("function metricWebRoutesTable");
    expect(metrics).toContain("function metricRateLimitTable");
    expect(metrics).toContain("function formatUptime");
    expect(metrics).toContain("if(hours<24)return hours+'h '+(min%60)+'m'");
    expect(metrics).toContain("return Math.floor(hours/24)+'d '+(hours%24)+'h'");
    expect(metrics).toContain("function setMetricsAutoRefresh");
    expect(metrics).not.toContain("['Generated'");
    expect(components).toContain(".metric-kv{display:grid");
    expect(components).toContain(".metrics-section-header,.diagnostics-section-header{margin-bottom:12px}");
    expect(components).toContain(".metric-kv-label,.metric-kv-value{display:flex;align-items:center;min-width:0;min-height:32px;padding:6px 0");
    expect(components).toContain(".metric-kv-number,.metrics-table td{font-size:14px}");
    expect(components).toContain(".metrics-table");
    expect(components).toContain(".diagnostics-grid{margin-top:12px}");
    expect(components).toContain(".diagnostics-overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}");
    expect(components).toContain(".diagnostics-single-grid{grid-template-columns:minmax(0,1fr)}");
    expect(components).toContain(".metrics-tab,.diagnostics-tab{display:none}");
    expect(pages).toContain('class="section-header adapter-section-header"');
    expect(pages).toContain('class="section-header metrics-section-header"');
    expect(pages).toContain('data-metrics-tab="web"');
    expect(pages).toContain('id="metricsAutoRefresh"');
    expect(pages).toContain('class="section-header diagnostics-section-header"');
    expect(pages).toContain('id="diagnosticsTabs"');
    expect(pages).toContain('data-diagnostics-tab="channels"');
    expect(pages).toContain('data-diagnostics-tab="voice"');
    expect(pages).toContain('id="settingsSearchInput"');
    expect(pages).toContain('class="settings-navigator"');
    expect(pages).toContain('class="setting-info session-workspace-mode-help"');
    expect(pages).toContain('Isolated worktree creates a separate Git worktree');
    expect(readFileSync("src/web/ui/styles/layout.css", "utf8")).toContain(".form-label-title{display:inline-flex;align-items:center;gap:6px;min-width:0}");
    const settingsPanel = readFileSync("src/web/ui/client/settings-panel.ts", "utf8");
    expect(settingsPanel).toContain("function renderSettingsNavigator");
    expect(settingsPanel).toContain("function renderSettingsSearchResults");
    expect(settingsPanel).toContain("state.settingsDraft");
    expect(components).toContain(".settings-layout{display:grid");
    expect(components).toContain(".settings-nav-category");
    const users = readFileSync("src/web/ui/client/users.ts", "utf8");
    expect(users).toContain("function renderUserManagementV2");
    expect(users).toContain("function renderUsersTable");
    expect(users).toContain("class=\"data-table access-users-table\"");
    expect(users).toContain("class=\"data-table access-groups-table\"");
    expect(users).toContain("class=\"data-table access-channels-table\"");
    const adminAccess = readFileSync("src/web/ui/client/admin-access.ts", "utf8");
    expect(adminAccess).toContain("function renderLocksTable");
    expect(adminAccess).toContain("function renderAuditTable");
    expect(adminAccess).toContain("class=\"data-table access-locks-table\"");
    expect(adminAccess).toContain("class=\"data-table access-audit-table\"");
    const adminMarker = readFileSync("src/web/ui/client/admin.ts", "utf8");
    expect(adminMarker).toContain("Admin WebUI logic is split");
    const webuiGlobals = readFileSync("src/web/ui/client/webui-globals.d.ts", "utf8");
    expect(webuiGlobals).toContain("declare const state: DashboardState");
    expect(webuiGlobals).toContain("declare const activityPager: WebuiPager");
    expect(webuiGlobals).not.toContain("declare const state: any");
    const diagnostics = readFileSync("src/web/ui/client/diagnostics.ts", "utf8");
    expect(diagnostics).toContain("function diagnosticsHtml");
    expect(diagnostics).toContain("function switchDiagnosticsTab");
    expect(diagnostics).toContain("function bindDiagnosticsTabs");
    expect(diagnostics).toContain("function diagnosticsTabPanel");
    expect(diagnostics).toContain("function diagnosticsVoiceRows");
    expect(diagnostics).toContain("diagnostics-grid");
    expect(diagnostics).toContain("diagnostics-single-grid");
    expect(diagnostics).toContain("diagnostics-overview-grid");
    expect(diagnostics).toContain("metricKvCard('Overview'");
    expect(readFileSync("src/web/ui/styles/theme.css", "utf8")).toContain(":root");
    expect(readFileSync("src/web/ui/styles/layout.css", "utf8")).toContain(".chat-layout");
  });

  it("includes peer discovery and peer health history in the WebUI", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(pageSource).toContain('id="peerTabs"');
    expect(pageSource).toContain('data-peer-tab="status"');
    expect(pageSource).toContain('data-peer-tab-panel="discovery"');
    expect(pageSource).toContain("Discover LAN peers");
    expect(pageSource).toContain('id="peerDiscovery"');
    expect(js).toContain("function switchPeerTab");
    expect(js).toContain("data-peer-tab-panel");
    expect(js).toContain("function discoverPeers");
    expect(js).toContain("function openPeerDebugDialog");
    expect(js).toContain("function bindTableActionMenus");
    expect(js).toContain("function positionTableActionMenu");
    expect(js).toContain("bindTableActionMenus(document.getElementById('peersList')");
    expect(js).toContain("/debug/probe");
    expect(js).toContain("Peer debug");
    expect(js).toContain("/api/peers/discover");
    expect(js).toContain("Health history");
    expect(css).toContain(".peer-tab");
    expect(css).toContain(".peer-debug-panel");
    expect(css).toContain(".table-action-menu.is-floating .table-action-menu-list");
    expect(css).toContain("position:fixed");
    expect(contract).toContain('exact("/api/peers/discover"');
    expect(contract).toContain('/api/peers/:id/debug');
  });

  it("normalizes dashboard control typography across platforms", () => {
    const layout = readFileSync("src/web/ui/styles/layout.css", "utf8");
    const components = readFileSync("src/web/ui/styles/components.css", "utf8");

    expect(layout).toContain("line-height:1.4");
    expect(layout).toContain("button{appearance:none");
    expect(layout).toContain("display:inline-flex");
    expect(layout).toContain(".control-grid{display:flex");
    expect(layout).toContain("align-items:flex-end");
    expect(layout).toContain(".control-menu-button");
    expect(layout).toContain(".control-menu-list");
    expect(layout).toContain("nav button{display:flex");
    expect(layout).toContain(".badge,.adapter-status{display:inline-flex");
    expect(layout).toContain(".adapter-status{margin-left:0");
    expect(components).toContain(".chip{display:inline-flex");
    expect(components).toContain(".mini-button{min-height:26px");
    expect(components).toContain(".log-view{max-height:min(64vh,720px);min-height:320px;font-size:14px");
    expect(components).toContain(".version-table th:nth-child(7)");
    expect(layout).toContain(".metric .value{font-size:18px");
  });

  it("renders parseable permission-aware dashboard JavaScript", () => {
    const js = dashboardJs();

    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain("function assertApiRoute");
    expect(js).toContain("function applyPermissions");
    expect(js).toContain("function can(permission)");
    expect(js).toContain("disabledAttr('queue.write')");
    expect(js).toContain("Permission required: users.read");
  });
});
