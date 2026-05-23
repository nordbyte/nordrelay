# `nordrelay peer`

Manage secure NordRelay peer federation.

## Usage

```bash
nordrelay peer <subcommand> [options]
```

## Subcommands

| Subcommand | Purpose |
| --- | --- |
| `identity` | Print this node identity and fingerprint |
| `list` | List configured peers |
| `invite` | Create a one-time pairing code |
| `add <url>` | Add a peer with a pairing code |
| `test <peer-id>` | Call a peer ping RPC |
| `check <url>` | Check peer reachability and identity endpoint |
| `debug <peer-id>` | Run a full peer diagnostic report |
| `access <peer-id>` | Explain effective peer access and missing scopes |
| `health <peer-id>` | Print recent peer health samples |
| `repair <peer-id>` | Run a safe repair action |
| `revoke <peer-id>` | Revoke a peer |
| `trust <peer-id>` | Trust a changed TLS fingerprint when node identity still matches |
| `rotate <peer-id>` | Create a rotation invitation |

## Options

| Option | Description |
| --- | --- |
| `--name <name>` | Human-readable peer or invitation name |
| `--code <code>` | Pairing code for `add` |
| `--expect-fingerprint <sha256>` | Expected TLS fingerprint for `check` |
| `--public-url <url>` | Public URL to share back during pairing |
| `--expires <minutes>` / `--expires-minutes <minutes>` | Invitation lifetime |
| `--scopes <list>` | Comma-separated peer scopes |
| `--agents <list>` | Comma-separated allowed agents |
| `--workspaces <list>` | Comma-separated allowed workspace roots |
| `--workspace-aliases <list>` / `--aliases <list>` | Workspace aliases for remote use |
| `--email <email>` | Evaluate `debug` or `access` for a specific WebUI user |
| `--probe` | Run live checks during `debug` |
| `--repin-tls` | Repair action: verify identity and re-pin TLS |
| `--clear-error` | Repair action: clear retained last error |
| `--enable` / `--disable` | Repair action: enable or disable the peer |
| `--retry-relay` | Repair action: retry stale relay requests |
| `--drain-expired` | Repair action: remove expired relay requests |
| `--rotate-pairing` | Repair action: create a new pairing invite |

## Examples

```bash
nordrelay peer identity
nordrelay peer invite --name laptop --expires 30
nordrelay peer add https://192.168.1.20:31979 --code <pairing-code>
nordrelay peer check https://192.168.1.20:31979
nordrelay peer debug <peer-id>
nordrelay peer access <peer-id> --email admin@example.com
nordrelay peer health <peer-id>
nordrelay peer repair <peer-id> --repin-tls
nordrelay peer repair <peer-id> --retry-relay
nordrelay peer trust <peer-id>
nordrelay peer revoke <peer-id>
```

## Requirements

Peer serving must be enabled on the target node:

```dotenv
NORDRELAY_PEER_ENABLED=true
NORDRELAY_PEER_TLS_ENABLED=true
```

Pairing is authenticated and TLS fingerprint-pinned. Do not bypass fingerprint mismatch warnings.

## Diagnostics

`nordrelay peer debug <peer-id>` classifies network, TLS, identity, signed RPC, route, live-event, relay, and access failures with stable error codes such as `peer.network.timeout`, `peer.tls.fingerprint_mismatch`, `peer.scope.missing`, and `peer.user.peer_denied`.

Use `nordrelay peer access <peer-id> --email <user>` when the WebUI or chat says `Access denied` and you need to see whether the local user group, peer scopes, allowed agents, or workspace roots are blocking the action.

The WebUI exposes the same report from **Peers > Peers > More > Debug**.
