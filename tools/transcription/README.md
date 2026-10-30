# transcription

`transcription.py` transcribes video audio with WhisperX (word-level timestamps). It came from another app and still imports that app's modules (`app.config`, `app.services.*`), so it doesn't run on its own yet. Making it a standalone CLI means replacing those imports with arguments and file output.
