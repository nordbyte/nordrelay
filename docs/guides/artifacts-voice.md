# Artifacts and voice

NordRelay can receive files and images as prompt input, track generated artifacts, and transcribe voice input when a backend is available.

## Attachments

Supported surfaces can attach:

- files
- images/photos
- voice/audio

For agents that cannot process audio directly, NordRelay transcribes audio first and sends text. Agents that can process audio may receive the audio file depending on adapter capability and settings.

## Artifact management

Generated artifacts are tracked per workspace and turn. The WebUI provides:

- quota display
- cleanup rules
- retention controls
- safe-file policy checks
- previews and diffs
- image galleries
- per-channel/user delivery rules

## Delivery modes

Default artifact delivery is controlled by:

```dotenv
NORDRELAY_ARTIFACT_DELIVERY=manual-only
```

Supported delivery modes include `manual-only`, `summary`, `summary-with-actions`, `auto-files`, `auto-zip`, `images-only`, and `off`.

Each chat adapter can override the default with its own `*_ARTIFACT_DELIVERY` key.

## Voice backends

Voice transcription can use:

- `parakeet`
- `faster-whisper`
- `cohere-transcribe`
- `openai`
- `auto`

Configure:

```dotenv
VOICE_PREFERRED_BACKEND=auto
VOICE_DEFAULT_LANGUAGE=
```

Leave `VOICE_DEFAULT_LANGUAGE` empty or set it to `auto` when the selected backend supports language detection. Some backends ignore the value or expect a restricted language-code set.

Use **Diagnostics** → **Voice** to see which backends are installed.
