# AI Chat Cleaner

Chrome extension (Manifest V3) that deletes chats on **ChatGPT**, **Gemini** and **Claude**.

## Features

- **Delete one chat**: the popup lists the chats loaded in the sidebar; click Delete, then click again to confirm.
- **Bulk delete**: newest 100, oldest 100, or all chats. "All" and any run with the pinned toggle off require typing `DELETE`.
- **Keep pinned chats** toggle (on by default, remembered). On Claude this means *starred* chats, because Claude has no "pinned".
- Progress card on the page with a **Stop** button, so a run can be watched or stopped with the popup closed.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
3. Open ChatGPT, Gemini or Claude, then click the extension icon.

Tabs that were already open when you installed it are handled: the popup injects the script on first use.

## How it works

No site documents a delete API. The extension drives each site's own sidebar: open the chat's `...` menu, click **Delete**, click the confirm button. It never reads an auth token and makes no network requests of its own. Deleting is permanent on all three sites.

## Pinned detection

Each chat's pin state is read at the moment of deletion, from its own menu: a pinned chat offers **Unpin** (ChatGPT, Gemini) or **Unstar** (Claude); an unpinned one offers **Pin** / **Star**.

- This uses **English labels only**. If the label cannot be read (for example the site is set to another language), the chat is **kept**, not deleted, and the progress panel says how many were kept for that reason.
- Chats kept as pinned do not count toward the 100.
- The toggle also applies to single-chat delete. Turn it off to delete a pinned chat.

## Known limits

- **Not tested against the live sites.** The selectors in `src/selectors.js` were cross-checked against an open-source extension that targets the same three sites (hirakujira/AI-Chat-Bulk-Deleter), and the logic is tested against simulated sidebars (`npm test`). If a site redesigns its sidebar, a site's entry in `src/selectors.js` is the only place that needs fixing. Try single-chat delete on each site first, then a bulk run.
- Only chats the site has loaded into the sidebar can be deleted. For bulk runs the extension scrolls the sidebar to load more and waits while a loading spinner is showing. The spinner selector is a best guess.
- Sites rate-limit. The extension pauses about 0.7 to 1.1 seconds between deletions and stops after 3 failures in a row, reporting the last reason.
- When a delete fails, the message names the step and what the page showed, for example `confirm: no usable Delete button. Saw: <mat-dialog-container> buttons [Cancel | OK]`. Send that text when reporting a problem; it says which selector to fix.
- On ChatGPT the site's delete dialog can stay open with a spinning button after the chat is gone. The extension waits for it to close, tries Cancel and Escape, and if it is still open it stops and says so (reload the page, then continue). The cause on the site's side is not known.
- Work and school accounts may block deleting (Gemini states this for Workspace accounts).

## Development

```
npm install
npm test        # 81 tests: selectors and the delete engine against simulated sidebars
```

`test/`, `package.json` and `node_modules/` are dev-only and are not part of the packaged extension.

## Permissions

| Permission | Why |
| --- | --- |
| `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://gemini.google.com/*`, `https://claude.ai/*` | Run the delete steps in the sidebar of these sites only. |
| `storage` | Remember the keep-pinned toggle. |
| `scripting` | Inject the script into the page when the popup first needs it. |
