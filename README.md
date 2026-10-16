# AI Chat Cleaner

Chrome extension (Manifest V3) that deletes chats on **ChatGPT**, **Gemini** and **Claude** — one at a time or in bulk — while keeping pinned chats safe.

## Features

- **Bulk delete** newest 10, 50, 100, or all chats.
- **Single delete** from the popup's chat list (two clicks: arm, then confirm).
- **Keep pinned chats** toggle (on by default, remembered). On Claude this means *starred* chats. Chats whose pin state can't be read are kept, not deleted.
- **Speed selector** (ChatGPT): Paced (~5 s/chat, default), Fast (bursts of ~1 s/chat), Gentle (~13 s/chat).
- **Throttle handling**: ChatGPT rate-limits delete bursts with a "Failed to delete chat" toast. The run pauses automatically on sight of it and resumes on its own.
- **Progress card** on the page with live tally and a Stop button — the popup can be closed mid-run.
- Loaded version shown in the popup header, so you can confirm a reload picked up new code.

## Install

1. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
3. Open ChatGPT, Gemini or Claude, then click the extension icon.

Tabs that were already open before install: reload the tab first (the popup injects its script on first use).

## Use

1. Click the extension icon on a supported site.
2. In **Bulk delete**, pick 10 / 50 / 100 / All and press **Delete…**.
3. Confirm. Runs that delete **all** chats, or run with keep-pinned **off**, additionally require typing `DELETE`.
4. Watch the on-page progress card; **Stop** ends the run at any point. Deleting is permanent.

If the sidebar shows no chats, the run won't start — you'll get "Nothing to delete" instead of an empty `0/10`.

## Speeds (ChatGPT only)

| Speed | Pace | Best for |
| --- | --- | --- |
| Paced (default) | ~5 s/chat, steady | Large cleanups; avoids the throttle entirely in practice |
| Fast | ~1 s/chat bursts | Small cleanups (≤20); trips the throttle sooner, then auto-pauses with doubling cooldowns |
| Gentle | ~13 s/chat, waits for each dialog to settle | Slowest, safest |

Gemini and Claude always use the wait-and-settle path regardless of this setting.

When throttled, the run pauses ~6 minutes and resumes by itself. Paced/Gentle keep a flat 6-minute cooldown; Fast doubles it (6 → 12 → 15 cap) because re-bursting into a hot limit buys nothing but dead time.

## How it works

No site documents a delete API, and the extension uses none. It drives each site's own sidebar: open the chat's `…` menu, click **Delete**, click the confirm button. It never reads an auth token and makes no network requests of its own.

Pin state is read per chat from its own menu at delete time: a pinned chat offers **Unpin** (ChatGPT, Gemini) or **Unstar** (Claude). Labels are matched in **English only** — anything unreadable counts as "unknown" and the chat is kept while the toggle is on.

All per-site markup lives in `src/selectors.js`. If a site redesigns its sidebar, that file is the only place that needs fixing (ChatGPT shipped a new sidebar shape mid-development and only that file changed).

## Permissions

| Permission | Why |
| --- | --- |
| `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://gemini.google.com/*`, `https://claude.ai/*` | Run the delete steps in the sidebar of these sites only |
| `storage` | Remember the keep-pinned toggle and speed choice |
| `scripting` | Inject the script into a tab that was open before install |

## Development

No build step. After any code change:

```
node --check popup/popup.js && node --check src/content.js && node --check src/selectors.js
```

Bump `version` in `manifest.json` on every code change.
