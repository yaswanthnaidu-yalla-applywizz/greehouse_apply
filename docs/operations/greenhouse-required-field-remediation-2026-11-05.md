# Greenhouse required-field remediation procedure

**Purpose:** provide an operator-reviewed list of historical applications affected by confirmed required-field and date-provenance code bugs. The attached report is read-only evidence from PostgreSQL DB2. It does not authorize or perform a historical application change.

## Report schema

Each report row records:

| Column | Meaning |
|---|---|
| Application ID | `gh_candidate_applications.id` |
| Current status | Status observed during the read-only DB2 query |
| Template URL | The job URL associated with the stored scan |
| Candidate ID | `gh_candidate_applications.applywizz_id` |
| Remediation action | Exactly `rescan-and-reresolve`, `reresolve`, or `review-only` |
| Field changes | Confirmed stale template or resolved-field shape; no proposed candidate answer is invented |
| Evidence | DB2 row/template facts and the diagnostic evidence supporting classification |
| Operator review state | Whether a review timestamp/manual edit was present, and whether further review is required |

## Operator procedure

1. Read the matching row and its evidence in `.ai/diagnostics/required-fields-2026-11-03/remediation-report-2026-11-05.md`.
2. For `review-only`, inspect the record manually and preserve any existing operator edits. Do not run a rescan or resolution based on this report alone.
3. For `rescan-and-reresolve` or `reresolve`, the operator must first review the record and explicitly approve a separate, idempotent operation. That operation must re-read the current application and template, preserve non-empty authoritative edits, honor the 35-field cap, and write safely under its own audited approval.
4. If the current job page cannot be confirmed as a Greenhouse application, or date provenance cannot be established from the matching employment/education record, stop and keep the item under operator review.

This procedure only describes a possible future operator action. It does not change application status, queue state, retry count, resolved fields, or submission state. Never submit an application as part of remediation.

## Evidence limits

The Walker-Miller rows share a DB2 template containing only the newsletter email and Constant Contact honeypot, while the diagnostic investigation found the application form and required GED field in an embedded Greenhouse frame. The November 5 live replay redirected to generic careers content and did not independently verify the fix; confirm the active job page before any future scan.

The Samsung row has four stored month-component answers represented as full ISO dates. The diagnostic replay established the generic raw-date provenance bug. The report recommends re-resolution through the corrected section-aware logic; it does not assert the candidate's correct historical months. If the corresponding section record cannot provide a month, leave the field unresolved for operator review.
