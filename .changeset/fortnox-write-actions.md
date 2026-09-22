---
'@yolk-sdk/connectors': patch
---

Add Fortnox customer and invoice write capabilities alongside the ten read actions. The new `fortnox.create_customer`, `fortnox.update_customer`, `fortnox.create_invoice`, and `fortnox.update_invoice` actions use `write` access metadata, typed schemas, JSON request envelopes, and resource-scoped OAuth hints. Sending, booking, cancellation, and payment actions remain absent so hosts can keep outbound invoice approval policy separate. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
