import type { Permission } from "../../access/access-control.js";
import { escapeHTML } from "../../core/format.js";
import { PeerStore } from "../../peers/peer-store.js";
import type { PublicPeerRecord } from "../../peers/peer-types.js";
import type { BotPreferencesStore } from "../../state/bot-preferences.js";
import type { ChannelActionButton, ChannelActionResponse } from "./channel-actions.js";

const REQUIRED_PEER_SCOPES: Permission[] = ["sessions.read", "sessions.write", "prompt.send", "settings.write"];

export interface NodeTargetCommandOptions {
  contextKey: string;
  preferencesStore: BotPreferencesStore;
  argument?: string;
  peerStore?: PeerStore;
}

export interface NodeTargetActionOptions {
  contextKey: string;
  preferencesStore: BotPreferencesStore;
  action: string;
  peerStore?: PeerStore;
}

export interface NodeTargetSelection {
  kind: "local" | "peer";
  peerId?: string;
  label: string;
}

export function renderNodeTargetPicker(options: NodeTargetCommandOptions): ChannelActionResponse {
  const peers = nodePeers(options.peerStore);
  const currentPeerId = options.preferencesStore.get(options.contextKey).targetPeerId ?? null;
  const currentPeer = currentPeerId ? peers.find((peer) => peer.id === currentPeerId) : null;
  const selected = currentPeer ? peerLabel(currentPeer) : currentPeerId ? `unknown peer (${currentPeerId})` : "Local node";
  const rows = [
    nodeLine("Local node", !currentPeerId, []),
    ...peers.map((peer) => nodeLine(peerLabel(peer), currentPeerId === peer.id, peerWarnings(peer))),
  ];
  return {
    plain: [`Selected node: ${selected}`, "", "Available nodes:", ...rows].join("\n"),
    html: [
      `<b>Selected node:</b> <code>${escapeHTML(selected)}</code>`,
      "",
      "<b>Available nodes:</b>",
      ...rows.map((line) => `<code>${escapeHTML(line)}</code>`),
    ].join("\n"),
    buttons: nodeButtons(peers, currentPeerId),
  };
}

export function renderNodeTargetPreference(options: NodeTargetCommandOptions): ChannelActionResponse {
  const argument = options.argument?.trim() ?? "";
  if (!argument) {
    return renderNodeTargetPicker(options);
  }
  const action = argument.toLowerCase() === "local" ? "node_target:local" : `node_target:peer:${argument}`;
  return renderNodeTargetAction({ ...options, action });
}

export function renderNodeTargetAction(options: NodeTargetActionOptions): ChannelActionResponse {
  const selection = applyNodeTargetAction(options);
  const picker = renderNodeTargetPicker(options);
  return {
    plain: [`Selected node: ${selection.label}`, "Use /sessions to browse sessions on this node."].join("\n"),
    html: [
      `<b>Selected node:</b> <code>${escapeHTML(selection.label)}</code>`,
      "Use <code>/sessions</code> to browse sessions on this node.",
    ].join("\n"),
    buttons: picker.buttons,
  };
}

export function applyNodeTargetAction(options: NodeTargetActionOptions): NodeTargetSelection {
  const action = options.action.trim();
  if (action === "node_target:local") {
    options.preferencesStore.update(options.contextKey, { targetPeerId: null });
    return { kind: "local", label: "Local node" };
  }
  const match = /^node_target:peer:(.+)$/.exec(action);
  const peerRef = match?.[1];
  if (!peerRef) {
    throw new Error("Unknown node target action.");
  }
  const peers = nodePeers(options.peerStore);
  const normalized = peerRef.toLowerCase();
  const peer = peers.find((candidate) =>
    candidate.id === peerRef ||
    candidate.nodeId === peerRef ||
    candidate.name.toLowerCase() === normalized
  );
  if (!peer) {
    throw new Error("Unknown peer target. Use /nodes to select an available node.");
  }
  if (!peer.enabled || !peer.url) {
    throw new Error(`Peer is not selectable: ${peerLabel(peer)}.`);
  }
  options.preferencesStore.update(options.contextKey, { targetPeerId: peer.id });
  return { kind: "peer", peerId: peer.id, label: peerLabel(peer) };
}

function nodePeers(store = new PeerStore()): PublicPeerRecord[] {
  return store.listPublic().sort((left, right) => peerLabel(left).localeCompare(peerLabel(right)));
}

function nodeButtons(peers: PublicPeerRecord[], currentPeerId: string | null): ChannelActionButton[][] {
  const buttons: ChannelActionButton[] = [
    { label: `${currentPeerId ? "" : "✓ "}Local node`, action: "node_target:local" },
    ...peers
      .filter((peer) => peer.enabled && peer.url)
      .map((peer) => ({
        label: `${currentPeerId === peer.id ? "✓ " : ""}${peer.name || peer.id}`,
        action: `node_target:peer:${peer.id}`,
      })),
  ];
  const rows: ChannelActionButton[][] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return rows;
}

function nodeLine(label: string, selected: boolean, warnings: string[]): string {
  return `${selected ? "* " : "- "}${label}${warnings.length ? ` (${warnings.join("; ")})` : ""}`;
}

function peerLabel(peer: PublicPeerRecord): string {
  return `${peer.name || peer.id} (${peer.id})`;
}

function peerWarnings(peer: PublicPeerRecord): string[] {
  const warnings: string[] = [];
  if (!peer.enabled) warnings.push("disabled");
  if (!peer.url) warnings.push("no direct URL");
  const missing = REQUIRED_PEER_SCOPES.filter((scope) => !peer.scopes.includes(scope));
  if (missing.length) warnings.push(`missing ${missing.join(", ")}`);
  if (peer.remoteStatus === "offline") warnings.push("offline");
  if (peer.lastError) warnings.push(`last error: ${peer.lastError}`);
  return warnings;
}
