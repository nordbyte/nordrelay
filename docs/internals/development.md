# Development

## Install

```bash
git clone https://github.com/nordbyte/nordrelay.git
cd nordrelay
npm install
```

## Build

```bash
npm run build
```

The build compiles TypeScript, generates Web API route metadata, and builds minified WebUI assets.

## Checks

```bash
npm run check
npm test
npm run security:audit
```

`npm run test:e2e` runs Playwright tests.

## Run from source

```bash
npm run foreground
```

or:

```bash
node plugins/nordrelay/scripts/nordrelay.mjs web
```

## Docs

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

Docs use VitePress installed with `docs:prepare` as a no-save dependency, matching the repository policy of avoiding an extra persistent docs dependency.

## Generated files

Generated outputs are ignored:

- `dist/`
- `coverage/`
- `test-results/`
- `playwright-report/`
- `docs/.vitepress/cache/`
- `docs/.vitepress/dist/`
- local runtime state in `~/.nordrelay/`

Clean local ignored outputs with:

```bash
npm run clean:local
```

Do not commit runtime logs, private state, tokens, or support bundles.
