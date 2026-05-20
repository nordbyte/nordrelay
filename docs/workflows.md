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
- Automatic artifact delivery is off by default. Configure `NORDRELAY_ARTIFACT_DELIVERY` or the channel-specific `TELEGRAM_ARTIFACT_DELIVERY`, `DISCORD_ARTIFACT_DELIVERY`, and `SLACK_ARTIFACT_DELIVERY` overrides to send summaries, files, ZIP bundles, images only, or nothing.
- User preferences and registered Telegram/Discord/Slack channels can override artifact delivery in the WebUI.
- Use `/artifacts delivery <mode>` in Telegram, Discord, or Slack to set the linked user's delivery preference. Use `default` to inherit the channel/system default.
- When automatic delivery or explicit `/artifacts` sending is used, image outputs are sent with previews where the channel supports it and other outputs are sent as files.
- When more than five artifacts are sent, the connector tries to send one ZIP bundle instead of many separate files.
- Use `/artifacts` to list recent artifact turns with inline Send/ZIP/Delete actions.
- Use `/artifacts latest`, `/artifacts zip latest`, or `/artifacts <turn-id>` from text commands.
- Use `/artifacts images`, `/artifacts docs`, or `/artifacts search <text>` to narrow large artifact histories.
- Use `/artifacts delete <turn-id>` to delete an artifact turn without opening the inline confirmation flow.
- Use `/artifacts quota` to show managed storage usage and quota status.
- Use `/artifacts cleanup preview` to inspect retention/quota cleanup candidates and `/artifacts cleanup run` to remove them.
- The WebUI Artifacts tab shows quota usage, cleanup previews, cleanup execution, text/image previews, and Git diffs for workspace artifacts where available.
- File delivery is capped at the configured `MAX_FILE_SIZE` per artifact or ZIP bundle.
- Old turn and inbox directories are pruned automatically to keep workspace state compact.

## Voice and Audio

- Send a Telegram voice note or audio file.
- The connector transcribes it, then sends the transcript to the selected agent.
- Local transcription is tried first with `parakeet-coreml`, `faster-whisper`, or `cohere-transcribe` when installed.
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

For local Cohere Transcribe on Ubuntu/Linux:

```bash
python3 -m venv ~/.nordrelay/voice/.venv
~/.nordrelay/voice/.venv/bin/python -m pip install -U pip setuptools wheel
~/.nordrelay/voice/.venv/bin/python -m pip install -U --index-url https://download.pytorch.org/whl/cpu torch
~/.nordrelay/voice/.venv/bin/python -m pip install -U transformers librosa soundfile accelerate sentencepiece protobuf
```

Then set:

```env
VOICE_PREFERRED_BACKEND=cohere-transcribe
VOICE_DEFAULT_LANGUAGE=de
COHERE_TRANSCRIBE_PYTHON=/home/you/.nordrelay/voice/.venv/bin/python
COHERE_TRANSCRIBE_MODEL=CohereLabs/cohere-transcribe-03-2026
```

The first Cohere Transcribe run downloads the Hugging Face model locally. If Hugging Face requires gated access, accept the model terms in the browser and configure `HF_TOKEN`.

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
