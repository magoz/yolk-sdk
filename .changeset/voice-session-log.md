---
'@yolk-sdk/agent': patch
---

Durable voice session logs: versioned `VoiceSessionLogState` + pure `foldStoredVoiceEvents` batch fold, deterministic tool event ids (`voiceToolEventId`, `storedVoiceToolEvents`, `storedToolEventsFromOutcome`) so server-witnessed tool logs dedupe against client replays, `makeVoiceEventOutbox` + `useYolkVoice` `eventLog` option for at-least-once client event batching, and projection now keeps streamed draft text when finals arrive with empty transcripts.
