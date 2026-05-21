# `nordrelay start`

Start the connector in the background.

## Usage

```bash
nordrelay start [options]
```

## Options

| Option | Description |
| --- | --- |
| `--home <path>` | Use a custom NordRelay home directory |
| `--build` | Build before starting when running from source |

## Examples

```bash
nordrelay start
nordrelay start --build
```

## Notes

`start` launches the connector. If the WebUI is enabled, NordRelay prints the dashboard URL or the command needed to open it.
