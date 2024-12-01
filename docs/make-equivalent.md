# Rebuilding Legal-Ops Workflows in Make (Integromat)

Conceptual guide for translating the n8n legal-ops templates to Make. Focuses on logic and module mapping, not UI clicks.

---

## Key Make Concepts Used

- **Router** — splits a single flow into parallel branches (equivalent to n8n IF/Switch)
- **Data Store** — persistent key-value storage (equivalent to Airtable staging tables)
- **HTTP Module** — generic API calls to any REST endpoint
- **Webhook** — custom incoming trigger
- **Filter** — conditional gate between modules (equivalent to n8n IF node)
- **Iterator** — loops through arrays (equivalent to n8n SplitInBatches)
- **Aggregator** — collects items back into a single bundle
- **Error Handler** — route attached to any module for retry/fallback logic

---

## 1. Client Intake Pipeline

### Flow

```
Webhook (Custom) → HTTP Module (validate via JSON) → HTTP Module (Airtable: check duplicates)
  → Router
    ├─ Route 1 [Filter: duplicate found] → HTTP Module (Airtable: update existing record)
    └─ Route 2 [Filter: new lead] → HTTP Module (OpenAI: classify case type)
         → HTTP Module (Airtable: add to Human Review Queue)  ← MANDATORY GATE
         → Router
              ├─ Route A [Filter: urgent] → HTTP Module (Slack: alert) + HTTP Module (Lawmatics: create)
              └─ Route B [Filter: standard] → HTTP Module (Lawmatics: create)
```

### Make-Specific Notes

- **Validation**: Use a custom HTTP module calling a Code (Run JavaScript) step or use Make's built-in `parseJSON` + `ifempty` functions inline.
- **Duplicate check**: HTTP GET to Airtable with `filterByFormula` in query params. Use a Filter after to check `length(records) > 0`.
- **Human review gate**: Write to Airtable Data Store or table. A separate scenario (triggered by Airtable webhook or scheduled poll) handles post-approval CRM writes.
- **Error handling**: Attach an Error Handler route to the Lawmatics HTTP module — retry 3x with exponential backoff using Make's built-in retry settings.

---

## 2. Missed Call Recovery

### Flow

```
Webhook (Custom — OpenPhone payload) → Code Module (extract caller info, normalize phone)
  → Filter [direction=inbound AND status=missed]
  → HTTP Module (OpenAI: intent classification)
  → Router
      ├─ Route 1 [Filter: intent=new_client]
      │    → HTTP Module (Airtable: Human Review Queue)  ← MANDATORY GATE
      │    → HTTP Module (OpenPhone: send SMS)
      │    → HTTP Module (Airtable: log to MissedCallLog)
      └─ Route 2 [Filter: not new_client]
           → HTTP Module (Airtable: log only, no SMS)
```

### Make-Specific Notes

- **Phone normalization**: Use Make's `replace()` and `if()` functions inline: `if(substring(phone; 1; 1) != "+"; concat("+1"; replace(phone; "/[^0-9]/g"; "")); phone)`.
- **Human review gate**: The SMS send should be in a SEPARATE scenario triggered only after the review queue record is marked "approved". In the primary scenario, stop after writing to the review queue.
- **Deduplication**: Before writing to the review queue, add an HTTP GET to Airtable filtering by phone + last 24 hours to avoid duplicate SMS for repeated missed calls.

---

## 3. Billing Sync

### Flow

```
Scheduler (Daily 6AM, weekdays only) → HTTP Module (Filevine: GET unbilled items)
  → Code Module (format billing records, detect conflicts)
  → Router
      ├─ Route 1 [Filter: has_conflicts=true]
      │    → HTTP Module (Airtable: write to BillingConflictQueue)
      │    → HTTP Module (Slack: alert billing coordinator)
      └─ Route 2 [always — valid records]
           → Iterator (loop through valid_records array)
           → HTTP Module (Clio: POST activity/time entry)  — one per record
           → Aggregator (collect results)
           → HTTP Module (Airtable: write audit log)
```

### Make-Specific Notes

- **Scheduling**: Use Make's built-in scheduling — set to run at a specific time, restrict to weekdays using a Filter with `formatDate(now; "E")` not in `["Sat","Sun"]`.
- **Batch processing**: Make doesn't batch natively like n8n. Use an Iterator to loop through records, then rate-limit with Make's "operations per minute" setting to stay within Clio API limits.
- **Conflict detection**: The Code module (or a series of Filters) checks for zero hours, missing IDs. Use a Router after to split clean vs. dirty records.
- **Data Store for idempotency**: Use a Make Data Store to track which matter_ids have already been synced today, preventing duplicate billing entries on re-runs.

---

## 4. Case Routing

### Flow

```
Webhook (Custom) → Code Module (extract + validate case details)
  → Filter [valid=true]
  → HTTP Module (OpenAI: classify case type + urgency score)
  → Code Module (parse AI response)
  → HTTP Module (Airtable: Human Review Queue)  ← MANDATORY GATE
  → Router (4 routes by case_type)
      ├─ Route 1 [Filter: personal_injury] → HTTP Module (Filevine: assign J. Greenfield)
      ├─ Route 2 [Filter: dui_defense] → HTTP Module (Filevine: assign S. Park)
      ├─ Route 3 [Filter: criminal_defense] → HTTP Module (Filevine: assign M. Torres)
      └─ Route 4 [Fallback/other] → HTTP Module (Filevine: assign A. Chen)
  → HTTP Module (Slack: notification)
  → HTTP Module (Airtable: audit log)
```

### Make-Specific Notes

- **Router with Filters**: Each Router route gets a Filter condition on `case_type`. The last route uses "Fallback" (no filter) to catch anything that doesn't match.
- **Human review gate**: Same pattern — write to Airtable queue, separate scenario handles post-approval assignment execution.
- **Slack notification**: After the Router branches converge (using a Merge or by placing Slack/audit after each branch), send a single Slack message. In Make, you may need to duplicate the Slack module on each branch since Make Routers don't reconverge natively.
- **Error handling**: Each Filevine HTTP module should have an Error Handler that writes failures to an Airtable error log and sends a Slack alert.

---

## General Migration Notes

| n8n Concept | Make Equivalent |
|---|---|
| Webhook trigger | Custom Webhook module |
| Code node (JavaScript) | Tools > Run JavaScript (or inline functions) |
| IF node | Filter (between modules) |
| Switch node | Router with Filters on each route |
| HTTP Request | HTTP > Make a Request |
| SplitInBatches | Iterator |
| Merge | Aggregator (or Array Aggregator) |
| Sticky Notes | Module notes (right-click > Add note) |
| Error handling | Error Handler route (retry/ignore/rollback) |
| Credentials | Connections (configured per module) |

### Human Review Gates in Make

Make doesn't have a built-in "wait for approval" step. The pattern is:

1. **Scenario A** (trigger workflow) writes to an Airtable review queue and stops
2. **Scenario B** (scheduled or Airtable webhook) polls for approved records and executes the downstream action

This two-scenario pattern is the standard approach for human-in-the-loop workflows in Make.
