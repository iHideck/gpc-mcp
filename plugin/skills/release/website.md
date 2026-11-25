# Settings that only Play Console supports

The Google Play Developer API cannot set the following. Enter them in Play Console with Claude in Chrome, which works in the user's own Chrome, where the user is already signed in.

- [App content](#app-content): privacy policy, ads, advertising ID, app access, content rating, target audience, government apps, and health apps
- [Category and tags](#category-and-tags)
- [Countries and regions](#countries-and-regions) of the production track and closed testing tracks
- [Play Integrity API](#play-integrity-api): linking a Cloud project
- [Sending changes for review and publishing them](#send-changes-for-review-and-publish-them), when the API cannot send them
- [Applying for access to production](#apply-for-access-to-production)

## Before you start

1. Read the values to enter from the app's repository (for example, `docs/google-play.md`, `docs/release.md`, or the README). Ask the user only for the values that you cannot find there.
2. Check that the Claude in Chrome tools (`mcp__claude-in-chrome__*`) are available. If a skill for Claude in Chrome is available, follow it. If the tools are not available, follow [When Claude in Chrome is not available](#when-claude-in-chrome-is-not-available).
3. Send the unsent changes with `save_draft` or `submit_for_review`, or discard them with `discard_changes`. A change in Play Console makes the unsent changes lost.
4. Open [Play Console](https://play.google.com/console) in a new tab, and open the app. If the sign-in page or a two-step verification prompt appears, ask the user to sign in. Never enter a password or a verification code.

The labels below are from the English Play Console. If Play Console is in another language (for example, Japanese), find the label with the same meaning. Google sometimes moves pages in the sidebar; if a page is not where these steps say, search for its name with the search box at the top of Play Console. Take a screenshot after each save, and compare the page with the values you entered.

Changes that you save in Play Console go to **Changes not yet sent for review** on the **Publishing overview** page. Google Play receives them only when they are sent for review.

## App content

Open **Policy and programs** > **App content** in the sidebar. The page lists the declarations that the app still needs. For each one below, click **Start** (or **Manage** if it has answers), enter the answers from the repository, and click **Save**.

- **Privacy policy**: the privacy policy URL.
- **Ads**: whether the app contains ads, including ads that SDKs show.
- **Advertising ID**: whether the app uses the advertising ID, and if it does, every purpose. The answer must match the `com.google.android.gms.permission.AD_ID` permission in the manifest of the uploaded build.
- **App access**: **All functionality is available without any access restrictions**, or the instructions to reach the restricted features. If the instructions need a user name and password, ask the user to enter them, because they include a password.
- **Content ratings**: the IARC questionnaire. Enter the email address, select the category, answer every question, click **Save**, and then click **Submit** on the summary. Report the rating that Play Console shows.
- **Target audience and content**: the target age groups, and whether the app could unintentionally appeal to children. If the target includes children under 13, answer the extra Families questions.
- **Government apps**: whether the app is developed by or on behalf of a government.
- **Health apps**: the health features of the app, or that it has none.

Set **Data safety** with `set_data_safety` instead, as `SKILL.md` describes.

Report every answer that you entered. The declarations are a commitment to Google, so the user should check them before they are sent for review.

## Category and tags

1. Open **Grow users** > **Store presence** > **Store settings** in the sidebar.
2. Under **App category**, click **Edit**. Select **App** or **Game**, select the category, and click **Save**.
3. Under **Tags**, click **Manage tags**. Select up to five tags that describe the app, and click **Save**.

Set the contact details on this page with `set_app_info` instead.

## Countries and regions

1. Open **Test and release** > **Production** in the sidebar. For a closed testing track, open **Test and release** > **Testing** > **Closed testing**, and click **Manage track** on the track.
2. Open the **Countries / regions** tab, and click **Add countries / regions** (or **Edit countries / regions**).
3. Select the countries from the repository, and click **Add countries / regions**. To remove countries, select them on the tab and click **Remove**.
4. Check the list on the tab, and compare it with `get_availability`.

## Play Integrity API

1. Open **Test and release** > **App integrity** in the sidebar.
2. Under **Play Integrity API**, click **Link a Cloud project**.
3. Select the Google Cloud project from the repository, and click **Link project**. If the project is not in the list, ask the user to check that their Google account can open the project.
4. Check that the page shows the project number.

## Send changes for review and publish them

Do this when the API cannot send the changes: for an app that has never been published, or when a tool returns the guidance to send it in Play Console (see `notSentForReview` in `SKILL.md`).

1. Open **Publishing overview** in the sidebar.
2. Under **Changes not yet sent for review**, read every change in the list.
3. Show the user the list of changes, and click **Send changes for review** (the label can include the number of changes) only after the user agrees. Then click **Send changes for review** in the dialog.
4. If managed publishing is on, an approved change waits under **Changes ready to publish**. Show the user the list, and click **Publish changes** only after the user agrees. Users get the release when you publish it.
5. Check the state in `review` from `get_release_status`.

## Apply for access to production

Personal developer accounts created on or after November 13, 2023 need this before they can release to production. The button appears after a closed test has had at least 12 testers who stayed opted in for 14 days in a row.

1. Open **Dashboard** in the sidebar, and click **Apply for production**.
2. Answer the questions about the closed test, the app, and its readiness for production. Write the answers from the repository and from what you know about the closed test (`get_testers` and `get_release_status`). Ask the user for the facts that you cannot find, such as how testers were recruited and what feedback they gave.
3. Show the user every answer, and click **Apply** only after the user agrees. Google replies by email, usually within seven days.

## When Claude in Chrome is not available

Ask the user to enter the settings in Play Console. Write the steps in a numbered list with the URL to open, the labels on the page, and the values to enter. Ask the user to tell you when they finish. Then check what you can: compare the countries with `get_availability`, and check the review state with `get_release_status`. For the other settings, which the API cannot read, ask the user for a screenshot of the page.
