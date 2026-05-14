# Realtime Voice Adapters

OpenAI Realtime/WebRTC server-side helpers and voice tool bridge glue.

## Boundaries

- Browser hook owns WebRTC peer/data/audio lifecycle in `app/agent/use-realtime-voice.ts`.
- `/api/agent/realtime/call` mints OpenAI Realtime SDP using `OPENAI_API_KEY`.
- `/api/agent/realtime/tool` executes provider-normalized voice tool calls via `@yolk/voice-runtime`.
- Realtime/OpenAI specifics stay app-local; package `@yolk/voice-runtime` remains provider-neutral.

## Event policy

- Input transcript events: `conversation.item.input_audio_transcription.*`.
- Assistant transcript events: `response.output_audio_transcript.*` or `response.audio_transcript.*`.
- Tool calls are `function_call` items inside `response.done.response.output`.
- Completed user transcripts append protocol user messages into shared chat state.

## Model/config

- Default model `gpt-realtime-2`; default transcription `gpt-realtime-whisper`.
- UI may select `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-transcribe-2025-12-15`.
- Prompted transcription models receive: `Transcribe English speech. Preserve exact words.`
- OpenRouter is not supported for Realtime.

## Tests

- Keep event parsing tests around OpenAI event shapes.
- Keep tool bridge tests below browser level; provider route tests cover HTTP boundary only.
