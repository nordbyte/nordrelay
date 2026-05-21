# `nordrelay update`

Update NordRelay from the current install source.

## Usage

```bash
nordrelay update [options]
```

## Options

| Option | Description |
| --- | --- |
| `--method auto|npm|git` | Choose update method |
| `--no-restart` | Do not restart after updating |
| `--restart` | Restart after updating |
| `--home <path>` | Use a custom NordRelay home directory |

## Examples

```bash
nordrelay update
nordrelay update --method npm
nordrelay update --method git --restart
```

## Notes

`auto` uses npm for npm installs and git for source checkouts. Update logs are written below `~/.nordrelay`.
