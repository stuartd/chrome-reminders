# Meeting Reminders

A small Chrome extension for those meetings you miss while deep in code. It sends Windows desktop notifications **15 minutes before, 5 minutes before, and at the start**, even while Chrome is in the background.

The first version includes:

- Read-only Google Calendar sync of the primary calendar, covering the next seven days and refreshing every five minutes.
- Manual meetings, so you can try it without setting up Google access.
- An immediate notification test and a one-minute background test.
- Best-effort Google Meet detection: once an active call is detected for a matching meeting, remaining reminders for that occurrence are skipped.
- Notification actions to open the meeting or dismiss its remaining reminders.
- Local persistence, alarm reconstruction when the worker starts, and bounded catch-up after sleep.

## Try it on Windows

1. Copy this repository to your Windows machine (or extract the supplied ZIP).
2. Open `chrome://extensions` in your **work Chrome profile**.
3. Enable **Developer mode**, click **Load unpacked**, and select the **`extension` folder** containing `manifest.json`.
4. Pin **Meeting Reminders** using Chrome's extensions menu, then open it.
5. Click **In 1 minute**, close the popup, and switch to your editor. A desktop notification should arrive about a minute later.
6. Expand **Add a meeting manually**, give it a future start time, and save it. A Meet link is optional.

If Developer mode or Load unpacked is disabled by policy, your workplace administrator needs to approve/distribute the extension. This extension does not bypass managed Chrome policies. This is an unpacked development build, not a published Chrome Web Store extension.

In **Windows Settings → System → Notifications**, allow Google Chrome notifications and banners. Check sound settings and Focus / Do Not Disturb too. `Test now` verifies notification delivery; the one-minute test verifies that it works while you are coding in another application. The extension requests a persistent, audible notification; Windows controls the actual banner lifetime and notification sound. It does not play a separate alarm sound or steal focus.

Chrome must be running and the computer must be awake. The popup and Calendar website can be closed. Refresh any already-open Meet tabs after first installing or reloading the extension.

## Connect Google Calendar

Automatic Calendar access requires a real Google OAuth client for this extension. **No client credentials are bundled**, so the initial build has its Connect button disabled. Manual meetings and notification tests work immediately.

First, open [Google Calendar](https://calendar.google.com/) in your work profile and confirm that your meetings appear in the **primary calendar**. Shared/secondary calendars, non-Google meeting platforms and other Chrome profiles are not supported in this first version.

One-time setup (you or your work administrator):

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create the project you will use for this extension and enable the **Google Calendar API**.
2. Configure the OAuth consent screen / Google Auth Platform branding and audience. For an organisation-owned project, use an internal audience if available; for an external app in testing, add the account that will test it. Organisation policy may require admin approval. External testing-mode grants can expire and require reconnection.
3. Configure the read-only scope `https://www.googleapis.com/auth/calendar.events.readonly`.
4. Create an OAuth client with application type **Chrome Extension**, using the extension ID shown in `chrome://extensions` as its Item ID. The checked-in public `key` keeps that ID stable across machines. It is not a secret or a signing key.
5. Set the returned OAuth client ID in the extension. If you have Node.js 20 or later installed, run from the repository root:

   ```sh
   npm run configure -- YOUR_CLIENT_ID.apps.googleusercontent.com
   ```

   Or edit `extension/manifest.json` in a text editor and add this top-level property (with a comma separating it from the preceding property):

   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/calendar.events.readonly"]
   }
   ```

6. Reload Meeting Reminders in `chrome://extensions`, reopen its popup, click **Connect Google Calendar**, and authorise the work account. Use the Chrome profile signed into your work Google account.
7. Confirm that **Coming up** shows the meetings you expect. An error or stale sync is shown in the popup and with a `!` badge. If the list is empty, check the account, calendar and dates.

No OAuth client secret or API key belongs in this extension. Connecting reads events; it cannot create, edit or delete meetings. Disconnecting removes the local Calendar cache and cached Google tokens, and leaves manually added meetings. You can also revoke the grant in your Google account's connected-app settings.

Google's references: [Chrome extension OAuth](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth), [Calendar events API](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

## How the reminders behave

- All timed, standard events in the primary calendar are eligible, even appointments without a Meet link. All-day events, declined invitations, cancelled events, focus time, out-of-office and working-location entries are excluded. Recurring events are expanded into individual occurrences by Google.
- The start times include Google's time zone offsets; display uses the computer's local time. Manual start times use the local time zone of the computer where they are entered.
- Opening Meet does **not** silence reminders. An English-language **Leave call / Leave meeting / Hang up** button must be visible and enabled in the matching Meet page. Camera and microphone access is never requested.
- Detection only covers matching `https://meet.google.com/abc-defg-hij` links in this profile. Phone calls, another browser/profile, Meet lookup aliases, and non-English Meet controls are not detected. If detection is uncertain or the page changes, reminders remain enabled. Actual production Meet detection still needs validation in your work environment.
- Joining suppresses the remaining stages for that occurrence, even if you subsequently leave the call. A reused Meet link will not silence next week's meeting. Overlapping calendar entries using the same Meet code can both be suppressed.
- **Dismiss meeting** skips the remaining stages for that occurrence. Closing the Windows notification alone only closes that alert. Opening a link does not click Join or access your microphone.
- After sleep or delayed alarms, only the most recent stage is shown, and only if it is at most two minutes late and the meeting is still running. Old stages are not replayed. Chrome alarms can be delayed; this is not an exact-time or wake-from-sleep alarm.
- A cancelled/rescheduled event is updated at the next successful sync (up to five minutes normally). When offline or access is denied, previously downloaded meetings continue to remind you and the popup displays the sync error; changes made elsewhere cannot be known until sync succeeds.
- Repeated ordinary alarm delivery is deduplicated using persisted stage records. A crash exactly between showing a notification and saving its record can replay that stage on restart, using the same notification ID.

## Privacy and permissions

No analytics, third-party reminder server, email access, chat access, microphone access or camera access. Meeting titles, times, links and reminder status are stored in `chrome.storage.local` in this browser profile. They are not sent to a reminder service or saved through Chrome sync. OAuth tokens are managed by Chrome Identity, not copied into extension storage or logs. Only Google receives authenticated Calendar requests.

| Permission | Purpose |
| --- | --- |
| `alarms` | Wake the extension worker for reminders and Calendar refreshes |
| `notifications` | Show desktop alerts |
| `storage` | Retain meetings and sent/dismissed state across worker restarts |
| `identity` | Google OAuth, after you explicitly connect |
| `www.googleapis.com` | Read the Google Calendar API |
| `meet.google.com` | Check the matching Meet page for an active-call control |

Content scripts cannot read the stored Calendar cache or invoke the extension's settings actions. This first version only uses the Google Calendar API and Meet DOM; it does not read Gmail or Chat.

## Development and verification

No build step or npm dependencies. Load `extension/` directly. Node.js 20+ is needed only for the developer scripts and automated tests.

```sh
npm test
npm run check
```

To produce an install ZIP containing the extension and this guide, run `python3 scripts/package.py` (or `python scripts/package.py` on Windows). The output is `dist/meeting-reminders.zip`. Repackage after configuring OAuth if you are transferring the configured build to another machine.

Automated tests cover scheduling, time offsets, recurrence identity, sleep catch-up, API pagination, expired-token retry, notification deduplication, disconnect, Meet suppression and message boundaries. The worker tests mock Chrome APIs; they do not certify real Windows notification delivery or live Google authentication.

Before relying on it at work, check:

1. The one-minute test is noticeable with Chrome in the background.
2. A manual meeting at least 16 minutes ahead produces the three reminders.
3. Opening a matching Meet waiting room leaves reminders enabled; joining the call changes the popup to **Joined** and suppresses the remaining stages.
4. An unrelated Meet call does not suppress that meeting.
5. Calendar connection shows the expected work meetings; refreshing reflects a changed/cancelled event.
6. Restarting Chrome preserves a future manual meeting and its alarm.

For a Chrome Web Store release, follow Google's OAuth guide for the store item's public key and matching OAuth Item ID. Store publication and your organisation's approval are separate steps; neither has been performed here.
