import { escapeHTML } from "../../core/format.js";
import type { ChannelActionResponse } from "./channel-actions.js";

export function withSelectedNodeHeader(rendered: ChannelActionResponse, label: string): ChannelActionResponse {
  if (rendered.plain.startsWith("Selected node:")) {
    return rendered;
  }
  return {
    ...rendered,
    plain: [`Node: ${label}`, "", rendered.plain].join("\n"),
    html: [`<b>Node:</b> <code>${escapeHTML(label)}</code>`, "", rendered.html].join("\n"),
  };
}
