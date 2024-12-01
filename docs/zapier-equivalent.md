# Rebuilding Legal-Ops Workflows in Zapier

Conceptual guide for translating the n8n legal-ops templates to Zapier. Focuses on logic and step mapping, not UI navigation.

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
Trigger: Webhooks by Zapier (Catch Hook)
  → Step 2: Code by Zapier (validate required fields, normalize phone to E.164)
  → Step 3: Filter (stop if valid=false)
  → Step 4: Webhooks by Zapier (GET Airtable — check duplicates by email/phone)
  → Step 5: Paths
      ├─ Path A [duplicate found]:
      │    → Webhooks by Zapier (PATCH Airtable — update existing record)
      └─ Path B [new lead]:
           → Webhooks by Zapier (POST OpenAI — classify case type)
           → Code by Zapier (parse AI response)
           → Webhooks by Zapier (POST Airtable — Human Review Queue)  ← MANDATORY GATE
           → Paths
                ├─ Path B1 [urgent]:
                │    → Webhooks by Zapier (POST Slack — urgent alert)
                │    → Webhooks by Zapier (POST Lawmatics — create contact)
                └─ Path B2 [standard]:
                     → Webhooks by Zapier (POST Lawmatics — create contact)
```

### Zapier-Specific Notes

- **Validation**: Code by Zapier (JavaScript) validates fields and returns `{valid: true/false, errors: [...]}`. The Filter step after checks `valid` equals `true`.
- **Phone normalization**: Handle in the Code step — `phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '')`.
- **Human review gate**: Write to Airtable review queue and stop. A separate Zap triggers on Airtable record update (status changed to "approved") and executes the CRM write.
- **Nested Paths**: Zapier supports Paths within Paths. Use the outer Path for duplicate check, inner Path for urgency routing.

---

## 2. Missed Call Recovery

### Flow

```
Trigger: Webhooks by Zapier (Catch Hook — OpenPhone payload)
  → Step 2: Code by Zapier (extract caller info, normalize phone, check if missed inbound)
  → Step 3: Filter (stop if direction != inbound OR status != missed)
  → Step 4: Webhooks by Zapier (POST OpenAI — intent classification)
  → Step 5: Code by Zapier (parse AI response, determine if new potential client)
  → Step 6: Paths
      ├─ Path A [new potential client]:
      │    → Webhooks by Zapier (POST Airtable — Human Review Queue)  ← MANDATORY GATE
      │    → Webhooks by Zapier (POST OpenPhone — send SMS)
      │    → Webhooks by Zapier (POST Airtable — log to MissedCallLog)
      └─ Path B [not new client]:
           → Webhooks by Zapier (POST Airtable — log only)
```

### Zapier-Specific Notes

- **Filter as hard gate**: Zapier's Filter stops execution entirely (unlike n8n IF which has two output branches). Place it after the extraction Code step to kill the Zap for non-missed/non-inbound calls.
- **Human review gate**: Same two-Zap pattern. Zap 1 writes to review queue. Zap 2 (triggered by Airtable "record updated" with status=approved) sends the actual SMS.
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

---

## 4. Case Routing

### Flow

```
Trigger: Webhooks by Zapier (Catch Hook)
  → Step 2: Code by Zapier (extract + validate case details)
  → Step 3: Filter (stop if valid=false)
  → Step 4: Webhooks by Zapier (POST OpenAI — classify + urgency score)
  → Step 5: Code by Zapier (parse AI classification)
  → Step 6: Webhooks by Zapier (POST Airtable — Human Review Queue)  ← MANDATORY GATE
  → Step 7: Paths
      ├─ Path A [personal_injury]:
      │    → Webhooks by Zapier (POST Filevine — assign J. Greenfield)
      │    → Webhooks by Zapier (POST Slack — notification)
      │    → Webhooks by Zapier (POST Airtable — audit log)
      ├─ Path B [dui_defense]:
      │    → Webhooks by Zapier (POST Filevine — assign S. Park)
      │    → Webhooks by Zapier (POST Slack — notification)
      │    → Webhooks by Zapier (POST Airtable — audit log)
      ├─ Path C [criminal_defense]:
      │    → Webhooks by Zapier (POST Filevine — assign M. Torres)
      │    → Webhooks by Zapier (POST Slack — notification)
      │    → Webhooks by Zapier (POST Airtable — audit log)
      └─ Path D [other / fallback]:
           → Webhooks by Zapier (POST Filevine — assign A. Chen)
           → Webhooks by Zapier (POST Slack — notification)
           → Webhooks by Zapier (POST Airtable — audit log)
```

### Zapier-Specific Notes

- **Paths for routing**: Each Path checks `case_type` equals a specific value. The last Path (D) uses "otherwise" to catch fallback cases.
- **Duplication across Paths**: Zapier Paths don't reconverge. The Slack + audit log steps are duplicated in each Path. To reduce duplication, use a **Sub-Zap**: create a reusable Sub-Zap for "notify + audit" and call it from each Path.
- **Human review gate**: Same two-Zap pattern. The review queue write happens BEFORE the Paths. In production, the Paths would live in Zap 2 (triggered by approval), not Zap 1.
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

Zapier doesn't support "pause and wait for approval." The standard pattern:

1. **Zap 1** (trigger workflow) writes the pending action to an Airtable review queue and stops
2. **Zap 2** (triggered by Airtable "Record Updated" with status=approved) executes the downstream action (CRM write, SMS send, attorney assignment)

This is functionally identical to the Make two-scenario pattern.

### Task/Cost Considerations

- Every step in a Zap counts as a task. Loops multiply this — a loop of 10 items = 10 tasks per step inside the loop.
- Paths count as tasks only for the branch that executes.
- Sub-Zaps count tasks in both the calling Zap and the Sub-Zap.
- For high-volume workflows (like billing sync with many matters), monitor task usage closely.
