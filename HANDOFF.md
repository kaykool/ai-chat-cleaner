# Handoff: AI Chat Cleaner

Project folder: `/home/claude/ai-chat-cleaner` (zip: `/home/claude/ai-chat-cleaner.zip`).
If the new session cannot see that folder, attach the zip and unzip it.

## Goal
Chrome MV3 extension that deletes chats on ChatGPT, Gemini and Claude:
1. delete an individual chat
2. bulk delete newest 100, oldest 100, or all
3. toggle to keep pinned chats (on Claude = starred)

## Current status
- Built and packaged. 81 tests pass (`npm install && npm test`) against **simulated** sidebars only.
- **Never run on a live site.** Selectors come from the open-source repo hirakujira/AI-Chat-Bulk-Deleter (`src/selectors.js`, read 2026-10-15).
- No delete API is used. The engine opens each row's menu, clicks Delete, clicks the confirm button (`src/content.js`).

## Open problem (user report, Gemini)
A "Delete chat?" dialog (buttons Cancel / Delete) appears when the extension deletes a chat, then the run errors and stops. Exact error text not yet seen.
Fix shipped in the latest build, based on guesses (not captured from the live site):
- take the first new dialog that holds a usable Delete button (an extra empty dialog-like element could be picked before)
- ignore custom wrapper elements like `<gem-button>`, click the real inner button
- success = chat leaves the sidebar, even if the dialog element stays in the page
- failure messages now say what the page showed, for example `confirm: no usable Delete button. Saw: <mat-dialog-container> buttons [Cancel | OK]`

## What is needed next
Real HTML from Gemini, either:
- via Browser Use in a NEW session (the plugin is enabled on the account but was not loaded into the old session), or
- the user pastes the output of this, run in DevTools Console with the dialog open:
  `copy([...document.querySelectorAll('[role="dialog"],[role="alertdialog"],mat-dialog-container,.mat-mdc-dialog-surface')].map(d => d.outerHTML).join('\n\n----\n\n'))`
  and, for the menu: `copy(document.querySelector('[role="menu"]').outerHTML)`
- plus the red error line from the on-page progress card after a failed run.

Then fix `src/selectors.js` (Gemini entry) and/or `pickConfirm` in `src/content.js`, and add a test that reproduces the real dialog shape in `test/fakesite.js`.
Do the same check for ChatGPT and Claude: single delete first, then bulk.

## Facts established (sources read this session)
- Gemini help page says deleting a chat also removes its Gemini Apps Activity; Workspace accounts cannot delete.
- Pagination: Gemini loads older chats behind a spinner (user screenshot). Loader waits while a spinner is visible; the spinner selector is a guess (`[role="progressbar"], mat-spinner, mat-progress-spinner, [class*="spinner" i]`).
- Pin detection reads the row menu's English labels (Pin/Unpin, Star/Unstar). Unreadable labels = chat is kept while the toggle is on.

## User preferences to keep
Verify before asserting and mark unverified claims; lead with the answer; at most three sentences unless analysis is asked; code multi-item lists as F1, O1, Q1 and never reuse a code; no recap at the end; take no irreversible step unrequested.

## Open question
Q1: "last 100" is implemented as a choice of newest 100 or oldest 100, newest default. User has not confirmed which they meant.

## Update: ChatGPT dialog (real HTML seen 2026-10-16)
- ChatGPT's dialog: `<div role="dialog" aria-modal="true" data-state="open">` containing a `<form>` with Cancel (`type=button`) and a submit button "Delete chat", plus an X button (sr-only text "Close dialog").
- User report: the chat is deleted ("Done. 1/1 deleted") but the dialog stays open with the confirm button spinning and disabled, and later deletes stack a new dialog on top.
- Cause of the stuck dialog is unknown. The extension now: waits for the dialog to close before the next delete, escalates (Cancel/Close, then Escape), and if it is still open stops the run with "The chat was deleted, but the site's dialog stayed open. Reload the page to continue."
- Still unknown: does the dialog ever close by itself, and does Escape or the X close it by hand? Ask the user.
