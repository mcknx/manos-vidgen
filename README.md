# vidgen — topic in, raw vertical mp4 out

Manos Corp trial prototype (2-hour cap). One Node script, no npm dependencies.

    node vidgen.mjs "why the Titanic sank"    → out/why-the-titanic-sank/final.mp4

## How it works

1. **Script** — Claude Code CLI (`claude -p` with a JSON schema) writes a 45–60 s Short: hook, 5–7 scenes,
   and 2–3 Wikimedia Commons search queries per scene.
2. **Footage** — Wikimedia Commons API (free, no key). Real video first, photo fallback; one file never
   repeats; attribution saved to `credits.txt`.
3. **Voice** — Piper TTS, local, one wav per scene so each clip is cut to the length of its line.
4. **Captions** — whisper.cpp re-listens to the voice track and outputs short timed segments, burned in.
5. **Music** — a pad synthesized in ffmpeg (owned, no licensing), side-chain ducked under the voice.
6. **Assembly** — ffmpeg: 1080x1920, photos get a slow push-in so the frame never freezes, concat, mux.

## Setup

ffmpeg, whisper.cpp (`whisper-cli`), Claude Code CLI, Python with `pip install piper-tts`, Node 22.

    export PIPER_PY=/path/to/python PIPER_VOICE=/path/en_US-ryan-medium.onnx WHISPER_MODEL=/path/ggml-large-v3-turbo-q5_0.bin

## Samples

`out/the-history-of-coffee/final.mp4` (56 s) and `out/why-the-titanic-sank/final.mp4` (42 s), each with
`script.json`, `captions.srt` and `credits.txt`.

## What I'd add next

- Vision check on each pick (Claude looks at the frame and rejects off-topic footage — the coffee run used a
  Hegra rock-tomb photo for "Mecca").
- 2–3 shots per scene for faster pacing; Pexels/Pixabay for modern b-roll; yt-dlp for licensed sources.
- Word-by-word highlighted captions, a better voice (cloned or ElevenLabs), real music library.
- Queue + retries so it runs unattended for a batch of topics.
