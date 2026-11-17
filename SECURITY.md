# Security policy

## Supported versions

Only the latest release receives security fixes.

## Report a vulnerability

Do not open a public issue for a security vulnerability. Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/iHideck/gpc-mcp/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and its impact.

Do not include your own service account key in the report.

You will get a reply within 14 days. After a fix is released, the advisory is published with credit to you unless you ask otherwise.

## Scope

gpc-mcp reads the service account JSON key from the path in `GPC_SERVICE_ACCOUNT_KEY` and sends requests only to `oauth2.googleapis.com`, `androidpublisher.googleapis.com`, and `playdeveloperreporting.googleapis.com`. Report any behavior that sends your key or tokens anywhere else, or that sends changes to Google Play without the confirmation the tool describes.
