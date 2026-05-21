# Workflows

Workflows turn repeatable prompt sequences into versioned templates and runs.

## Templates

Templates define reusable prompt bodies with variables. They can be inserted into the WebUI chat or run as workflow steps.

## Workflow builder

The WebUI builder avoids raw JSON editing. It supports:

- prompt steps
- variables
- reusable subflows
- conditions
- retry policies
- manual approval steps
- scheduled or periodic runs
- fixed workflow versions

## Versions and history

Workflow edits create snapshots. You can compare versions, roll back, and run against a fixed version for reproducibility.

## Queue integration

Workflows can route steps through the same runtime queue as normal prompts, so a busy session is not interrupted.

## Peer routing

Workflow steps can target a local agent or a trusted peer node, subject to peer scopes and workspace allow-lists.
