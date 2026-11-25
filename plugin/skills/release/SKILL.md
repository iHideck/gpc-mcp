---
description: Releases an app to Google Play with the gpc-mcp tools, from preparing the next version and setting up a new app to submitting for review and staged rollout. Use when asked things like "Release the next Android version", "Publish to Google Play", "Replace the screenshots", "Submit it for review", or "Pause the staged rollout".
---

# Release to Google Play

Use the gpc-mcp tools to take the next version from preparation to release. If you do not know the package name of the app, find it with `list_apps` or read `applicationId` in the app repository.

The preparation tools only write to the *unsent changes* (`pending`). Google Play receives nothing until you call `submit_for_review` or `save_draft`, which send everything together.

- Unsent changes stay across restarts of Claude Code. They are lost when they expire (`pending.expiresAt`) or when someone changes the app in Play Console. If they are lost, the tools report it in an error; make the changes again.
- While you prepare a release, tell the user not to change the app in Play Console.
- Google documents that a service account can have only one open edit. Reading or writing another app can make the unsent changes lost. Finish sending one app before you move to the next.
- If you no longer need the unsent changes, discard them with `discard_changes`.

Claude Code asks the user for confirmation every time a tool that you cannot undo (`set_phased_release` and `set_data_safety`) is called. Before you call one, explain in text what it will do, and call it only after the user agrees.

`save_draft` and `submit_for_review` do not ask for confirmation, because the user can withdraw the changes in Play Console until the release is published. Call them without waiting when the user has asked to save or to submit, so that the work continues while the user is away.

## 1. Check the current state

1. Use `get_release_status` to read the builds, the releases on each track, the review state (`review`), and the unsent changes.
2. Decide the track and the build (`versionCode`) to release. If they are not decided, ask the user.

## 2. Prepare the version

The tools that write compare with the current state and change only the difference, so you can safely repeat a call.

1. If the build is not uploaded yet, build an App Bundle as the app repository describes (for Flutter, `flutter build appbundle`) and upload it with `upload_bundle`. Only bundles signed with the upload key are accepted.
2. Use `select_build` to select the build for the draft release on the track.
3. Read the current text with `get_localizations`, and set the text to change with `set_localizations`. Set release notes for every language.
   - If the app repository has rules or a source of truth for the store listing text (such as `docs/release.md`), follow it.
   - Language codes are Google Play codes (`ja-JP`, `en-US`, `zh-TW`, and so on). They differ from App Store codes.
4. To change screenshots, use `replace_screenshots` for each language and image type (`imageType`).
5. To change the contact details shown in the store or the default language, call `set_app_info`. You can copy the contact details from another app with `sameAsApp`. This does not work while there are unsent changes, so do it first.
6. Tell the user about the `warnings` that each tool returns.

## Set up a new app

The API cannot do everything, so combine it with Play Console.

1. Create the app in Play Console and upload the first App Bundle there. The API cannot handle an app that has no builds.
2. Set the store listing text and images as in step 2. You can add a store listing language by passing all of its required text.
3. Save it as a draft with `save_draft`. The API cannot send an app that has never been published for review.
4. Enter the settings that only Play Console supports with the steps in [website.md](website.md): the App content declarations, the category and tags, the countries, and, if the app uses it, the Play Integrity API.
   - Set Data safety with `set_data_safety` if you have a CSV in the format that Play Console exports. The declaration is a legal commitment, so have the user check the CSV before you call it.
5. Send it for review on the **Publishing overview** page with the steps in [website.md](website.md#send-changes-for-review-and-publish-them).

Personal developer accounts created on or after November 13, 2023 need a closed test with at least 12 testers who stay opted in for 14 days in a row before they can release to production. Release the closed test to `alpha` or a track created in Play Console, with the same steps. After the 14 days, apply for access to production with the steps in [website.md](website.md#apply-for-access-to-production).

## 3. Submit for review

1. Run the unsent changes through Google checks with `validate_changes`. If `valid` is `false`, fix the `problem`.
2. Call `submit_for_review` if the user has asked to submit (for example, "Release the next Android version" or "Submit it for review"). Otherwise, ask the user first. `track` is required. Pass `userFraction` for a staged rollout.
3. Report the track, the build, the staged rollout percentage, the release notes (full text), and the sent changes. Until the release is published, the user can withdraw it by moving the changes back to **Changes not yet sent for review** on the **Publishing overview** page in Play Console.
4. After that, check the state in `review` from `get_release_status`. The review can take from a few hours to more than seven days.

The internal testing track (`internal`) has no review and is available right away.

## 4. Release

- If managed publishing is off, the release is published automatically after approval.
- If managed publishing is on, the release is not published after approval (the `review` state is `APPROVED_NOT_PUBLISHED`). The API has no operation to publish, so publish it on the **Publishing overview** page with the steps in [website.md](website.md#send-changes-for-review-and-publish-them).
- A staged rollout does not advance automatically. Use `set_phased_release` to change the percentage (`update`), pause (`pause`), resume (`resume`), or release to all users (`complete`). Releasing to all users cannot be undone. To change the percentage of a paused rollout, pass `userFraction` to `resume`.
- If you find a problem in a release to all users, you can halt it with `pause` in `set_phased_release`. New installs and updates get the previous release to all users, and users who already installed it keep it. Google rejects this if there is no previous release.

## When the app is rejected or you want to stop a review

- Ask the user to read the rejection reason in Play Console. The API cannot read it.
- After a rejection, the changes sometimes cannot be sent for review automatically. If a tool that sends returns that guidance, call it again with `notSentForReview: true`, and send it on the **Publishing overview** page with the steps in [website.md](website.md#send-changes-for-review-and-publish-them).
- If some changes are in review, the tools that send stop without sending. Wait for the review, or if the user agrees to withdraw them, send again with `cancelChangesInReview: true`.
- The API has no operation that only withdraws a review. Ask the user to move the changes back to **Changes not yet sent for review** on the **Publishing overview** page in Play Console.
