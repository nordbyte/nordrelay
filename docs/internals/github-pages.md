# GitHub Pages

The public documentation is built from `docs/` with VitePress and deployed to GitHub Pages.

## Local build

```bash
npm run docs:build
```

Output:

```text
docs/.vitepress/dist/
```

## Workflow

The Pages workflow is:

```text
.github/workflows/pages.yml
```

It installs dependencies, runs `npm run docs:build`, uploads `docs/.vitepress/dist`, and deploys with GitHub Pages.

## Custom domain

The custom domain is stored in:

```text
docs/public/CNAME
```

with the value:

```text
nordrelay.io
```

## DNS

For the apex domain, configure GitHub Pages A/AAAA records. For `www`, create a CNAME to the GitHub Pages host for the repository owner. GitHub provisions HTTPS after DNS and Pages settings are valid.
