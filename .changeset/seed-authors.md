---
'@yolk-sdk/agent': patch
---

`voiceSeedTextsFromMessages` gains `{ includeAuthors }`: prefixes user seeds with author display names so multi-user transcripts keep who-said-what when replayed into realtime voice sessions.
