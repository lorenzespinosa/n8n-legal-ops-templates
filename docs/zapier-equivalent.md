# Rebuilding Legal-Ops Workflows in Zapier

Conceptual design sketch only — no Zap has been built or tested here. The historical n8n files do **not** implement the approval gates sketched below. A proposed staging Zap must stop before any CRM, SMS, or assignment action; only a separately triggered, explicitly approved Zap may deliver. Do not connect live accounts from this guide.

---

## Key Zapier Concepts Used

- **Paths** — conditional branching (equivalent to n8n IF/Switch). Each Path has a rule and its own sequence of steps.
- **Code by Zapier** — run JavaScript or Python inline (equivalent to n8n Code node)
- **Webhooks by Zapier** — catch or send webhooks
- **Filter** — stop the Zap if conditions aren't met (hard gate, not a branch)
- **Looping by Zapier** — iterate through arrays
- **Sub-Zaps** — reusable Zap fragments callable from other Zaps
- **Formatter by Zapier** — text/date/number transformations without code

---

## 1. Client Intake Pipeline

### Flow

```
Zap 1 (proposed staging): Catch Hook → validate → Filter valid → duplicate lookup
  → Paths
      ├─ existing: update pending staging record → STOP
      └─ new: classify → write pending review request → STOP

Zap 2 (SEPARATE approved-delivery proposal): trigger on recorded decision
  → Filter approved state → check same-key idempotency → Paths
      ├─ urgent: coordinator alert, proposed CRM handoff, audit
      └─ standard: proposed CRM handoff, audit
```

### Zapier-Specific Notes

- **Validation**: Code by Zapier (JavaScript) validates fields and returns `{valid: true/false, errors: [...]}`. The Filter step after checks `valid` equals `true`.
- **Phone normalization**: Handle in the Code step — `phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '')`.
- **Human review gate design**: Zap 1 stops at the queue; Zap 2 must verify an explicit approval before a CRM write. This is not an implemented Zap or a property of the historical n8n file.
- **Nested Paths**: Zapier supports Paths within Paths. Use the outer Path for duplicate check, inner Path for urgency routing.

---

## 2. Missed Call Recovery

### Flow

```
Zap 1 (proposed staging): Catch Hook → normalize → Filter missed inbound
  → classify → Paths
      ├─ new potential client: write pending SMS review request → STOP
      └─ other: log if appropriate → STOP (no SMS)

Zap 2 (SEPARATE approved-send proposal): trigger on recorded decision
  → Filter approved, consent, and duplicate suppression → send SMS → audit
```

### Zapier-Specific Notes

- **Filter as hard gate**: Zapier's Filter stops execution entirely (unlike n8n IF which has two output branches). Place it after the extraction Code step to kill the Zap for non-missed/non-inbound calls.
- **Human review gate design**: A proposed second Zap must verify approval and consent before SMS. The historical n8n graph instead connects its queue directly to an SMS request; neither that graph nor this unbuilt Zap proves a safe send path.
- **Deduplication**: Add a Webhooks step (GET Airtable) before the review queue write to check if this phone number already has a pending review from the last 24 hours. Use a Filter to skip if found.
- **SMS content**: The AI-suggested SMS text is stored in the review queue. The human reviewer can edit it in Airtable before approving.

---

## 3. Billing Sync

### Flow

```
Trigger: Schedule by Zapier (every day at 6AM)
  → Step 2: Code by Zapier (check if weekday — stop if Sat/Sun)
  → Step 3: Filter (stop if is_weekday=false)
  → Step 4: Webhooks by Zapier (GET Filevine — unbilled items)
  → Step 5: Code by Zapier (format billing records, detect conflicts, split valid vs. invalid)
  → Step 6: Paths
      ├─ Path A [conflicts detected]:
      │    → Webhooks by Zapier (POST Airtable — BillingConflictQueue)
      │    → Webhooks by Zapier (POST Slack — alert billing coordinator)
      │    → Looping by Zapier (iterate valid_records)
      │         → Webhooks by Zapier (POST Clio — create time entry)
      │    → Webhooks by Zapier (POST Airtable — audit log, status=partial)
      └─ Path B [no conflicts]:
           → Looping by Zapier (iterate valid_records)
                → Webhooks by Zapier (POST Clio — create time entry)
           → Webhooks by Zapier (POST Airtable — audit log, status=complete)
```

### Zapier-Specific Notes

- **Weekday check**: Schedule by Zapier runs daily. Use a Code step to check `new Date().getDay()` (0=Sun, 6=Sat) and a Filter to stop on weekends. Alternatively, Zapier's Schedule trigger supports "only on weekdays" in some plans.
- **Looping**: Zapier's Loop step iterates through the `valid_records` array. Each iteration makes one POST to Clio. Be aware of Zapier's task limits — each loop iteration counts as a task.
- **Rate limiting**: Zapier doesn't have built-in rate limiting. If Clio has rate limits, add a Delay step (Delay by Zapier) inside the loop — but this burns tasks. Consider batching in the Code step instead if Clio supports bulk create.
- **Idempotency**: Add a lookup step before each Clio write to check if the matter_id + sync_date already has an entry. Skip if found.
- **Historical source warning**: The existing n8n billing formatter does not detect duplicate matter IDs. The lookup above is an unimplemented design step, not a property of that JSON file.

---

## 4. Case Routing

### Flow

```
Zap 1 (proposed staging): Catch Hook → validate → Filter valid → classify
  → write pending assignment review request → STOP

Zap 2 (SEPARATE approved-assignment proposal): trigger on recorded decision
  → Filter approved state → Paths by case_type
      ├─ personal_injury: proposed assignment to J. Greenfield
      ├─ dui_defense: proposed assignment to S. Park
      ├─ criminal_defense: proposed assignment to M. Torres
      └─ other: proposed assignment to A. Chen
  → notify and audit the observed outcome
```

### Zapier-Specific Notes

- **Paths for routing**: Each Path checks `case_type` equals a specific value. The last Path (D) uses "otherwise" to catch fallback cases.
- **Duplication across Paths**: Zapier Paths don't reconverge. The Slack + audit log steps are duplicated in each Path. To reduce duplication, use a **Sub-Zap**: create a reusable Sub-Zap for "notify + audit" and call it from each Path.
- **Human review gate design**: Zap 1 stops at the queue; a separate approved-decision Zap would own assignment paths. No Zapier implementation or historical n8n approval gate is claimed.
- **Attorney roster as lookup**: Instead of hardcoding attorneys in each Path, use a Lookup Table (Formatter by Zapier) or a Storage by Zapier entry mapping case_type to attorney name. This makes roster changes easier.

---

## General Migration Notes

| n8n Concept | Zapier Equivalent |
|---|---|
| Webhook trigger | Webhooks by Zapier (Catch Hook) |
| Code node (JavaScript) | Code by Zapier (JavaScript or Python) |
| IF node | Filter (hard stop) or Paths (branching) |
| Switch node | Paths (multiple branches with conditions) |
| HTTP Request | Webhooks by Zapier (Custom Request) |
| SplitInBatches | Looping by Zapier |
| Merge | Not natively supported — use Sub-Zaps or duplicate steps |
| Sticky Notes | Step notes (add description to any step) |
| Error handling | Built-in error handling + Zapier Manager alerts |
| Credentials | Connected accounts (per-app authentication) |
| Schedule trigger | Schedule by Zapier |

### Human Review Gates in Zapier

This guide proposes a two-Zap approval design rather than treating a queue write as a gate:

1. **Zap 1** (trigger workflow) writes the pending action to an Airtable review queue and stops
2. **Zap 2** (triggered by Airtable "Record Updated" with status=approved) executes the downstream action (CRM write, SMS send, attorney assignment)

The design must be independently built and tested before any live use; it is not implemented by the historical templates or by this guide.

### Task/Cost Considerations

- Every step in a Zap counts as a task. Loops multiply this — a loop of 10 items = 10 tasks per step inside the loop.
- Paths count as tasks only for the branch that executes.
- Sub-Zaps count tasks in both the calling Zap and the Sub-Zap.
- For high-volume workflows (like billing sync with many matters), monitor task usage closely.
