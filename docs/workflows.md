# File, Photo, Voice, and Artifact Workflows

## Text

- Any non-command text message becomes a prompt for the selected agent.
- While the selected agent works, Telegram shows `typing`.
- Replies stream back into the same chat or topic.

## Photos

- Send a photo with or without a caption.
- The connector downloads it and passes it to the selected agent as local image input.
- The caption becomes the text prompt when present.
- Sending multiple photos as a Telegram album creates one combined agent prompt.

## Documents

- Send a document with or without a caption.
- The connector downloads it, sanitizes the filename, enforces `MAX_FILE_SIZE`, and stages it under:

```text
<workspace>/.nordrelay/inbox/<turn-id>/
```

- The selected agent receives prompt instructions with the staged file paths.
- The caption becomes the text prompt when present.
- Document albums and mixed media groups are processed as one turn; oversized files are skipped and reported.

## Artifacts

- For generated files that should be returned to Telegram, tell the selected agent to write them to:

```text
<workspace>/.nordrelay/turns/<turn-id>/out/
```

- The connector stores files in that directory and keeps them available for `/artifacts`.
- Automatic Telegram artifact delivery is off by default. Set `TELEGRAM_AUTO_SEND_ARTIFACTS=true` to collect and send files right after a turn.
- When automatic delivery or explicit `/artifacts` sending is used, image outputs are sent with Telegram previews and other outputs are sent as documents.
- When more than five artifacts are sent, the connector tries to send one ZIP bundle instead of many separate files.
- Use `/artifacts` to list recent artifact turns with inline Send/ZIP/Delete actions.
- Use `/artifacts latest`, `/artifacts zip latest`, or `/artifacts <turn-id>` from text commands.
- Use `/artifacts images`, `/artifacts docs`, or `/artifacts search <text>` to narrow large artifact histories.
- Use `/artifacts delete <turn-id>` to delete an artifact turn without opening the inline confirmation flow.
- Telegram file delivery is capped at the configured `MAX_FILE_SIZE` per artifact or ZIP bundle.
- Old turn and inbox directories are pruned automatically to keep workspace state compact.

## Voice and Audio

- Send a Telegram voice note or audio file.
- The connector transcribes it, then sends the transcript to the selected agent.
- Local transcription is tried first with `parakeet-coreml` or `faster-whisper` when installed.
- OpenAI Whisper is used when `OPENAI_API_KEY` is set.

## Voice Prerequisites

```bash
# macOS Apple Silicon
brew install ffmpeg
npm install parakeet-coreml
```

```bash
# Debian/Ubuntu
sudo apt-get install ffmpeg
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install faster-whisper
```

```dotenv
FASTER_WHISPER_PYTHON=.venv/bin/python
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_COMPUTE_TYPE=int8
```

## Whisper Fallback

```dotenv
OPENAI_API_KEY=sk-...
```

Voice transcription uses `OPENAI_API_KEY`, not `CODEX_API_KEY`.
