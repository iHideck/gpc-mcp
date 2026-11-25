# Contributing

Thank you for your interest in gpc-mcp. You can write issues and pull requests in English or Japanese.

## Report a bug or request a feature

Open an issue with a template:

- [Bug report](https://github.com/iHideck/gpc-mcp/issues/new?template=bug_report.yml)
- [Feature request](https://github.com/iHideck/gpc-mcp/issues/new?template=feature_request.yml)

Do not put your service account key or its contents in an issue. To report a security vulnerability, follow [SECURITY.md](SECURITY.md).

## Send a pull request

1. For a change larger than a typo fix, open an issue first so that we can agree on the approach.
2. Set up the repository and run the checks as described in [Development](README.md#development) in the README.
3. Keep each pull request to one purpose. If a change adds or changes a tool, update the tool table in both `README.md` and `README.ja.md`, and add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
4. Before you open the pull request, make sure that `make check` and `make validate-plugin` pass.

### Rules for changes

- Every request that the server sends must exist in Google's Discovery documents for the Google Play Developer API and the Google Play Developer Reporting API. The tests check each request against the documents that Google currently publishes.
- Tests must not call the real Google Play API. Use the fakes in `test/fake-api.ts` and `test/fake-play.ts`.
- Text that users see (tool descriptions, parameter descriptions, errors, progress messages, and the skill) is in English.
- Tools that prepare a release write only to the unsent changes (the open edit). Only `save_draft`, `submit_for_review`, and tools that require user confirmation may commit an edit or otherwise send changes to Google Play. A tool that does something you cannot undo, such as changing a staged rollout or writing the Data safety declaration, must require user confirmation. Do not require it for a tool that you can undo before the release is published, such as `submit_for_review`, because it stops unattended sessions. Set `_meta["anthropic/requiresUserInteraction"]` on it.
- Do not return or log the service account key or access tokens, including in error messages.

When you try your change against the real API with `make run-claude`, keep the default `GPC_READ_ONLY=1` unless you mean to write to Google Play.
