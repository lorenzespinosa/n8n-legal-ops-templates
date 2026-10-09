# Historical Legal-Ops Patterns — Not a Deployment Architecture

## Overview

The four original `workflows/*.json` files are illustrative, importable historical examples, not an integrated, tested, or deployment-ready system. They contain real external-service hosts with placeholder identifiers and missing credential bindings; configuring them may make outbound calls. The separately tested fictional-data client-intake sandbox is under `runtime/demo/`. Do not connect the older files to live accounts or client records.

The sketch below is conceptual only. It does **not** prove the historical graphs are connected, approval-gated, failure-safe, or fully audit-logged.

```
                    ┌──────────────┐
                    │  CAPTURE     │
                    │  LAYER       │
                    ├──────────────┤
                    │ Web forms    │
                    │ Phone calls  │
                    │ Referrals    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  INTAKE      │
                    │  PIPELINE    │──── Missed Call Recovery
                    ├──────────────┤
                    │ Validate     │
                    │ Classify     │
                    │ Route        │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼───┐ ┌─────▼─────┐ ┌───▼──────┐
       │  CASE    │ │  BILLING  │ │  COMMS   │
       │  ROUTING │ │  SYNC     │ │  LAYER   │
       ├──────────┤ ├───────────┤ ├──────────┤
       │ AI type  │ │ Time →    │ │ SMS      │
       │ classify │ │ Invoice   │ │ Email    │
       │ Assign   │ │ Conflict  │ │ Slack    │
       │ attorney │ │ detect    │ │ alerts   │
       └──────────┘ └───────────┘ └──────────┘
```

## Data Flow

Some historical paths write to an Airtable queue, but that write is not a reviewer decision and does not prevent downstream CRM, SMS, or assignment attempts. The error-handler, dead-letter, and audit paths drawn below are design intentions, not acceptance-tested controls on every branch.

```
Source → Airtable (staging) → Destination
                ↓
          Error Handler → Dead Letter Queue
                ↓
          Audit Log (PII masked)
```

## Review boundary — what the historical graphs actually do

- **Client intake:** a queue write has no approval consumer; the CRM path can proceed without a recorded reviewer decision. An urgent Slack alert is not approval.
- **Missed-call recovery:** the node named Human Review Gate flows directly to an OpenPhone SMS-send request. There is no enforced sign-off or consent check between those nodes.
- **Case routing:** the queue does not block attorney-assignment requests until a reviewer decision is recorded.
- **Billing sync:** the conflict predicate flags missing matter IDs and non-positive hours, not duplicate matters; valid-looking entries can proceed toward Clio independently of the conflict queue.

Only the **separate fictional intake sandbox** in `runtime/demo/` has a counted, test-simulated reviewer-decision gate before a mock CRM write. It is not a live legal workflow or evidence that the other historical templates are safe. Do not activate those templates with real systems.
