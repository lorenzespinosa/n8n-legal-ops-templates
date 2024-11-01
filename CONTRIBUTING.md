# Contributing to n8n-legal-ops-templates

Thank you for contributing. This repo provides production-quality n8n workflow templates for legal operations — contributions must meet the same quality bar.

## Before You Submit

- [ ] Workflow JSON has `active: false`
- [ ] `meta.instanceId` is stripped from workflow JSON
- [ ] Root-level `id` is stripped from workflow JSON
- [ ] No API keys, tokens, or real credentials in any file
- [ ] All sample data uses fictional entities ("Greenfield & Associates")
- [ ] All phone numbers use 555-format, all IDs use `matter_99999` pattern
- [ ] No real client names, case numbers, or PII anywhere
- [ ] Node names follow the `CATEGORY - Action (System)` convention
- [ ] Human review gates are present on all decision-making workflows

## Legal Compliance

These templates provide workflow logic patterns only — never legal advice. All workflows that make decisions (case routing, conflict checks, urgency scoring) MUST include a human-in-the-loop gate before any action is taken.

## Workflow JSON Standards

- Use the `Code` node — not the deprecated `Function` node
- Pin `typeVersion` to the version you tested against
- Set `active: false` in the root of the JSON
- Strip instance-specific fields: `meta.instanceId`, root `id`
- Error handling: import the patterns from [n8n-error-handling-pattern](https://github.com/lorenzespinosa/n8n-error-handling-pattern)

## Pull Request Process

1. Fork the repo and create a branch: `feat/your-template-name`
2. Add or update workflow JSON in `workflows/`
3. Add matching sample payloads in `payloads/` (success + failure paths)
4. Update `CHANGELOG.md` with your addition
5. Run the pre-submit checklist above
6. Open a PR — the CI will validate JSON syntax and check for credentials

## Reporting Issues

Use the issue templates provided in `.github/ISSUE_TEMPLATE/`.
