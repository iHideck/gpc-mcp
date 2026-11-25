# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `save_draft` and `submit_for_review` no longer ask for confirmation in Claude Code, because you can withdraw the changes in Play Console until the release is published. `set_phased_release` and `set_data_safety` still ask.

## [1.0.0] - 2026-11-17

The first release.

### Added

- Tools that read the state of an app: `list_apps`, `get_release_status`, `get_localizations`, `get_availability`, and `get_testers`.
- Tools that prepare a release in the unsent changes: `upload_bundle`, `select_build`, `set_localizations`, `replace_screenshots`, `set_app_info`, `create_track`, and `set_testers`.
- Tools that check, send, or discard the unsent changes: `validate_changes`, `save_draft`, `submit_for_review`, and `discard_changes`. `save_draft` and `submit_for_review` require user confirmation on each call.
- `set_phased_release` to pause, resume, change the percentage of, or complete a staged rollout, and to halt a release to all users. Each call requires user confirmation.
- `set_data_safety` to write the Data safety declaration from a CSV file that Play Console exports. Each call requires user confirmation.
- `set_app_info` can copy the contact details from another app with `sameAsApp`.
- `submit_for_review` can target countries for a staged rollout on the production track.
- The `release` skill, which takes a version from preparation through review to staged rollout.
- In Claude Code, unsent changes stay across restarts.
- A Claude Code plugin and marketplace, and the npm package `@ihideck/gpc-mcp` for other MCP clients (`npx @ihideck/gpc-mcp`).
- Tests that check every request against the Discovery documents that Google currently publishes. CI also runs them on the 1st and 15th of each month to detect API changes.

[Unreleased]: https://github.com/iHideck/gpc-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/iHideck/gpc-mcp/releases/tag/v1.0.0
