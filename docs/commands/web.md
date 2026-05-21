# `nordrelay web`

Start the WebUI and connector in the background.

## Usage

```bash
nordrelay web [--host <host>] [--port <port>]
```

`dashboard` is an alias for `web`.

## Options

| Option | Description |
| --- | --- |
| `--host <host>` | WebUI bind host |
| `--port <port>` | WebUI bind port |
| `--home <path>` | Use a custom NordRelay home directory |
| `--build` | Build before starting when running from source |

## Examples

```bash
nordrelay web
nordrelay web --host 127.0.0.1 --port 31878
nordrelay web --host 0.0.0.0 --port 31878
```

## Notes

The dashboard is login-protected, but binding to `0.0.0.0` still exposes the HTTP listener to the network. Use it only on trusted networks or behind a reverse proxy.
