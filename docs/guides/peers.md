# Peers

Peers connect trusted NordRelay instances so one WebUI can control agents on other machines.

## Enable the peer server

```dotenv
NORDRELAY_PEER_ENABLED=true
NORDRELAY_PEER_HOST=127.0.0.1
NORDRELAY_PEER_PORT=31979
NORDRELAY_PEER_TLS_ENABLED=true
NORDRELAY_PEER_REQUIRE_TLS=true
```

Use a LAN IP or public bind only when you intentionally expose the peer API. For internet access, place it behind a secure network path and keep TLS enabled.

## Create an invitation

On the host that should be added:

```bash
nordrelay peer invite --name workstation --expires 30
```

The output includes a one-time pairing command.

## Add a peer

On the controlling machine:

```bash
nordrelay peer add https://host.example:31979 --code <pairing-code>
```

NordRelay stores the peer identity, node fingerprint, and TLS fingerprint.

## Limit peer access by group

Open **Users** in the WebUI, edit a group, and use **Peer scope** to select which paired nodes users in that group may access.

- empty peer scope means all peers
- selected peer scope means only those peers
- stale peer ids remain visible as unavailable instead of silently becoming "all"

The scope applies to the WebUI, chat commands, remote session switching, mirroring, workflow steps, peer proxying, relay queues, health checks, and event streams.

## Use peers from chat

Approved chat users can switch a chat context between the local node and trusted peers:

```text
/nodes
/sessions
```

`/nodes` opens the node picker. After choosing a peer, `/sessions` lists sessions from that peer for the currently selected agent. Use `/target local` to switch the chat context back to the local node.

## Check reachability

```bash
nordrelay peer check https://host.example:31979
nordrelay peer test <peer-id>
nordrelay peer debug <peer-id>
```

The WebUI also includes **Peers > Peers > More > Debug**. The debug view separates connectivity, TLS trust, effective access, route checks, live-event prerequisites, health history, and safe repair actions.

Use it when a peer reports `Access denied`, `Peer TLS certificate fingerprint mismatch`, stale relay failures, or missing sessions. The access tab explains whether the local user group, peer scopes, allowed agents, or workspace roots are responsible.

## Rotate or trust TLS

If the peer certificate changes but the node identity is the same:

```bash
nordrelay peer trust <peer-id>
```

For identity or access changes:

```bash
nordrelay peer rotate <peer-id>
```

The debug view can also run safe repairs:

```bash
nordrelay peer repair <peer-id> --repin-tls
nordrelay peer repair <peer-id> --clear-error
nordrelay peer repair <peer-id> --retry-relay
nordrelay peer repair <peer-id> --drain-expired
nordrelay peer repair <peer-id> --rotate-pairing
```

## Outbound relay mode

Outbound relay mode lets a node poll for relay requests instead of accepting inbound connections:

```dotenv
NORDRELAY_PEER_OUTBOUND_RELAY_ENABLED=true
NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS=1000
```

Use it when a remote host cannot expose a port.
