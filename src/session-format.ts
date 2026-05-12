import type { CodexSessionInfo } from "./codex-session.js";
import { escapeHTML } from "./format.js";

export function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    `Model: ${info.model ?? "(default)"}`,
    `Reasoning/Fast: ${info.reasoningEffort ?? "(model default)"} / ${info.fastMode ? "on" : "off"}`,
    ...renderCodexUsagePlain(info),
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Launch behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    `<b>Model:</b> <code>${escapeHTML(info.model ?? "(default)")}</code>`,
    `<b>Reasoning/Fast:</b> <code>${escapeHTML(info.reasoningEffort ?? "(model default)")} / ${info.fastMode ? "on" : "off"}</code>`,
    ...renderCodexUsageHTML(info),
    info.sessionTokens ? `<b>Session tokens:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

export function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function renderCodexUsagePlain(info: CodexSessionInfo): string[] {
  const usage = info.codexUsage;
  if (!usage) {
    return [];
  }

  const lines: string[] = [];
  if (usage.contextUsedPercent !== null && usage.contextWindow !== null && usage.lastTokenUsage) {
    lines.push(
      `Context used: ${formatPercent(usage.contextUsedPercent)} (${formatCompactTokenCount(usage.lastTokenUsage.totalTokens)} / ${formatCompactTokenCount(usage.contextWindow)})`,
    );
  }
  if (usage.totalTokenUsage) {
    lines.push(
      [
        `Tokens in: ${formatCompactTokenCount(usage.totalTokenUsage.inputTokens)}`,
        `cached: ${formatCompactTokenCount(usage.totalTokenUsage.cachedInputTokens)}`,
        `out: ${formatCompactTokenCount(usage.totalTokenUsage.outputTokens)}`,
        `reasoning out: ${formatCompactTokenCount(usage.totalTokenUsage.reasoningOutputTokens)}`,
      ].join(" · "),
    );
  }
  const limits = formatLimitsLeft(usage);
  if (limits) {
    lines.push(`Limits left: ${limits}`);
  }
  return lines;
}

function renderCodexUsageHTML(info: CodexSessionInfo): string[] {
  const usage = info.codexUsage;
  if (!usage) {
    return [];
  }

  const lines: string[] = [];
  if (usage.contextUsedPercent !== null && usage.contextWindow !== null && usage.lastTokenUsage) {
    lines.push(
      `<b>Context used:</b> <code>${escapeHTML(formatPercent(usage.contextUsedPercent))}</code> <i>(${escapeHTML(formatCompactTokenCount(usage.lastTokenUsage.totalTokens))} / ${escapeHTML(formatCompactTokenCount(usage.contextWindow))})</i>`,
    );
  }
  if (usage.totalTokenUsage) {
    lines.push(
      `<b>Tokens:</b> <code>${escapeHTML([
        `in ${formatCompactTokenCount(usage.totalTokenUsage.inputTokens)}`,
        `cached ${formatCompactTokenCount(usage.totalTokenUsage.cachedInputTokens)}`,
        `out ${formatCompactTokenCount(usage.totalTokenUsage.outputTokens)}`,
        `reasoning out ${formatCompactTokenCount(usage.totalTokenUsage.reasoningOutputTokens)}`,
      ].join(" · "))}</code>`,
    );
  }
  const limits = formatLimitsLeft(usage);
  if (limits) {
    lines.push(`<b>Limits left:</b> <code>${escapeHTML(limits)}</code>`);
  }
  return lines;
}

function formatLimitsLeft(usage: NonNullable<CodexSessionInfo["codexUsage"]>): string {
  const parts: string[] = [];
  if (usage.rateLimits?.primary) {
    parts.push(`5h ${formatPercent(usage.rateLimits.primary.remainingPercent)}`);
  }
  if (usage.rateLimits?.secondary) {
    parts.push(`weekly ${formatPercent(usage.rateLimits.secondary.remainingPercent)}`);
  }
  return parts.join(" · ");
}

function formatCompactTokenCount(value: number): string {
  const abs = Math.abs(value);
  const units = [
    { threshold: 1_000_000_000_000, suffix: "T" },
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ];

  const unit = units.find((candidate) => abs >= candidate.threshold);
  if (!unit) {
    return Math.round(value).toLocaleString("en-US");
  }

  const scaled = value / unit.threshold;
  const decimals = Math.abs(scaled) < 100 ? 1 : 0;
  return `${scaled.toFixed(decimals).replace(/\.0$/, "")}${unit.suffix}`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return [
    `in: ${formatCompactTokenCount(tokens.input)}`,
    `cached: ${formatCompactTokenCount(tokens.cached)}`,
    `out: ${formatCompactTokenCount(tokens.output)}`,
  ].join(" · ");
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokens: ${formatSessionTokensValue(tokens)}`;
}
