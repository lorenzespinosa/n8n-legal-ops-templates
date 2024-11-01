# Changelog

All notable changes to n8n-legal-ops-templates are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

## [0.1.0] - 2024-11-01

### Added
- Initial repository scaffold with MIT license, CONTRIBUTING.md, and issue templates
- GitHub Actions CI for JSON validation (credential leak detection, active flag check)
- Stale issue bot configuration (auto-close after 30 days)
- `.gitignore` blocking credential files and n8n instance metadata
- README shell with legal ops system architecture diagram
- Legal disclaimer: templates provide workflow logic, not legal advice
- Error handling patterns referenced from n8n-error-handling-pattern
- Repository structure: `workflows/`, `payloads/`, `docs/`
