import { defineConfig } from "vitepress";

const repo = "https://github.com/nordbyte/nordrelay";

export default defineConfig({
  title: "NordRelay",
  description: "Remote control plane for coding agents across chat, WebUI, and trusted peers.",
  lang: "en-US",
  cleanUrls: false,
  lastUpdated: true,
  sitemap: {
    hostname: "https://nordrelay.io"
  },
  head: [
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "any" }],
    ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" }],
    ["link", { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" }],
    ["link", { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#147a5c" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "NordRelay documentation" }],
    ["meta", { property: "og:description", content: "Operate coding-agent sessions through a login-protected WebUI, chat adapters, and trusted peer nodes." }],
    ["meta", { property: "og:url", content: "https://nordrelay.io/" }]
  ],
  themeConfig: {
    logo: "/nordrelay-logo.png",
    siteTitle: "NordRelay docs",
    nav: [
      { text: "Home", link: "/" },
      { text: "GitHub", link: repo },
      { text: "npm", link: "https://www.npmjs.com/package/@nordbyte/nordrelay" }
    ],
    search: {
      provider: "local"
    },
    outline: {
      level: [2, 3],
      label: "On this page"
    },
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: "Edit page"
    },
    socialLinks: [
      { icon: "github", link: repo }
    ],
    docFooter: {
      prev: "Previous",
      next: "Next"
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright (c) Nordbyte"
    },
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Overview", link: "/" },
          { text: "Installation", link: "/start/install" },
          { text: "Quickstart", link: "/start/quickstart" },
          { text: "Core concepts", link: "/start/core-concepts" },
          { text: "WebUI", link: "/start/webui" },
          { text: "Troubleshooting", link: "/start/troubleshooting" }
        ]
      },
      {
        text: "Guides",
        items: [
          { text: "Agents", link: "/guides/agents" },
          { text: "Chat adapters", link: "/guides/chat-adapters" },
          { text: "Remote sessions", link: "/guides/remote-sessions" },
          { text: "Workflows", link: "/guides/workflows" },
          { text: "Artifacts and voice", link: "/guides/artifacts-voice" },
          { text: "Security and login", link: "/guides/security-login" },
          { text: "Peers", link: "/guides/peers" }
        ]
      },
      {
        text: "Reference",
        items: [
          { text: "CLI command reference", link: "/commands/" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Settings keys", link: "/reference/settings" },
          { text: "Paths and state", link: "/reference/locations" },
          { text: "Web API", link: "/reference/api" },
          { text: "Chat commands", link: "/reference/chat-commands" }
        ]
      },
      {
        text: "CLI commands",
        collapsed: true,
        items: [
          { text: "init", link: "/commands/init" },
          { text: "user", link: "/commands/user" },
          { text: "peer", link: "/commands/peer" },
          { text: "service", link: "/commands/service" },
          { text: "doctor", link: "/commands/doctor" },
          { text: "web", link: "/commands/web" },
          { text: "start", link: "/commands/start" },
          { text: "stop", link: "/commands/stop" },
          { text: "restart", link: "/commands/restart" },
          { text: "status", link: "/commands/status" },
          { text: "update", link: "/commands/update" },
          { text: "foreground", link: "/commands/foreground" },
          { text: "version", link: "/commands/version" }
        ]
      },
      {
        text: "Internals",
        items: [
          { text: "Architecture", link: "/internals/architecture" },
          { text: "Development", link: "/internals/development" },
          { text: "GitHub Pages", link: "/internals/github-pages" }
        ]
      }
    ]
  }
});
