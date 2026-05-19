# Security and Troubleshooting

## Security Notes

- Create the first admin user during setup and keep that account protected with a strong password.
- Link Telegram accounts only to active NordRelay users that should control agents remotely.
- Enable Telegram group/forum chats only when the whole chat context is trusted for the permissions granted to linked users.
- Review group permissions before granting `prompt.send`, `prompt.abort`, `files.write`, `settings.write`, `updates.run`, `system.restart`, or `users.write`.
- Review peer scopes before granting `peers.write`, `peers.connect`, broad `prompt.send`, or unrestricted workspace roots to a paired instance.
- Treat `danger-full-access` as equivalent to shell access on the host.
- Treat uploaded files as untrusted input. They are staged inside the active workspace so the selected sandbox policy still matters.
- Keep `CODEX_API_KEY`, `HERMES_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`, and `OPENAI_API_KEY` in `~/.nordrelay/nordrelay.env` or host secret management.
- In group chats, remember that any linked user with prompt permissions can prompt the selected agent in that chat context.
- Use `TOOL_VERBOSITY=summary` or `errors-only` when command output may include sensitive data.
- Review and unsafe launch profiles add a Telegram approve/deny gate before each turn starts.
- Keep the peer API disabled unless needed. For internet use, expose it only through a firewall, VPN, or hardened reverse proxy; keep TLS enabled and revoke unused peers with `nordrelay peer revoke <peer-id>`.


## Troubleshooting

Polling conflict:

- Symptom: Telegram reports conflict or only one connector receives messages.
- Cause: the same bot token is being polled by another process.
- Fix: stop the other process or run `npm stop`, then `npm start`.

Stale plugin cache:

- Symptom: Codex uses old command or skill text after a repo update.
- Fix: reinstall/update the local marketplace or copy the plugin directory into the Codex plugin cache.
- Current local cache path: `~/.codex/plugins/cache/nordrelay-local/nordrelay/<version>/`.

Missing dependencies:

- Symptom: startup says runtime is missing.
- Fix:

```bash
npm install
npm run build
```

Auth failures:

- Symptom: prompt execution says Codex is not authenticated.
- Fix: run `codex login` on the host, use `/login`, or set `CODEX_API_KEY`.
- Use `/auth` to check the current auth method.

No sessions listed:

- Symptom: `/sessions` says no recent threads found.
- Cause for Codex: `~/.codex/state_*.sqlite` is missing, unreadable, or has no active threads.
- Cause for Pi: `~/.pi/agent/sessions/` or `PI_SESSION_DIR` is missing, unreadable, or has no session JSONL files.
- Cause for Hermes: `~/.hermes/state.db` or `HERMES_STATE_DB_PATH` is missing, unreadable, or has no session rows.
- Cause for OpenClaw: `openclaw sessions --all-agents --json` returns no sessions, or `OPENCLAW_HOME`/`OPENCLAW_STATE_DIR` points at the wrong state location.
- Cause for Claude Code: `~/.claude/projects/` or `CLAUDE_CONFIG_DIR/projects` is missing, unreadable, or has no session JSONL files.
- Fix: run the selected agent locally once, resume or create a session, then try `/sessions` again.

Wrong model, reasoning, or fast mode after switching:

- The connector reads model, reasoning, workspace, sandbox, and approval metadata from supported local agent state on `/sessions`, `/switch`, `/attach`, and `/session`; Codex fast mode is read from `~/.codex/config.toml`.
- For Pi, the connector reads model/thinking from Pi JSONL sessions and refreshes active RPC state when a session is running.
- For Hermes, the connector reads model, reasoning, token usage, and message activity from Hermes `state.db`; `/model` and `/reasoning` values are sent with future API runs.
- For OpenClaw, the connector reads model, thinking, token usage, and activity from OpenClaw session state; `/model` and `/reasoning` values are sent with future Gateway runs.
- For Claude Code, the connector reads model, effort, token usage, and activity from Claude Code transcript JSONL files; `/model` and `/reasoning` values are sent with future SDK runs.
- If values look stale, make sure the selected local CLI has finished writing session state.

Pi not available:

- Symptom: `/agent` cannot switch to Pi, or startup says Pi CLI is missing.
- Fix: install Pi from https://pi.dev/, ensure `pi` is on `PATH`, or set `PI_CLI_PATH`.
- Enable Pi with `NORDRELAY_PI_ENABLED=true`.

Hermes not available:

- Symptom: `/agent` cannot switch to Hermes, `/auth` fails, or prompt execution says the Hermes API request failed.
- Fix: start the Hermes API Server, ensure `HERMES_API_BASE_URL` points to it, and set `HERMES_API_KEY` if the server requires a key.
- Enable Hermes with `NORDRELAY_HERMES_ENABLED=true`.

OpenClaw not available:

- Symptom: `/agent` cannot switch to OpenClaw, `/auth` fails, or prompt execution says the OpenClaw Gateway request failed.
- Fix: start the OpenClaw Gateway, ensure `OPENCLAW_GATEWAY_URL` points to it, and set `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` if the Gateway requires shared-secret auth.
- Enable OpenClaw with `NORDRELAY_OPENCLAW_ENABLED=true`.

Claude Code not available:

- Symptom: `/agent` cannot switch to Claude Code, `/auth` fails, or prompt execution says Claude Code auth is missing.
- Fix: run `claude auth login` on the host, ensure `claude` is on `PATH`, or set `CLAUDE_CODE_CLI_PATH`.
- Enable Claude Code with `NORDRELAY_CLAUDE_CODE_ENABLED=true`.

Voice not working:

- Run `/voice` to list available backends.
- Install `ffmpeg` and `faster-whisper` on Linux, install local Cohere Transcribe dependencies for Hugging Face transcription, install `parakeet-coreml` on macOS Apple Silicon, or set `OPENAI_API_KEY`.
- Check `~/.nordrelay/nordrelay.log` for transcription errors.

Files not returned:

- Ensure Codex writes generated files to `.nordrelay/turns/<turn-id>/out/`.
- Files over 50 MB are skipped.
- Hidden files, temp files, and directories are ignored.
- Use `ARTIFACT_IGNORE_DIRS` and `ARTIFACT_IGNORE_GLOBS` to suppress project-specific build/cache output.
- Automatic artifact sending stays off unless `TELEGRAM_AUTO_SEND_ARTIFACTS=true`; `/artifacts` can still list and resend indexed outputs.
