---
'@yolk-sdk/codemode': minor
---

`readOnlyNestedCallGate` takes `admitModelCall?: (input: CodeModeBeforeNestedCallInput) => boolean`,
a predicate over the same `{ call, tool, access }` input as `admit`. When it returns `true` for a
tool marked `invokesModel`, the call is not refused with `invokes_model`, so a host can let scripts
call bounded model reads such as `classify` while still refusing open-ended ones. It relaxes only
the model check: the call still needs effective access `read` (or `admit`), so a write marked
`invokesModel` is refused as `not_read`, and approval-gated and unavailable tools stay refused. It
is asked only about `invokesModel` tools; one that throws refuses the call (`The call could not be
admitted.`), like a throwing `admit`. Without it, model-invoking tools are refused as before.
