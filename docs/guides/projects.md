# Projects

Projects group a workspace, related sessions, an editable codebase summary, and a prioritized development plan in the login-protected WebUI.

Use Projects when several sessions work on the same repository or when you want NordRelay to keep a maintained "what is this project and what should happen next" view.

## What a Project Stores

A project stores:

- name and description
- workspace path
- target node label
- default agent
- linked session references
- editable summary Markdown
- editable plan Markdown
- summary and plan revision history
- parsed plan items when the plan includes structured JSON
- background analysis jobs

Project definitions are stored on the local NordRelay node in `~/.nordrelay` using the configured state backend.

## Create a Project

Open **Projects** in the WebUI and choose **Create project**.

Set:

- **Name**: short project name
- **Workspace path**: repository or workspace path to analyze
- **Default agent**: agent used for summary and planning runs
- **Target**: local node or a peer label for organization

Remote sessions can be linked to a project, but project definitions and analysis jobs are managed from the local node.

## Link Sessions

Open the **Sessions** tab inside Projects.

- **Link selected session** adds the session currently selected in the WebUI header.
- **Link manually** lets you add a thread ID, agent, peer ID, label, and workspace.

Linked sessions make it easier to find the active threads connected to a project without changing the underlying agent context.

## Generate a Summary

Open the **Summary** tab and choose **Generate summary**.

NordRelay starts a background agent run in the project workspace. The run asks the agent to inspect the current code, docs, package metadata, and runtime entry points before writing a compact Markdown summary.

The generate dialog includes a **Language** field. It defaults to `English`, but you can enter any language that should be used for the generated summary.

The summary remains editable. Use **Save summary** after manual edits.

Each generated or manually saved summary is stored as a revision. Use **History** to open older summaries, edit revision titles/content, restore an older revision as the current summary, or delete revisions you no longer need.

## Generate a Plan

Open the **Plan** tab and choose **Generate plan**.

The planning prompt uses the current editable project summary and asks the agent to re-check the latest code before recommending work. The generated plan should avoid duplicate suggestions for features that already exist.

The generate dialog includes a **Language** field. It defaults to `English`, but you can enter any language that should be used for the generated plan.

The generate dialog lets you choose the planning style:

- **Balanced roadmap** mixes features, quality, reliability, and release risk.
- **New features** biases the plan toward new user-facing or workflow capabilities.
- **Bug fixes** searches for likely defects, edge cases, regressions, and missing defensive checks.
- **Code quality / refactoring** focuses on maintainability and module boundaries.
- **Performance / scalability** targets CPU, polling, I/O, network, cache, startup, and large-data behavior.
- **Security / permissions** reviews access control, secrets, auditability, peers, plugins, and safe defaults.
- **UX / WebUI** focuses on interface and workflow improvements.
- **Tests / CI / docs** looks for missing confidence in automation and documentation.
- **Release readiness** focuses on packaging, install/update reliability, migrations, docs, and operational checks.

You can also select a planning horizon and risk posture. NordRelay intentionally does not ask for a fixed number of items; the agent should propose the amount of work justified by the current code evidence.

If the final answer includes a `nordrelay-project-plan` JSON block, NordRelay parses it into plan items with priority, category, target area, user value, evidence, effort, risk, blockers, confidence, and existing-feature checks.

Each generated or manually saved plan is stored as a revision. Use **History** to open older plans, edit revision titles/content, restore an older revision as the current plan, or delete revisions you no longer need. Restoring a plan also restores the parsed plan items from that revision.

## Jobs

The **Jobs** tab shows summary and planning runs with status, agent, thread ID, and the latest log line. Project jobs also appear in the global job/activity surfaces.

## Permissions

Projects use dedicated permissions:

- `projects.read`: read projects and project jobs
- `projects.write`: create, edit, delete, link sessions, and save summary/plan text
- `projects.run`: start or cancel summary and plan generation jobs

Admins receive these permissions automatically. Normal users can be granted them without giving full workflow or peer administration access.
