---
'@yolk-sdk/connectors': patch
---

Add the `@yolk-sdk/connectors/kie` subpath: `KieConnector` with `KieApiKeySlot` (`kie.api_key`) and three actions over the Kie Market API. `kie.create_image_task` (`write`) submits a GPT Image 2 task (text-to-image, or image-to-image when `inputUrls` are given), `kie.create_video_task` (`write`) submits a Wan 2.7 image-to-video task from a first frame (optionally with a last frame) or a first clip, and `kie.get_task` (`read`) returns a task's state, raw `resultJson`, de-duplicated result URLs, and failure detail. Input URLs get a syntax check only (absolute http(s), no credentials). Kie's HTTP 200 error envelopes and non-2xx statuses become `ProviderFailure`s with Kie-specific codes (`kie_unauthorized`, `kie_insufficient_credits`, `kie_validation`, `kie_rate_limited`, `kie_generation_failed`, ...) and the Kie `code`/`msg` in `underlying`.
