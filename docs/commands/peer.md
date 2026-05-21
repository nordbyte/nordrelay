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

## Examples

```bash
nordrelay peer identity
nordrelay peer invite --name laptop --expires 30
nordrelay peer add https://192.168.1.20:31979 --code <pairing-code>
nordrelay peer check https://192.168.1.20:31979
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
