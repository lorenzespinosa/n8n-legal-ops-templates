# Rebuilding Legal-Ops Workflows in Make (Integromat)

Conceptual design sketch only — no Make scenario has been built or tested here. The historical n8n files do **not** implement the approval gates sketched below. In every proposed two-scenario path, staging stops; a separately triggered, explicitly approved action is required before CRM, SMS, or assignment. Do not connect live accounts from this guide.

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
Scenario A (proposed staging): Webhook → validate → Airtable duplicate lookup
  → Router
    ├─ existing: update the pending staging record → STOP
    └─ new: classify → write pending review request → STOP

Scenario B (SEPARATE approved-delivery proposal): trigger on recorded decision
  → verify approved state and same-key idempotency → Router
    ├─ urgent: notify coordinator; create mock-design CRM handoff → audit
    └─ standard: create mock-design CRM handoff → audit
```

### Make-Specific Notes

- **Validation**: Use a custom HTTP module calling a Code (Run JavaScript) step or use Make's built-in `parseJSON` + `ifempty` functions inline.
- **Duplicate check**: HTTP GET to Airtable with `filterByFormula` in query params. Use a Filter after to check `length(records) > 0`.
- **Human review gate design**: Scenario A stops at the queue. A separately triggered Scenario B must verify an explicit approval before any CRM write. This is a proposed design, not an implemented Make gate or a property of the historical n8n file.
- **Error handling**: Attach an Error Handler route to the Lawmatics HTTP module — retry 3x with exponential backoff using Make's built-in retry settings.

---

## 2. Missed Call Recovery

### Flow

```
Scenario A (proposed staging): missed-call webhook → normalize → filter missed inbound
  → classify → Router
      ├─ new potential client: write pending SMS review request → STOP
      └─ other: log if appropriate → STOP (no SMS)

Scenario B (SEPARATE approved-send proposal): trigger on recorded decision
  → verify approval, consent and duplicate suppression → send SMS → audit
```

### Make-Specific Notes

- **Phone normalization**: Use Make's `replace()` and `if()` functions inline: `if(substring(phone; 1; 1) != "+"; concat("+1"; replace(phone; "/[^0-9]/g"; "")); phone)`.
- **Human review gate design**: The SMS send belongs in a separate scenario after an explicit approval and consent check. The historical n8n graph instead connects its queue node directly to an SMS request; neither this Make sketch nor that graph proves a safe send path.
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
Scenario A (proposed staging): case webhook → validate → classify
  → write pending assignment review request → STOP

Scenario B (SEPARATE approved-assignment proposal): trigger on recorded decision
  → verify approved state → Router by case_type
      ├─ personal_injury: assign J. Greenfield
      ├─ dui_defense: assign S. Park
      ├─ criminal_defense: assign M. Torres
      └─ other: assign A. Chen
  → notify and audit the observed outcome
```

### Make-Specific Notes

- **Router with Filters**: Each Router route gets a Filter condition on `case_type`. The last route uses "Fallback" (no filter) to catch anything that doesn't match.
- **Human review gate design**: Staging stops before assignment; a separate scenario must verify approval before a downstream action. No Make implementation or historical n8n approval gate is claimed here.
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

This is a proposed two-scenario pattern to implement and test, not a deployed Make integration or a retroactive approval gate in the historical n8n templates.
