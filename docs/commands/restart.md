# `nordrelay restart`

Restart the connector and, if it was running, the WebUI.

## Usage

```bash
nordrelay restart [options]
```

## Options

| Option | Description |
| --- | --- |
| `--home <path>` | Use a custom NordRelay home directory |
| `--build` | Build before restarting when running from source |

## Examples

```bash
nordrelay restart
nordrelay restart --build
```

## Notes

Use `restart --build` after local source changes. npm installs normally use the already built package files.
