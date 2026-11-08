# gpc-mcp

English | [日本語](README.ja.md)

An unofficial MCP server for the Google Play Developer API. Install it as a Claude Code plugin, then ask Claude Code to do your Google Play release work.

## Tools

| Tool | What it does |
| :- | :- |
| `list_apps` | Returns the name and package name of each app. |
| `get_release_status` | Returns the five newest builds, the releases on each track, and the review state of each release. |
| `get_localizations` | Returns the store listing text for each language (title, short description, full description, and video URL), the default language, and the release notes of a track. |

## Install

The MCP server runs on the Node in your PATH. It requires Node 24 or later.

1. In the Google Cloud console, choose a project and enable the **Google Play Android Developer API** and the **Google Play Developer Reporting API**. Then create a service account and download a JSON key for it.
2. Move the JSON key to a path of your choice, for example `~/.config/gpc-mcp/service-account.json`. Run `chmod 600` on the file so that only you can read it.
3. In Play Console, go to **Users and permissions** and invite the service account by its email address. For each app, grant these permissions:
   - **View app information (read-only)**
   - **Release to production, exclude devices, and use Play App Signing**
   - **Release apps to testing tracks**
   - **Manage store presence**
4. In Claude Code, run these commands:

   ```
   /plugin marketplace add iHideck/gpc-mcp
   /plugin install gpc-mcp@gpc-mcp
   ```

5. On the configuration screen, enter the path of the JSON key. To change it later, run `/plugin configure gpc-mcp@gpc-mcp`.

## Development

The plugin is in `plugin/`. With the plugin, Claude Code installs only the dependencies in `plugin/package.json`. Keep development tools such as ESLint in the root `package.json`.

| Command | What it does |
| :- | :- |
| `make setup` | Installs the dependencies and downloads the API specifications from Google. |
| `make check` | Runs the same checks as CI (ESLint, formatting, type checks, and tests). |
| `make download-discovery` | Downloads the current API specifications from Google to `.local/` again. |
| `make validate-plugin` | Validates the plugin and marketplace configuration. |

The tests check that the path, parameters, and values of each request exist in the API specifications. Each CI run downloads the current specifications from Google and checks against them.
