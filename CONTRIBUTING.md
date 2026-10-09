# Contributing to n8n-legal-ops-templates

Thank you for contributing. The four original `workflows/*.json` files are historical examples for inspection, **not production-ready templates**. The separately tested `runtime/demo/` client-intake sandbox uses fictional data and a mock CRM; it is not a live legal integration. A contribution must not imply that a review-queue write alone enforces approval.

## Before You Submit

- [ ] Workflow JSON has `active: false`
- [ ] `meta.instanceId` is stripped from workflow JSON
- [ ] Root-level `id` is stripped from workflow JSON
- [ ] No API keys, tokens, or real credentials in any file
- [ ] All sample data uses fictional entities ("Greenfield & Associates")
- [ ] All phone numbers use 555-format, all IDs use `matter_99999` pattern
- [ ] No real client names, case numbers, or PII anywhere
- [ ] Node names follow the `CATEGORY - Action (System)` convention
- [ ] Any new consequential CRM, messaging, billing, or assignment path has an explicit, independently tested approval control; do not copy the ungated historical paths

## Legal Compliance

These files are not legal advice or a substitute for a production safety review. The original client-intake, missed-call, and case-routing graphs **do not** enforce human approval before their downstream actions; the historical billing formatter does **not** detect duplicate matter IDs. Do not connect them to real accounts. A new workflow that takes consequential action must be independently designed and tested with an explicit authorization boundary before anyone considers live use.

## Workflow JSON Standards

- Use the `Code` node — not the deprecated `Function` node
- Pin `typeVersion` to the version you tested against
- Set `active: false` in the root of the JSON
- Strip instance-specific fields: `meta.instanceId`, root `id`
- Error handling: refer to [n8n-error-handling-pattern](https://github.com/lorenzespinosa/n8n-error-handling-pattern) as design guidance; its sub-workflows are not imported by the historical JSON files

## Pull Request Process

1. Fork the repo and create a branch: `feat/your-template-name`
2. Add or update workflow JSON in `workflows/`
3. Add matching sample payloads in `payloads/` (success + failure paths)
4. Update `CHANGELOG.md` with your addition
5. Run the pre-submit checklist above
6. Open a PR — the existing CI checks JSON syntax and a few credential/active-flag string patterns; it does **not** prove a human gate, complete secret absence, consent, or runtime safety

## Reporting Issues

Use the issue templates provided in `.github/ISSUE_TEMPLATE/`.
