import process from "node:process";

export const TUI_COLORS = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  inverse: "\x1b[7m",
});

export function tuiStyle(kind, text, stream = process.stdout) {
  if (!useTuiColors(stream)) return text;
  const color = TUI_COLORS;
  const styles = {
    title: `${color.bold}${color.cyan}`,
    help: color.dim,
    rule: color.dim,
    section: `${color.bold}${color.blue}`,
    pointer: color.dim,
    selectedPointer: `${color.bold}${color.green}`,
    label: color.reset,
    selectedLabel: color.bold,
    hint: color.dim,
    enabled: color.green,
    disabled: color.yellow,
    missing: `${color.bold}${color.red}`,
    empty: color.dim,
    configured: color.green,
    value: color.cyan,
    action: color.green,
    danger: color.yellow,
    success: color.green,
    warning: color.yellow,
    error: color.red,
  };
  const prefix = styles[kind] ?? "";
  return prefix ? `${prefix}${text}${color.reset}` : text;
}

export function useTuiColors(stream = process.stdout) {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}
