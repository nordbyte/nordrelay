# Installation

NordRelay runs on Node.js 22 or newer and stores local runtime data under `~/.nordrelay`.

## Requirements

- Node.js `>=22`
- npm, pnpm, or Yarn
- At least one supported coding agent installed and authenticated
- Optional bot/app credentials for Telegram, Discord, Slack, or Matrix
- Optional `ffmpeg` and a local voice backend for voice transcription

## npm install

```bash
npm install -g @nordbyte/nordrelay
nordrelay init
```

If the `nordrelay` command is not found after installation, the package-manager global bin directory is not in `PATH`. Run:

```bash
npm bin -g
```

Add the printed directory to your shell profile, then open a new terminal.

## pnpm and Yarn

NordRelay is published as the same npm package for all package managers:

```bash
pnpm add -g @nordbyte/nordrelay
yarn global add @nordbyte/nordrelay
```

For one-off initialization without a global install:

```bash
pnpm dlx @nordbyte/nordrelay init
yarn dlx @nordbyte/nordrelay init
```

## Source checkout

```bash
git clone https://github.com/nordbyte/nordrelay.git
cd nordrelay
npm install
npm run build
node plugins/nordrelay/scripts/nordrelay.mjs init
```

Use source checkouts for development. Use the npm package for normal installs and updates.

## Install checks

After installation:

```bash
nordrelay doctor
nordrelay doctor --fix
```

`doctor --fix` only applies safe local fixes, such as creating expected directories or enabling the WebUI when no other access surface is configured.

## Local files

NordRelay writes runtime config, logs, state, artifacts, and WebUI user data below:

```text
~/.nordrelay/
```

Do not put secrets in the repository. Use `~/.nordrelay/nordrelay.env`, OS secret storage, or deployment-specific secret management.
