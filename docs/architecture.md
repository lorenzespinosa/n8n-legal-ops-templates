# Legal Ops System Architecture

## Overview

These templates form an integrated system for law firm operations. Each workflow handles one domain but they connect through shared patterns.

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

All systems use Airtable as a staging/buffer layer between source systems. This prevents direct API coupling and provides an audit trail.

```
Source → Airtable (staging) → Destination
                ↓
          Error Handler → Dead Letter Queue
                ↓
          Audit Log (PII masked)
```

## Human Review Gates

Every decision-making workflow includes a mandatory human review gate:
- **Case routing:** Attorney assignment requires human approval
- **Missed call recovery:** SMS send requires human approval
- **Intake classification:** High-urgency cases route to Slack for immediate review

No fully autonomous legal decisions. Ever.
