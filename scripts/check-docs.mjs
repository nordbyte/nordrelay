#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(rootDir, "docs");
const commandsDir = path.join(docsDir, "commands");
const configPath = path.join(docsDir, ".vitepress", "config.mts");
const cliPath = path.join(rootDir, "plugins", "nordrelay", "scripts", "nordrelay.mjs");
const configMetadataPath = path.join(rootDir, "src", "core", "config-metadata.ts");
const channelCommandCatalogPath = path.join(rootDir, "src", "channels", "shared", "channel-command-catalog.ts");
const accessControlPath = path.join(rootDir, "src", "access", "access-control.ts");
const webApiContractPath = path.join(rootDir, "src", "web", "web-api-contract.ts");
const pluginMarketplacePath = path.join(rootDir, "src", "plugins", "plugin-marketplace.ts");
const settingsReferencePath = path.join(docsDir, "reference", "settings.md");
const chatCommandsReferencePath = path.join(docsDir, "reference", "chat-commands.md");
const permissionsReferencePath = path.join(docsDir, "reference", "permissions.md");
const apiReferencePath = path.join(docsDir, "reference", "api.md");
const pluginGuidePath = path.join(docsDir, "guides", "plugins.md");
const execFileAsync = promisify(execFile);
const officialPluginDocs = [
  {
    id: "system-monitor",
    repoDir: path.resolve(rootDir, "..", "nordrelay-plugin-system-monitor"),
  },
  {
    id: "auto-updater",
    repoDir: path.resolve(rootDir, "..", "nordrelay-plugin-auto-updater"),
  },
];

const pageExtensions = new Set(["", ".md", ".html"]);
const assetExtensions = new Set([
  ".apng",
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".pdf",
  ".png",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
]);

const errors = [];

function fail(message) {
  errors.push(message);
}

async function main() {
  const markdownFiles = (await listFiles(docsDir))
    .filter((file) => file.endsWith(".md"))
    .filter((file) => !file.includes(`${path.sep}.vitepress${path.sep}`));
  const anchors = await buildAnchorIndex(markdownFiles);

  await checkMarkdownLinks(markdownFiles, anchors);
  await checkVitePressConfigLinks(anchors);
  await checkCommandDocs(markdownFiles);
  await checkSettingsReferenceDocs();
  await checkChatCommandReferenceDocs();
  await checkPermissionReferenceDocs();
  await checkWebApiReferenceDocs();
  await checkPluginMarketplaceDocs();
  await checkOfficialPluginDocs();

  if (errors.length > 0) {
    console.error(`Docs check failed with ${errors.length} issue(s):`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log(`Docs check passed (${markdownFiles.length} markdown files).`);
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || fullPath.endsWith(path.join(".vitepress", "cache")) || fullPath.endsWith(path.join(".vitepress", "dist"))) {
        continue;
      }
      files.push(...await listFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function buildAnchorIndex(files) {
  const index = new Map();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const anchors = new Set();
    const counts = new Map();
    for (const line of source.split(/\r?\n/)) {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const explicit = /\s+\{#([A-Za-z0-9_-]+)\}\s*$/.exec(match[2]);
      if (explicit) {
        anchors.add(explicit[1]);
      }
      const heading = explicit ? match[2].slice(0, explicit.index).trim() : match[2].trim();
      const base = slugify(heading);
      if (!base) continue;
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    index.set(file, anchors);
  }
  return index;
}

function slugify(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

async function checkMarkdownLinks(files, anchors) {
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const text = stripFencedCode(source);
    for (const link of extractMarkdownLinks(text)) {
      checkLink(file, link, anchors, relative(file));
    }
    for (const link of extractHtmlLinks(text)) {
      checkLink(file, link, anchors, relative(file));
    }
  }
}

function stripFencedCode(source) {
  return source.replace(/^(```|~~~)[\s\S]*?^\1/gm, (match) => "\n".repeat(match.split(/\r?\n/).length - 1));
}

function extractMarkdownLinks(source) {
  const links = [];
  const regex = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = regex.exec(source))) {
    links.push(match[1]);
  }
  return links;
}

function extractHtmlLinks(source) {
  const links = [];
  const regex = /\b(?:href|src)=["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(source))) {
    links.push(match[1]);
  }
  return links;
}

async function checkVitePressConfigLinks(anchors) {
  const source = await fs.readFile(configPath, "utf8");
  const regex = /\blink:\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = regex.exec(source))) {
    checkLink(path.join(docsDir, "index.md"), match[1], anchors, relative(configPath));
  }
}

function checkLink(sourceFile, rawTarget, anchors, label) {
  const target = unwrapTarget(rawTarget);
  if (!target || isIgnoredTarget(target)) return;

  const { pathPart, fragment } = splitTarget(target);
  const sourceForAnchor = pathPart ? resolveTargetFile(sourceFile, pathPart, label) : sourceFile;
  if (!sourceForAnchor) return;

  if (fragment) {
    const anchor = safeDecode(fragment);
    const targetAnchors = anchors.get(sourceForAnchor);
    if (!targetAnchors) return;
    if (!targetAnchors.has(anchor)) {
      fail(`${label}: missing anchor #${anchor} in ${relative(sourceForAnchor)} for link ${target}`);
    }
  }
}

function unwrapTarget(target) {
  const value = String(target).trim();
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function isIgnoredTarget(target) {
  return /^(?:https?:|mailto:|tel:|data:)/i.test(target);
}

function splitTarget(target) {
  const hashIndex = target.indexOf("#");
  const beforeHash = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
  const queryIndex = beforeHash.indexOf("?");
  const pathPart = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  return { pathPart, fragment };
}

function resolveTargetFile(sourceFile, target, label) {
  if (target.startsWith("/")) {
    return resolveAbsoluteTarget(target, label);
  }
  return resolveRelativeTarget(sourceFile, target, label);
}

function resolveAbsoluteTarget(target, label) {
  const clean = target.replace(/^\/+/, "");
  const ext = path.extname(clean);
  if (assetExtensions.has(ext)) {
    const publicPath = path.join(docsDir, "public", clean);
    const docsPath = path.join(docsDir, clean);
    if (existsSync(publicPath)) return publicPath;
    if (existsSync(docsPath)) return docsPath;
    fail(`${label}: missing asset ${target}`);
    return null;
  }
  return resolvePagePath(path.join(docsDir, clean), target, label);
}

function resolveRelativeTarget(sourceFile, target, label) {
  const base = path.resolve(path.dirname(sourceFile), target);
  const ext = path.extname(target);
  if (assetExtensions.has(ext)) {
    if (existsSync(base)) return base;
    fail(`${label}: missing asset ${target}`);
    return null;
  }
  if (!pageExtensions.has(ext)) {
    return null;
  }
  return resolvePagePath(base, target, label);
}

function resolvePagePath(base, target, label) {
  const candidates = [];
  const ext = path.extname(base);
  if (ext === ".md") {
    candidates.push(base);
  } else if (ext === ".html") {
    candidates.push(base.replace(/\.html$/, ".md"));
  } else {
    candidates.push(`${base}.md`);
    candidates.push(path.join(base, "index.md"));
    candidates.push(base.endsWith(path.sep) ? path.join(base, "index.md") : base);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail(`${label}: missing docs page ${target}`);
  return null;
}

async function checkCommandDocs(markdownFiles) {
  const cliSource = await fs.readFile(cliPath, "utf8");
  const sourceCommandGroups = extractVisibleCommandGroups(cliSource);
  const helpCommandGroups = await extractCliHelpCommandGroups();
  assertSameCommandGroups(sourceCommandGroups, helpCommandGroups);
  const commandGroups = helpCommandGroups;
  const visibleCommands = commandGroups.map((group) => group[0]);
  const aliases = commandGroups.flatMap((group) => group.slice(1).map((alias) => ({ alias, page: group[0] })));
  const commandFiles = new Set(markdownFiles.filter((file) => path.dirname(file) === commandsDir).map((file) => path.basename(file, ".md")));

  for (const command of visibleCommands) {
    if (!commandFiles.has(command)) {
      fail(`docs/commands: missing page for CLI command '${command}'`);
      continue;
    }
    const page = path.join(commandsDir, `${command}.md`);
    const source = await fs.readFile(page, "utf8");
    if (!/^## Usage\s*$/m.test(source)) fail(`${relative(page)}: missing ## Usage`);
    if (!/^## Examples?\s*$/m.test(source)) fail(`${relative(page)}: missing ## Example(s)`);
  }

  const index = await fs.readFile(path.join(commandsDir, "index.md"), "utf8");
  for (const command of visibleCommands) {
    if (!index.includes(`/commands/${command}`)) {
      fail("docs/commands/index.md: missing link to /commands/" + command);
    }
  }

  for (const { alias, page } of aliases) {
    const source = await fs.readFile(path.join(commandsDir, `${page}.md`), "utf8");
    if (!new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(source)) {
      fail(`docs/commands/${page}.md: missing CLI alias '${alias}'`);
    }
  }

  for (const command of ["peer", "service", "user"]) {
    const names = extractSubcommands(cliSource, command);
    const source = await fs.readFile(path.join(commandsDir, `${command}.md`), "utf8");
    for (const name of names) {
      if (!new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source)) {
        fail(`docs/commands/${command}.md: missing subcommand '${name}' from CLI source`);
      }
    }
  }
}

async function checkSettingsReferenceDocs() {
  const metadataSource = await fs.readFile(configMetadataPath, "utf8");
  const docsSource = await fs.readFile(settingsReferencePath, "utf8");
  const metadataKeys = extractSettingDefinitionKeys(metadataSource);
  const documentedKeys = extractSettingsReferenceKeys(docsSource);

  for (const key of metadataKeys) {
    if (!documentedKeys.has(key)) {
      fail(`${relative(settingsReferencePath)}: missing setting key '${key}' from config metadata`);
    }
  }

  for (const key of documentedKeys) {
    if (!metadataKeys.has(key)) {
      fail(`${relative(settingsReferencePath)}: documents unknown setting key '${key}'`);
    }
  }
}

async function checkChatCommandReferenceDocs() {
  const catalogSource = await fs.readFile(channelCommandCatalogPath, "utf8");
  const docsSource = await fs.readFile(chatCommandsReferencePath, "utf8");
  const catalogCommands = extractChannelCommandCatalogNames(catalogSource);
  const documentedCommands = extractDocumentedChatCommands(docsSource);

  for (const command of catalogCommands) {
    if (!documentedCommands.has(command)) {
      fail(`${relative(chatCommandsReferencePath)}: missing chat command '/${command}' from channel command catalog`);
    }
  }
}

async function checkPermissionReferenceDocs() {
  const accessSource = await fs.readFile(accessControlPath, "utf8");
  const docsSource = await fs.readFile(permissionsReferencePath, "utf8");
  const permissions = extractAllPermissions(accessSource);

  for (const permission of permissions) {
    if (!docsSource.includes(`\`${permission}\``)) {
      fail(`${relative(permissionsReferencePath)}: missing permission '${permission}' from access-control.ts`);
    }
  }
}

async function checkWebApiReferenceDocs() {
  const contractSource = await fs.readFile(webApiContractPath, "utf8");
  const docsSource = await fs.readFile(apiReferencePath, "utf8");
  const namespaces = extractWebApiNamespaces(contractSource);

  for (const namespace of namespaces) {
    if (!docsSource.includes(`\`${namespace}`) && !docsSource.includes(`\`${namespace}/*\``)) {
      fail(`${relative(apiReferencePath)}: missing Web API namespace '${namespace}' from web-api-contract.ts`);
    }
  }
}

async function checkPluginMarketplaceDocs() {
  const marketplaceSource = await fs.readFile(pluginMarketplacePath, "utf8");
  const guideSource = await fs.readFile(pluginGuidePath, "utf8");
  const entries = extractMarketplaceEntries(marketplaceSource);

  for (const entry of entries) {
    if (!guideSource.includes(entry.id) || !guideSource.includes(entry.packageName || entry.source)) {
      fail(`${relative(pluginGuidePath)}: missing marketplace plugin '${entry.id}'`);
    }
    for (const permission of entry.permissions) {
      if (!guideSource.includes(permission)) {
        fail(`${relative(pluginGuidePath)}: missing marketplace permission '${permission}' for plugin '${entry.id}'`);
      }
    }
    for (const capability of entry.capabilities) {
      if (!guideSource.toLowerCase().includes(capability.toLowerCase())) {
        fail(`${relative(pluginGuidePath)}: missing marketplace capability '${capability}' for plugin '${entry.id}'`);
      }
    }
  }
}

async function checkOfficialPluginDocs() {
  const guideSource = await fs.readFile(pluginGuidePath, "utf8");
  for (const plugin of officialPluginDocs) {
    const manifestPath = path.join(plugin.repoDir, "nordrelay.plugin.json");
    const readmePath = path.join(plugin.repoDir, "README.md");
    if (!existsSync(manifestPath) || !existsSync(readmePath)) {
      continue;
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const readme = await fs.readFile(readmePath, "utf8");
    const docsSource = `${guideSource}\n${readme}`;
    for (const permission of manifest.permissions ?? []) {
      if (!docsSource.includes(permission)) {
        fail(`${relative(readmePath)} / ${relative(pluginGuidePath)}: missing plugin permission '${permission}' from ${plugin.id} manifest`);
      }
    }
    for (const command of manifest.capabilities?.commands ?? []) {
      if (!readme.includes(`\`${command.name}\``) && !readme.includes(command.name)) {
        fail(`${relative(readmePath)}: missing plugin command '${command.name}' from ${plugin.id} manifest`);
      }
    }
    const hasWritePermission = (manifest.permissions ?? []).some((permission) => String(permission).endsWith(".write"));
    if (hasWritePermission && /\bread[- ]only\b|intentionally read-only|does not run package upgrades/i.test(docsSource)) {
      fail(`${plugin.id}: docs describe plugin as read-only, but manifest declares write permissions`);
    }
  }
}

async function extractCliHelpCommandGroups() {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"], { cwd: rootDir });
  const commandsBlock = stdout.slice(stdout.indexOf("Commands:"), stdout.indexOf("Options:"));
  const groups = [];
  const regex = /^  ([^\n]+?)\s{2,}.+$/gm;
  let match;
  while ((match = regex.exec(commandsBlock))) {
    const names = match[1].split(",").map((item) => item.trim().split(/\s+/)[0]).filter(Boolean);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

function assertSameCommandGroups(sourceGroups, helpGroups) {
  const source = sourceGroups.map((group) => group.join(",")).join("|");
  const help = helpGroups.map((group) => group.join(",")).join("|");
  if (source !== help) {
    fail(`CLI help output does not match source command list: source=${source} help=${help}`);
  }
}

function extractSettingDefinitionKeys(source) {
  const keys = new Set();
  const regex = /\b(?:setting|telegramSetting|discordSetting|slackSetting|matrixSetting)\(\s*"([A-Z0-9_]+)"/g;
  let match;
  while ((match = regex.exec(source))) {
    keys.add(match[1]);
  }
  return keys;
}

function extractSettingsReferenceKeys(source) {
  const keys = new Set();
  const regex = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm;
  let match;
  while ((match = regex.exec(source))) {
    keys.add(match[1]);
  }
  return keys;
}

function extractChannelCommandCatalogNames(source) {
  const names = new Set();
  const regex = /\{\s*name:\s*"([a-z0-9_-]+)"/g;
  let match;
  while ((match = regex.exec(source))) {
    names.add(match[1]);
  }
  return names;
}

function extractDocumentedChatCommands(source) {
  const commands = new Set();
  const regex = /`\/([a-z0-9_-]+)`/g;
  let match;
  while ((match = regex.exec(source))) {
    commands.add(match[1]);
  }
  return commands;
}

function extractAllPermissions(source) {
  const match = /export const ALL_PERMISSIONS:[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(source);
  if (!match) {
    fail("src/access/access-control.ts: could not parse ALL_PERMISSIONS");
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort();
}

function extractWebApiNamespaces(source) {
  const namespaces = new Set();
  const regex = /\b(?:exact|dynamic)\(\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(source))) {
    const route = match[1];
    const parts = route.split("/").filter(Boolean);
    if (parts.length >= 2) {
      namespaces.add(`/${parts[0]}/${parts[1]}`);
    }
  }
  return [...namespaces].sort();
}

function extractMarketplaceEntries(source) {
  const block = /const MARKETPLACE_ENTRIES:[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(source)?.[1] || "";
  const entries = [];
  const objectRegex = /\{\s*id:\s*"([^"]+)"([\s\S]*?)\n\s*\}/g;
  let match;
  while ((match = objectRegex.exec(block))) {
    const body = match[2];
    entries.push({
      id: match[1],
      source: extractStringField(body, "source"),
      packageName: extractStringField(body, "packageName"),
      permissions: extractStringArrayField(body, "permissions"),
      capabilities: extractStringArrayField(body, "capabilities"),
    });
  }
  return entries;
}

function extractStringField(source, name) {
  return new RegExp(`\\b${escapeRegExp(name)}:\\s*"([^"]+)"`).exec(source)?.[1] || "";
}

function extractStringArrayField(source, name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}:\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function extractVisibleCommandGroups(source) {
  const helpBody = source.slice(source.indexOf('console.log("Commands:");'), source.indexOf('console.log("Options:");'));
  const groups = [];
  const regex = /console\.log\("  ([^"]+?)\s{2,}/g;
  let match;
  while ((match = regex.exec(helpBody))) {
    const names = match[1].split(",").map((item) => item.trim().split(/\s+/)[0]).filter(Boolean);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

function extractSubcommands(source, command) {
  const functionName = `command${command[0].toUpperCase()}${command.slice(1).replace(/-([a-z])/g, (_, value) => value.toUpperCase())}`;
  const body = extractFunctionBody(source, functionName);
  const names = new Set();
  const usage = new RegExp(`Usage: nordrelay ${escapeRegExp(command)} \\[([^\\]]+)]`).exec(body);
  if (usage) {
    for (const name of usage[1].split("|").map((item) => item.trim()).filter(Boolean)) {
      names.add(name);
    }
  }
  const branchRegex = /flags\.subcommand\s*===\s*"([^"]+)"/g;
  let match;
  while ((match = branchRegex.exec(body))) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function extractFunctionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}`);
  if (start < 0) {
    fail(`CLI source: missing ${functionName}`);
    return "";
  }
  const firstBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(firstBrace + 1, index);
    }
  }
  fail(`CLI source: could not parse ${functionName}`);
  return "";
}

function safeDecode(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relative(file) {
  return path.relative(rootDir, file).replaceAll(path.sep, "/");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
