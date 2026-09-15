---
'@yolk-sdk/agent': minor
---

Add OpenCode Go API-key provider support for host-selected Chat Completions, Anthropic Messages, and OpenAI Responses protocols, with explicit output limits and native tool/reasoning handling.

Add best-effort Go subscription usage snapshots for rolling, weekly, and monthly allowance windows using the fixed API-key usage endpoint. Hosts retain credential, model, polling, and UI policy.

Share Anthropic lowering/parsing without applying Claude OAuth fingerprints to Go. Reject filtered Messages output and ignore frames after terminal completion. Sanitize Go provider errors while preserving classified metadata.
