# gpc-mcp

English | [日本語](README.ja.md)

An unofficial MCP server for the Google Play Developer API. Install it as a Claude Code plugin, or run it with `npx` in any MCP client, then ask Claude to do your Google Play release work.

## Tools

| Tool | What it does |
| :- | :- |
| `list_apps` | Returns the name and package name of each app. |
| `get_release_status` | Returns the five newest builds, the releases on each track, and the review state of each release. |
| `get_localizations` | Returns the store listing text for each language (title, short description, full description, and video URL), the default language, and the release notes of a track. |
| `get_availability` | Returns the countries where a track is available. |
| `create_track` | Creates a closed testing track. |
| `get_testers` | Returns the Google Groups of testers for a testing track. |
| `set_testers` | Replaces the Google Groups of testers for a testing track. Email lists are not available in the API. |
| `upload_bundle` | Uploads an Android App Bundle to the unsent changes. Does not upload a file that Google Play already has. |
| `select_build` | Selects a build for the draft release of a track. Creates the draft release if the track has none. |
| `set_localizations` | Writes the store listing text and the release notes of the draft release for each language. Checks the character limits and URL formats before it writes. Creates a listing for a new language when you pass all required text. |
| `replace_screenshots` | Replaces the images for one language and one image type with the files you pass. Handles screenshots, the app icon, the feature graphic, and the TV banner. Checks the format and size of each image before it uploads. |
| `set_app_info` | Sets the contact email, phone, and website, and the default language. Can copy the contact details from another app. |
| `set_data_safety` | Writes the Data safety declaration from a CSV file in the format that Play Console exports. Each call requires your confirmation. |
| `validate_changes` | Runs the unsent changes through Google's checks. Sends nothing to Google Play. |
| `save_draft` | Saves the unsent changes to Google Play and keeps the release as a draft. |
| `submit_for_review` | Sends the draft release of a track and the unsent changes to Google Play. A staged rollout on the production track can target specific countries. Until the release is published, you can withdraw it in Play Console. |
| `set_phased_release` | Pauses, resumes, changes the percentage of, or completes a staged rollout. Pausing with no staged rollout halts the full release. New users and users who update get the previous full release, and users who already installed it are not affected. You cannot undo a release to all users. Each call requires your confirmation. |
| `discard_changes` | Discards all changes that you have not sent to Google Play. |

Tools that prepare a release write to *unsent changes*. Google Play receives nothing until `submit_for_review` or `save_draft` runs. In Claude Code, unsent changes stay across restarts. They are lost when they expire or when someone changes the app in Play Console. They can also be lost when you work on another app, because Google documents one open edit per user. The tools report the loss.

The Google Play API has no way to set the category, price, countries, or the App content declarations other than Data safety, to publish an update held by managed publishing, or to withdraw a review. Do these in Play Console.

## Skill

`/gpc-mcp:release` uses the tools above to take a version from preparation through review to staged rollout. When you say something like "Prepare the next Android version" or "Submit it for review", Claude loads the skill.

## Install

The MCP server requires Node 24 or later.

### Set up a service account

1. In the Google Cloud console, choose a project and enable the **Google Play Android Developer API** and the **Google Play Developer Reporting API**. Then create a service account and download a JSON key for it.
2. Move the JSON key to a path of your choice, for example `~/.config/gpc-mcp/service-account.json`. Run `chmod 600` on the file so that only you can read it.
3. In Play Console, go to **Users and permissions** and invite the service account by its email address. For each app, grant these permissions:
   - **View app information (read-only)**
   - **Release to production, exclude devices, and use Play App Signing**
   - **Release apps to testing tracks**
   - **Manage store presence**

### Claude Code

1. In Claude Code, run these commands:

   ```
   /plugin marketplace add iHideck/gpc-mcp
   /plugin install gpc-mcp@gpc-mcp
   ```

2. On the configuration screen, enter the path of the JSON key. To change it later, run `/plugin configure gpc-mcp@gpc-mcp`.

The plugin runs the MCP server on the Node in your PATH.

### Other MCP clients

In Claude Desktop, Cursor, and other MCP clients, run the server with `npx`. Add this server to the MCP configuration of the client, for example `claude_desktop_config.json` for Claude Desktop or `~/.cursor/mcp.json` for Cursor:

```json
{
  "mcpServers": {
    "gpc": {
      "command": "npx",
      "args": ["-y", "@ihideck/gpc-mcp"],
      "env": {
        "GPC_SERVICE_ACCOUNT_KEY": "/Users/you/.config/gpc-mcp/service-account.json"
      }
    }
  }
}
```

To run the server from source instead, clone the repository and install the dependencies:

```sh
git clone https://github.com/iHideck/gpc-mcp.git
cd gpc-mcp
npm ci --prefix plugin
```

Then set `"command": "node"` and `"args": ["/absolute/path/to/gpc-mcp/plugin/src/index.ts"]` in the configuration above.

Outside Claude Code, note the following:

- Set `GPC_SERVICE_ACCOUNT_KEY` to an absolute path, or a path that starts with `~/`.
- Claude Code asks for confirmation before each call to a tool that you cannot undo. Other clients may not. Set the client to ask for approval of `set_phased_release` and `set_data_safety`.
- Unsent changes are kept only while the server runs.
- The release skill is not loaded. To use it, give the client the instructions in [`plugin/skills/release/SKILL.md`](plugin/skills/release/SKILL.md).

## Development

The plugin is in `plugin/`. With the plugin, Claude Code installs only the dependencies in `plugin/package.json`. Keep development tools such as ESLint in the root `package.json`. The npm package `@ihideck/gpc-mcp` is also published from `plugin/`.

| Command | What it does |
| :- | :- |
| `make setup` | Installs the dependencies and downloads the API specifications from Google. |
| `make check` | Runs the same checks as CI (ESLint, formatting, type checks, and tests). |
| `make download-discovery` | Downloads the current API specifications from Google to `.local/` again. |
| `make validate-plugin` | Validates the plugin and marketplace configuration. |
| `make run-claude` | Starts Claude Code connected to the MCP server from your local source. |
| `make pack-npm` | Builds the npm package into `.local/` and checks that `npx` starts the server from it. |

The tests check that the path, parameters, and values of each request exist in the API specifications. Each CI run downloads the current specifications from Google and checks against them.

To test your local source against the real API, put the path of the JSON key in the `GPC_SERVICE_ACCOUNT_KEY` environment variable, then run `make run-claude`. The plugin configuration does not reach a plugin that `claude --plugin-dir` loads. In this setup, tools that write do not change Google Play. Instead, they return the request they would have sent as an error. To write to Google Play, also set `GPC_READ_ONLY=0`.

To publish to npm, run `npm publish` in `plugin/`. Its `prepack` script compiles `plugin/src/` to JavaScript in `plugin/dist/`, because Node does not strip types from files under `node_modules`. The Claude Code plugin runs `plugin/src/index.ts` directly.
