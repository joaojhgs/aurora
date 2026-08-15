# Aurora Voice Model Workspace

This directory is a local workspace only. Aurora does not ship wake word,
speech-to-text, VAD, or TTS model weights from this repository.

Production speech setup is catalog-first:

1. Aurora shows the available speech packs as metadata.
2. The user chooses the exact pack, voice, language, or wake phrase they want.
3. Aurora downloads the selected files from the pinned source, verifies the
   declared hashes, and caches them in the user's data directory.
4. The cached files stay local and are reused until the user removes them or
   chooses a replacement.

The repository keeps this directory ignored so downloaded model files, voice
archives, generated profiles, and private speech state do not enter version
control.

## Advanced Local Overrides

Developers can still point Aurora at a user-managed local file when testing a
custom ONNX wake word model:

```bash
AURORA_WAKE_WORD_MODEL_PATH=/absolute/path/to/custom-wakeword.onnx
```

That override is compatibility-only. The release path for end users is the
catalog and on-demand cache flow across desktop, web, Android, and iOS roles.
