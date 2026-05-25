# Remote and session workflows

NordRelay can operate sessions started from the WebUI, a chat adapter, an external CLI, or a trusted peer.

## Start in the WebUI

Open **Chat**, choose a node and agent, then create a new session. The modal lets you select workspace mode and the workspace path when supported.

## Attach to existing sessions

Use **Sessions** or `/sessions` in chat to switch to a known thread. NordRelay tracks metadata such as agent, workspace, model, reasoning, launch profile, activity, queue, and mirror preferences.

For chat adapters, `/sessions` uses the node selected for that chat context. Run `/nodes` to choose between the local node and a trusted peer before browsing sessions. The session list shows the selected node and agent in its heading.

## External CLI sessions

NordRelay can discover active CLI sessions and show them under **Overview**. If a CLI turn is active, the WebUI can show `Working...`, queue new prompts, mirror output, and surface approval prompts where supported.

## Queue when busy

If a session is already processing a prompt, a new prompt is queued instead of colliding with the running turn. Queue entries can be cancelled, reordered, paused, resumed, or promoted depending on the surface.

## Worktree isolation

Set:

```dotenv
NORDRELAY_SESSION_WORKSPACE_MODE=worktree
```

New sessions can receive their own Git worktree and branch. This allows several sessions to work on the same repository without seeing each other's incomplete edits.

Use **Sessions > Worktrees** as the review center for completed work:

- Select committed worktrees and open **Preview integration** to see risk level, same-file changes, overlapping line ranges, warnings, and a guided conflict resolver.
- Use **Compare diffs** for side-by-side branch diffs before merging.
- Use **Export patches** to download the patch bundle, review summary, risk JSON, and PR command notes.
- Use **Integrate selected** only after resolving or accepting the preview risk. NordRelay creates an integration worktree/branch first, then you can finalize it back into the source repository.

## Peered sessions

When peer federation is enabled, a local WebUI can list and control sessions from trusted nodes. Peer access is scoped by the invitation and stored peer permissions.

In chat adapters, use `/nodes` to select a peer node, then `/sessions` to browse that peer's sessions for the selected agent. Use `/target local` to return the chat context to the local node.
