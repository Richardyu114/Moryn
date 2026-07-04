# Changelog

## 0.2.0

Moryn v0.2.0 closes the first public release path around one default flow:

```text
setup -> context pack -> capture -> dashboard review -> approve -> sync
```

The release keeps Moryn focused as a local-first, user-owned, auditable context
store and handoff layer. It is not an agent platform, not a vector-memory SDK,
and not a hosted cloud service.

### Added

- `moryn setup` dry-run and safe `--apply` local setup path.
- Handoff Pack v0.2 through `moryn context pack`, including quality-gate
  evidence and required capture action.
- Auditable autocapture policy for low-risk handoffs, review-routed handoffs,
  and policy-archived smoke or duplicate captures.
- Dashboard review surfaces for Capture Inbox, Review Queue, Candidate Triage,
  visible saved-content search, recently saved content, and Shared copy status.
- Read-only `moryn eval recall` / `recall_eval` reports for golden queries,
  expected record ids, privacy checks, ranking reasons, and safe follow-up
  inspection actions.
- Dogfood demo and agent lifecycle smoke commands for the v0.2 default path.

### Changed

- Public docs now present the default path first and keep advanced governance
  surfaces optional.
- The dashboard first screen answers whether the user needs to act, what Moryn
  stores, what was recently saved, and whether the Shared copy is current.
- Release checks reject private store data, local-only scratch plans, temporary
  development plans, generated dashboard snapshots, and tarballs from package
  contents.

### Safety

- No silent canonical memory writes. Long-term memory changes require explicit
  Capture Inbox, Review Queue, or Candidate Triage approval.
- Evidence remains append-only and available through `/api/dashboard` even when
  the visible dashboard folds routine technical details.
- Private, secret, and sensitive records stay out of default recall, boot,
  lifecycle reports, and dashboard reads unless explicitly requested.
