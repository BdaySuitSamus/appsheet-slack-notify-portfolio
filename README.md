# AppSheet Package Tracker → Slack DM Notifications

Extends an existing no-code package-tracker app (built in
[AppSheet](https://about.appsheet.com/)) so that when a package is logged
for someone, they also get a Slack DM — in addition to, not instead of, the
email notification the app already sends. The app itself is documented
separately; this project covers just the Slack integration layered on top
of it.

## The problem

The tracker app's existing automation bot notifies recipients by email only.
Email isn't always the channel people actually check quickly, and the
office serves multiple brands, each with its own separate Slack workspace —
so "just add a Slack message" also means routing each notification to the
*correct* workspace.

## Design

- **Trigger:** a new "call a webhook" step appended to the existing,
  already-working AppSheet bot — no new trigger, no schedule, just one more
  step on an already event-driven process (fires on new-row-added only).
- **Receiver:** a small Google Apps Script Web App. No dedicated server or
  hosting account required — it runs under the deploying user's own Google
  identity and responds to a plain HTTP POST from AppSheet's webhook task.
- **Multi-workspace routing:** the receiver looks up the recipient's email
  domain against a fixed map to pick which Slack workspace's bot token to
  use. This was **not** the original plan — the source data has its own
  free-text "Brand" field that looked like the obvious routing key, until a
  live check of the real spreadsheet showed it was blank on ~40% of rows,
  with inconsistent casing and spelling on the rest ("Brand A", "brand a",
  "BrandA Co", a stray person's name, etc.). The recipient's *resolved*
  email domain — backed by the same lookup table the existing email step
  already depends on — proved far more consistent, so routing keys off that
  instead.
- **Fails open, by design:** the webhook step always reports success back
  to the bot, whether the DM actually sent, was skipped (unrecognized
  domain, no matching Slack account), or hit an error. It runs *after* the
  email step has already fired, so it must never be able to block or fail
  the one notification that already works.

## Real findings from building and testing this live

None of this showed up in isolated unit-style testing — it only surfaced by
testing against the real running app, which is the point of writing it
down.

**Web App access looked like an org policy problem, but wasn't.** The first
live test hit a Google Drive-style "You need access" wall on every request,
including fully anonymous calls — indistinguishable from a Workspace admin
policy blocking public web app access. It wasn't. The actual cause: any
Apps Script project that calls an external service (here, `UrlFetchApp` →
Slack) needs a one-time OAuth consent grant from the deploying user before
it can execute *at all*, for *any* caller — normally granted automatically
the first time you click "Run" in the Apps Script editor, but never
triggered here since the project was created and deployed entirely
headlessly via [`clasp`](https://github.com/google/clasp). Fixed by
manually visiting the deployed URL once and clicking through the
"Review Permissions" screen.

**A `curl -X POST` habit broke the redirect-following.** Apps Script Web
Apps always respond to a request with an HTTP 302 redirect to a
content-serving URL before returning the actual output — inherent platform
behavior, not a bug. Testing with `curl -X POST` explicitly forces curl to
replay POST on the redirect too, but that content-serving endpoint only
accepts GET. Dropping `-X POST` (and just using `-d`, which implies POST on
the *initial* request only) let curl's normal redirect-following logic
correctly downgrade to GET on the follow-up.

**AppSheet retried on that same redirect, causing duplicate messages.** The
first real end-to-end test produced **four duplicate Slack DMs** from a
single package. Root cause: the webhook step's "max retries on failure" was
left at its default of 3. AppSheet evidently treats that inherent 302
redirect as a failure and retries — one initial call plus three retries,
four independent executions, each sending its own DM, since nothing in the
script deduplicates. Fixed by setting retries to 0 on the step (the script
already fails open, so retry-on-failure was never doing useful work here
anyway).

**A photo-attachment feature was built, broke in a subtle way, got
reverted, and was later fixed properly by routing around the actual root
cause.** A first iteration tried attaching the package's photo (already
captured by the source app) to the Slack DM via Slack's external file
upload flow, by looking the photo up directly in the source app's Drive
folder (`DriveApp.getFolderById(...).getFilesByName(...)`). It worked
cleanly in isolated testing against an already-synced photo. Every real
end-to-end test — an actual photo taken through the live app — came back
text-only. Chasing this down took three rounds:
1. First real test produced zero Slack messages at all — unrelated to
   photos, a stale test Slack account had been deactivated earlier in
   testing.
2. Second real test: text arrived, no photo. Comparing the source row's own
   timestamp against the photo file's actual Drive `createdTime` showed a
   real gap (~9s in one measurement, ~35s in another) — the photo hadn't
   finished syncing to Drive yet when the webhook fired immediately on the
   row-added event. Added a retry loop with waits, extended twice (~9s,
   then ~27s, then ~60s total).
3. Third real test, decisive: still text-only, despite the ~60s retry
   budget. Apps Script's **Executions** list (distinct from the "Execution
   log" popup, which only shows manual editor runs — Executions captures
   every invocation, including real webhook calls) showed the run took the
   full 65 seconds, exhausting every retry attempt — yet the photo file's
   own Drive `createdTime` was *three seconds before that execution even
   started*. The file already existed in Drive before the search ever ran,
   and the lookup still couldn't find it for over a minute. That pointed to
   Drive's file-*search index* lagging behind actual file creation — a
   different and less tractable problem than upload latency, since no
   amount of retrying a search query fixes a stale index.

   Rather than build a more complex mechanism on the same broken
   foundation (e.g., a delayed second Slack message via a scheduled
   trigger), the photo feature was dropped and the notification shipped
   text-only for a while. The retry-loop code, the `drive.readonly` OAuth
   scope, and the async-execution setting added for it were all reverted
   along with it.

**Revisited later, root-caused properly, and fixed for real.** The actual
bug was never upload latency — it was that `getFilesByName()` (even
folder-scoped) queries Drive's *search index*, which is eventually
consistent independent of the file's own metadata, rather than Drive's
metadata store, which is strongly consistent. No retry budget fixes a
stale index. The fix was to stop asking Apps Script to find the file in
Drive at all: the source app (AppSheet) has its own file-serving URL
mechanism, generated from the app's own definitive knowledge of the
upload rather than a third-party search index. A new formula column in
the source app builds that URL directly from the photo column's value,
and the URL is passed straight through the webhook body instead of a bare
filename. Apps Script's side collapsed from a Drive-search-with-retries
loop down to one plain `UrlFetchApp.fetch(url)` call — simpler code that
also happens to be correct, since it no longer depends on any search
index at all. (This did require relaxing one app-wide setting — the
source platform can require its file-serving URLs to be
cryptographically signed, which blocks arbitrary formula-built links; that
was disabled deliberately, after confirming the underlying files aren't
actually sensitive in this context.) Verified against the exact original
failure mode — a freshly captured photo, through the live app, followed
through to a real Slack DM — not just the already-synced case that misled
the first round of testing.

## Stack

- **Source:** an AppSheet app, backed by a Google Sheet.
- **Receiver:** Google Apps Script (Web App), deployed via
  [`clasp`](https://github.com/google/clasp).
- **Destination:** Slack, via `users.lookupByEmail` + `chat.postMessage`
  (one bot token per workspace).

## Config

Real secrets never live in this repo. See `config.example.json` for the
three values the deployed Apps Script project's Script Properties need:
a shared webhook secret (checked against every incoming request) and one
Slack bot token per workspace.
