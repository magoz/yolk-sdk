---
'@yolk-sdk/connectors': patch
---

Fix `outlook.get_message` failing with `validation_failed` on Sent Items and drafts: Microsoft Graph omits or nulls `internetMessageHeaders` for messages that did not arrive through transport. The connector now returns `internetMessageHeaders: []` for them; malformed headers still fail.
