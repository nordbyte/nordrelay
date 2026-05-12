# Contributing

Thanks for contributing to NordRelay.

## Development Setup

Requirements:

- Node.js 22 or newer
- npm
- A local Codex CLI setup for runtime testing

Install dependencies:

```bash
npm install
```

Run the standard checks:

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

## Pull Requests

Before opening a pull request:

- Keep changes focused on one feature or fix.
- Add or update tests for behavior changes.
- Update `README.md` when commands, environment variables, setup, or security behavior changes.
- Do not commit `.env`, `.nordrelay/`, `dist/`, `node_modules/`, local Codex state, Telegram downloads, logs, or generated workspace artifacts.
- Use placeholder credentials in docs and tests.

## Security-Sensitive Changes

Be conservative with defaults. Fresh installs must not expose the bot publicly:

- Keep `TELEGRAM_ADMIN_USER_IDS` required.
- Keep `TELEGRAM_ALLOW_ANY_CHAT=false` by default.
- Do not add examples that use real bot tokens, chat ids, API keys, or private paths.
- Redact secrets in new logs, diagnostics, and Telegram output.

## Coding Style

- TypeScript source lives in `src/`.
- Tests live in `test/` and use Vitest.
- Keep runtime behavior explicit and documented.
- Prefer focused helpers over large abstractions unless they reduce real duplication.
