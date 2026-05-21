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

## Check reachability

```bash
nordrelay peer check https://host.example:31979
nordrelay peer test <peer-id>
```

## Rotate or trust TLS

If the peer certificate changes but the node identity is the same:

```bash
nordrelay peer trust <peer-id>
```

For identity or access changes:

```bash
nordrelay peer rotate <peer-id>
```

## Outbound relay mode

Outbound relay mode lets a node poll for relay requests instead of accepting inbound connections:

```dotenv
NORDRELAY_PEER_OUTBOUND_RELAY_ENABLED=true
NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS=1000
```

Use it when a remote host cannot expose a port.
