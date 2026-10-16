// Content script. Deletes chats by driving the site's own sidebar controls
// (open the row's menu, click Delete, confirm). It uses no private API and
// never reads an auth token.
(() => {
  "use strict";
  if (globalThis.__AICC_LOADED__) return;
  globalThis.__AICC_LOADED__ = true;

  const S = globalThis.AICC_SELECTORS;
  const platformKey = S.detectPlatform(location.hostname);
  const cfg = platformKey ? S.PLATFORMS[platformKey] : null;

  const CONFIG = {
    delayMs: 700, // pause between deletions, to stay under rate limits
    jitterMs: 400,
    paceMs: 3500, // paced ChatGPT runs: space deletes out instead of bursting
    stepTimeoutMs: 3000,
    loadWaitMs: 2500, // how long to wait for the next page before checking for a spinner
    spinnerWaitMs: 10000, // extra wait while a spinner is visible
    dialogSettleMs: 150,
    dialogCloseWaitMs: 30000, // after the chat is gone, how long to let the site close its own dialog; ChatGPT settles in ~15-30s
    dialogSettledGraceMs: 3000, // after the request settles, how long to let the site close the dialog before dismissing it
    retryClickMs: 2500, // wait after a click before re-finding the button and trying another click style
    confirmTimeoutMs: 8000,
    maxConsecutiveFailures: 3,
    maxLoadRounds: 300,
    // ChatGPT throttles delete bursts server-side (measured: HTTP 500s and a
    // "Failed to delete chat" toast after ~15-19 rapid deletes). On that
    // toast the bulk run pauses by itself, then resumes.
    throttlePollMs: 1000,
    throttlePauseBaseMs: 360000, // measured: a 15-delete burst resumed into an instant re-toast after 3 min; 6 min ran clean
    throttlePauseMaxMs: 900000,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = CONFIG.stepTimeoutMs, every = 50) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(every);
    }
  }

  // ---------- state ----------

  const state = {
    busy: false,
    stop: false,
    phase: "idle", // idle | loading | deleting | paused | done | stopped | error
    mode: null,
    limit: null,
    deleted: 0,
    skippedPinned: 0,
    skippedUnknown: 0,
    failed: 0,
    lastError: "",
    throttlePauses: 0,
    pauseLeftMs: 0,
  };

  function resetState(mode, limit) {
    Object.assign(state, {
      busy: true,
      stop: false,
      phase: "loading",
      mode,
      limit,
      deleted: 0,
      skippedPinned: 0,
      skippedUnknown: 0,
      failed: 0,
      lastError: "",
      throttlePauses: 0,
      pauseLeftMs: 0,
    });
  }

  // ---------- ChatGPT throttling ----------
  // A content script cannot read XHR results, so when ChatGPT's own delete
  // calls start failing the only signal is the "Failed to delete chat" toast
  // the page shows. On sight of it a bulk run pauses, then resumes on its own;
  // each further toast in the same run doubles the pause.

  const THROTTLE_TOAST_RE = /Failed to delete chat/i;
  let throttleSeenAt = 0;
  let throttlePauseMs = 0;
  let throttleWatchTimer = null;
  let throttleStaleToast = false;
  let runSpeed = "fast"; // per run: "fast" bursts, "paced" ~5s spacing, "gentle" wait-and-settle

  const throttleToastVisible = () => THROTTLE_TOAST_RE.test(document.body.innerText || "");

  function startThrottleWatch() {
    if (platformKey !== "chatgpt" || throttleWatchTimer) return;
    throttleStaleToast = throttleToastVisible(); // a toast left over from before this run does not count
    throttleWatchTimer = setInterval(() => {
      const visible = throttleToastVisible();
      if (throttleStaleToast) {
        if (!visible) throttleStaleToast = false;
        return;
      }
      if (visible) throttleSeenAt = Date.now();
    }, CONFIG.throttlePollMs);
  }

  function stopThrottleWatch() {
    if (throttleWatchTimer) clearInterval(throttleWatchTimer);
    throttleWatchTimer = null;
  }

  async function throttleCooldown() {
    throttleSeenAt = 0; // one pause per toast; a new toast pauses again
    // Bursts escalate the cooldown when they trip again; paced/gentle runs
    // keep a flat cooldown (their rate is already low, and a leap from 6 to
    // 12 minutes buys nothing but dead time).
    throttlePauseMs =
      runSpeed === "fast" && throttlePauseMs
        ? Math.min(throttlePauseMs * 2, CONFIG.throttlePauseMaxMs)
        : CONFIG.throttlePauseBaseMs;
    state.throttlePauses++;
    state.phase = "paused";
    const end = Date.now() + throttlePauseMs;
    while (!state.stop && Date.now() < end) {
      state.pauseLeftMs = end - Date.now();
      render();
      await sleep(500);
    }
    state.pauseLeftMs = 0;
    state.phase = "deleting";
    render();
  }

  // ---------- DOM helpers ----------

  function labelOf(el) {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll('mat-icon, svg, [aria-hidden="true"], .material-icons, .material-symbols-outlined')
      .forEach((n) => n.remove());
    const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    return text || (el.getAttribute("aria-label") || "").trim();
  }

  function mouseInit(type) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: /down$/.test(type) ? 1 : 0,
      detail: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
  }

  function fire(el, type) {
    const Ctor = type.startsWith("pointer") ? globalThis.PointerEvent || MouseEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, mouseInit(type)));
  }

  function hover(el) {
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) fire(el, t);
  }

  function fullClick(el) {
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) fire(el, t);
  }

  function openMenu(trigger) {
    if (cfg.triggerActivation === "pointerdown") {
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) fire(trigger, t);
    } else {
      trigger.click();
    }
  }

  function pressEscape() {
    for (const target of [document.activeElement, document]) {
      (target || document).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true })
      );
    }
  }

  async function closeMenu(menu) {
    for (let i = 0; i < 3; i++) {
      pressEscape();
      if (await waitFor(() => !menu.isConnected, 800)) return;
    }
  }

  function scrollParent(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }

  // ---------- sidebar model ----------

  function scan() {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll(cfg.selectors.conversationLink)) {
      const id = S.parseConversationId(a.getAttribute("href"), platformKey);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: (a.textContent || "").replace(/\s+/g, " ").trim() || id });
    }
    return out;
  }

  function findLink(id) {
    for (const a of document.querySelectorAll(cfg.selectors.conversationLink)) {
      if (S.parseConversationId(a.getAttribute("href"), platformKey) === id) return a;
    }
    return null;
  }

  // The row is the nearest ancestor that holds this chat's link and exactly
  // one conversation link, plus an options button.
  function findRow(link) {
    let el = link.parentElement;
    for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
      if (
        el.querySelector(cfg.selectors.optionsTrigger) &&
        el.querySelectorAll(cfg.selectors.conversationLink).length === 1
      ) {
        return el;
      }
    }
    return null;
  }

  // A spinner under the list means the site is still fetching the next page.
  // Selector list is a best guess; the Gemini sidebar shows such a spinner.
  const SPINNER = '[role="progressbar"], mat-spinner, mat-progress-spinner, [class*="spinner" i]';

  // Cheap chat count for pagination polling: no id parsing, no titles.
  const countLinks = () => document.querySelectorAll(cfg.selectors.conversationLink).length;

  async function loadMore() {
    const before = countLinks();
    const links = document.querySelectorAll(cfg.selectors.conversationLink);
    const last = links[links.length - 1];
    if (!last) return false;
    last.scrollIntoView?.({ block: "end" });
    const sc = scrollParent(last);
    const scrollToEnd = () => {
      if (sc) sc.scrollTop = sc.scrollHeight;
    };
    const grew = () => countLinks() > before;
    scrollToEnd();
    if (await waitFor(grew, CONFIG.loadWaitMs)) return true;

    // Not grown yet. While a spinner is showing, keep waiting and re-scrolling.
    const area = sc || document;
    const end = Date.now() + CONFIG.spinnerWaitMs;
    while (Date.now() < end && area.querySelector(SPINNER)) {
      scrollToEnd();
      if (await waitFor(grew, 1000)) return true;
    }
    return false;
  }

  async function loadAll() {
    for (let i = 0; i < CONFIG.maxLoadRounds && !state.stop; i++) {
      if (!(await loadMore())) {
        // one retry: lazy lists sometimes need a second scroll
        if (!(await loadMore())) return;
      }
      render();
    }
  }

  // ---------- deleting one chat ----------

  const fail = (reason) => ({ status: "failed", reason });

  function pickDelete(menu, items) {
    const bySelector = cfg.selectors.deleteMenuItem && menu.querySelector(cfg.selectors.deleteMenuItem);
    if (bySelector && !/archive|share|rename|pin|star/i.test(labelOf(bySelector))) return bySelector;
    return items.find((n) => S.DELETE_RE.test(labelOf(n)) && !/cancel|undo/i.test(labelOf(n))) || null;
  }

  // Clickable things inside a dialog. Keeps the innermost match, so a custom
  // wrapper such as <gem-button> never hides the real <button> inside it.
  function clickables(root) {
    const nodes = [...root.querySelectorAll('button, [role="button"], gem-button')];
    return nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
  }

  // strict: only accept a button whose text says Delete or that matches the
  // platform's confirm selector. Non-strict also accepts the dialog's last
  // button (Claude: Cancel first, Delete last).
  function pickConfirm(dialog, strict) {
    const items = clickables(dialog);
    const byText = items.find((b) => S.DELETE_RE.test(labelOf(b)) && !/cancel/i.test(labelOf(b)));
    if (byText) return byText;
    const bySelector = cfg.selectors.confirmDeleteButton && dialog.querySelector(cfg.selectors.confirmDeleteButton);
    if (bySelector) return bySelector;
    if (strict) return null;
    return items.length > 1 ? items[items.length - 1] : null;
  }

  function pressEnterOn(el) {
    el.focus?.();
    for (const type of ["keydown", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    }
  }

  // Close dialogs we opened but could not confirm. Cancel is tried before
  // Escape because a focus-trapped dialog may ignore a synthetic Escape.
  // A dialog counts as open while it is attached and not hidden.
  function isOpen(d) {
    if (!d.isConnected) return false;
    const cs = getComputedStyle(d);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  async function dismissDialogs(dialogs) {
    for (const d of dialogs) {
      if (!isOpen(d)) continue;
      const cancel = clickables(d).find((b) => /cancel|close|dismiss/i.test(labelOf(b)) && !b.disabled);
      if (cancel) fullClick(cancel);
    }
    if (await waitFor(() => !dialogs.some(isOpen), 1000)) return;
    pressEscape();
    await waitFor(() => !dialogs.some(isOpen), 1000);
  }

  // On ChatGPT the fast/paced path reports the delete as soon as the row is
  // gone and never waits for the site's own ~11s dialog-close timer, so
  // close those dialogs here instead of letting them stack up.
  function sweepDeleteDialogs() {
    if (platformKey !== "chatgpt") return;
    // While the site is throttling, leave dialogs alone: it may still be
    // retrying those requests, and the pause/resume cycle deals with them.
    if (throttleToastVisible()) return;
    for (const d of document.querySelectorAll(cfg.selectors.confirmDialog)) {
      if (!isOpen(d)) continue;
      if (!/permanently delete/i.test(d.textContent || "")) continue; // delete confirms only
      // Cancel and "Delete chat" stay disabled for the dialog's whole life
      // after the click (measured); only the close button needs to be usable.
      const close = clickables(d).find(
        (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true" && /close dialog/i.test(labelOf(b))
      );
      if (close) fullClick(close);
    }
  }

  const GENERIC_DIALOG =
    '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], mat-dialog-container';

  function ownDialog(d) {
    return !!cfg.selectors.confirmDialog && d.matches(cfg.selectors.confirmDialog);
  }

  function describeDialogs(dialogs) {
    if (!dialogs.length) return "no new dialog element appeared";
    const text = dialogs
      .map((d) => `<${d.localName}> buttons [${clickables(d).map((b) => labelOf(b) || "?").join(" | ")}]`)
      .join("; ");
    return text.length > 220 ? text.slice(0, 220) + "…" : text;
  }

  async function deleteChat(id, keepPinned) {
    try {
      const link = findLink(id);
      if (!link) return fail("not loaded in the sidebar");
      link.scrollIntoView?.({ block: "center" });
      const row = findRow(link);
      if (!row) return fail("options button not found");
      hover(row);
      const trigger = row.querySelector(cfg.selectors.optionsTrigger);

      const menusBefore = new Set(document.querySelectorAll(cfg.selectors.menu));
      openMenu(trigger);
      const menu = await waitFor(() =>
        [...document.querySelectorAll(cfg.selectors.menu)].filter((m) => !menusBefore.has(m)).pop()
      );
      if (!menu) return fail("menu did not open");

      const nodes = [
        ...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button, a'),
      ];
      const items = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
      const pin = S.classifyMenu(items.map(labelOf));

      if (keepPinned && pin !== "unpinned") {
        await closeMenu(menu);
        return pin === "pinned"
          ? { status: "skipped-pinned" }
          : { status: "skipped-unknown", reason: "could not tell if it is pinned" };
      }

      const del = pickDelete(menu, items);
      if (!del) {
        await closeMenu(menu);
        return fail("Delete item not found in the menu");
      }

      // Watch every common way a site marks a modal, not only this site's own
      // selector, so a changed dialog markup does not hide the dialog.
      const dialogSelector = [cfg.selectors.confirmDialog, GENERIC_DIALOG].filter(Boolean).join(", ");
      const dialogsBefore = new Set(document.querySelectorAll(dialogSelector));
      const freshDialogs = () =>
        [...document.querySelectorAll(dialogSelector)].filter((d) => !dialogsBefore.has(d));
      fullClick(del);

      // Several elements can match the dialog selector (wrapper, surface, an
      // unrelated overlay). Take the first new one that holds a usable Delete button.
      const locateConfirm = () => {
        const fresh = freshDialogs();
        for (const strict of [true, false]) {
          for (const d of fresh) {
            // The "last button" guess is only trusted for the site's own dialog selector.
            const b = pickConfirm(d, strict || !ownDialog(d));
            if (b) return { dialog: d, button: b };
          }
        }
        return null;
      };
      const found = await waitFor(locateConfirm);

      let gone = false;
      let attempts = 0;
      if (found) {
        await sleep(CONFIG.dialogSettleMs); // let the open animation finish before clicking
        // Click, and if the dialog is still open afterwards, look the button up
        // again (the page may have replaced it) and try a different click style.
        for (; attempts < 3 && !gone; attempts++) {
          const live = attempts === 0 ? found : locateConfirm();
          if (!live) break; // dialog closed: the delete is in flight, just wait for it
          if (attempts === 0) fullClick(live.button);
          else if (attempts === 1) live.button.click();
          else pressEnterOn(live.button);
          gone = await waitFor(() => !findLink(id), attempts === 2 ? CONFIG.confirmTimeoutMs : CONFIG.retryClickMs, 100);
        }
        if (!gone && !locateConfirm()) {
          gone = await waitFor(() => !findLink(id), CONFIG.confirmTimeoutMs, 100);
        }
      } else {
        gone = await waitFor(() => !findLink(id), 2000, 100);
      }

      // Success means the chat left the sidebar. Whether the dialog element
      // lingers in the page does not matter.
      if (gone) {
        // The chat left the sidebar, so the delete is done. On ChatGPT the
        // site then keeps its dialog in a timed closing state (measured: the
        // row is gone at ~0.6s; the dialog clears itself ~11s later no
        // matter what) even though the request has settled and nothing is
        // left to do. Waiting that timer out costs ~11s per chat and buys
        // nothing, so report the delete right away and let the dialog finish
        // on its own; the dialog snapshot above is per delete, so a
        // lingering previous dialog stays out of the next one's way.
        // Gemini and Claude keep the wait-and-escalate path below, which is
        // the behavior they are verified against.
        if (platformKey === "chatgpt" && runSpeed !== "gentle") {
          pressEscape(); // take it down early where a site honors that
          setTimeout(sweepDeleteDialogs, 600); // close the dialog we leave behind
          setTimeout(sweepDeleteDialogs, 2500); // second pass for slow settles
          if (runSpeed === "paced") await sleep(CONFIG.paceMs); // steady cadence instead of a burst
          return { status: "deleted" };
        }
        const openNow = () => freshDialogs().filter(isOpen);
        const inFlight = () =>
          openNow().some((d) => {
            const b = pickConfirm(d, true);
            return !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");
          });
        let sawInFlight = false;
        const waited = await waitFor(
          () => {
            if (!openNow().length) return true;
            if (inFlight()) {
              sawInFlight = true;
              return false;
            }
            return sawInFlight; // request settled: the site should close the dialog now
          },
          CONFIG.dialogCloseWaitMs,
          250
        );
        if (waited && !openNow().length) return { status: "deleted" };
        if (sawInFlight && (await waitFor(() => !openNow().length, CONFIG.dialogSettledGraceMs, 100))) {
          return { status: "deleted" };
        }
        await dismissDialogs(openNow());
        const stillOpen = openNow();
        if (!stillOpen.length) return { status: "deleted" };
        return {
          status: "deleted",
          stuck: true,
          reason: `The chat was deleted, but the site's dialog stayed open. Reload the page to continue. Dialog: ${describeDialogs(stillOpen)}`,
        };
      }

      const leftover = freshDialogs();
      await dismissDialogs(leftover);
      return fail(
        found
          ? `confirm: clicked "${labelOf(found.button) || "?"}" ${attempts}x but the chat is still listed. Dialog: ${describeDialogs(leftover)}`
          : `confirm: no usable Delete button. Saw: ${describeDialogs(leftover)}`
      );
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  }

  // ---------- jobs ----------

  function tally(res) {
    if (res.status === "deleted") state.deleted++;
    else if (res.status === "skipped-pinned") state.skippedPinned++;
    else if (res.status === "skipped-unknown") state.skippedUnknown++;
    else {
      state.failed++;
      state.lastError = res.reason || "";
    }
    render();
  }

  async function pause() {
    await sleep(CONFIG.delayMs + Math.floor(Math.random() * CONFIG.jitterMs));
  }

  async function runJob({ mode, limit, keepPinned }) {
    resetState(mode, limit);
    throttleSeenAt = 0;
    throttlePauseMs = 0;
    startThrottleWatch();
    render();
    const attempted = new Set();
    let consecutiveFails = 0;
    const done = () => state.stop || (limit != null && state.deleted >= limit);

    try {
      let queue = null;
      if (mode === "oldest") {
        await loadAll();
        queue = scan().map((c) => c.id).reverse();
      }
      state.phase = "deleting";
      render();

      let exhausted = false;
      while (!done()) {
        let id;
        if (queue) {
          id = queue.shift();
          if (!id) break;
        } else {
          const pending = scan().filter((c) => !attempted.has(c.id));
          // Fetch the next page while a few chats are still visible, so the
          // list never runs dry before the site loads more.
          if (!exhausted && pending.length < 3) {
            const grew = (await loadMore()) || (await loadMore());
            if (!grew) exhausted = true;
            continue;
          }
          if (!pending.length) break;
          id = pending[0].id;
        }
        attempted.add(id);

        const res = await deleteChat(id, keepPinned);
        tally(res);
        if (res.stuck) {
          // A dialog that will not close blocks every later delete.
          state.phase = "error";
          state.lastError = res.reason;
          return;
        }
        if (res.status === "failed") {
          if (++consecutiveFails >= CONFIG.maxConsecutiveFailures) {
            state.phase = "error";
            state.lastError = `Stopped after ${consecutiveFails} failures in a row. Last: ${res.reason}`;
            return;
          }
        } else {
          consecutiveFails = 0;
        }
        if (platformKey === "chatgpt" && throttleSeenAt && !state.stop) await throttleCooldown();
        await pause();
      }
      state.phase = state.stop ? "stopped" : "done";
    } catch (e) {
      state.phase = "error";
      state.lastError = String((e && e.message) || e);
    } finally {
      stopThrottleWatch();
      state.busy = false;
      render();
    }
  }

  async function runSingle(id, keepPinned) {
    resetState("single", 1);
    state.phase = "deleting";
    render();
    const res = await deleteChat(id, keepPinned);
    tally(res);
    state.phase = res.status === "failed" || res.stuck ? "error" : "done";
    if (res.stuck) state.lastError = res.reason;
    state.busy = false;
    render();
    return res;
  }

  // ---------- on-page progress card ----------

  let overlay = null;
  let hideTimer = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .box{font:13px/1.4 system-ui,sans-serif;background:#1f1f1f;color:#f4f4f4;border-radius:10px;
        padding:10px 12px;display:flex;gap:12px;align-items:center;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:320px}
      .text{flex:1}
      button{font:inherit;background:#c0392b;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer}
    `;
    const box = document.createElement("div");
    box.className = "box";
    const text = document.createElement("div");
    text.className = "text";
    const stopBtn = document.createElement("button");
    stopBtn.textContent = "Stop";
    stopBtn.addEventListener("click", () => {
      state.stop = true;
      render();
    });
    box.append(text, stopBtn);
    shadow.append(style, box);
    document.documentElement.append(host);
    overlay = { host, text, stopBtn };
    return overlay;
  }

  const fmtDuration = (ms) => {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };

  function summary() {
    const parts = [`${state.deleted}${state.limit ? "/" + state.limit : ""} deleted`];
    const kept = state.skippedPinned + state.skippedUnknown;
    if (kept) parts.push(`${kept} kept`);
    if (state.failed) parts.push(`${state.failed} failed`);
    if (state.throttlePauses) parts.push(`${state.throttlePauses} pause${state.throttlePauses === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  function render() {
    if (state.phase === "idle") return;
    const o = ensureOverlay();
    clearTimeout(hideTimer);
    o.host.style.display = "";
    const label = {
      loading: "Loading chats…",
      deleting: state.stop ? "Stopping…" : "Deleting…",
      paused: "Paused — the site is throttling deletes…",
      done: "Done.",
      stopped: "Stopped.",
      error: "Stopped with an error.",
    }[state.phase];
    let text = `${label} ${summary()}`;
    if (state.phase === "paused" && state.pauseLeftMs) {
      text += ` · resuming in ${fmtDuration(state.pauseLeftMs)}`;
    }
    o.text.textContent = text;
    o.stopBtn.style.display = state.busy ? "" : "none";
    if (!state.busy) hideTimer = setTimeout(() => (o.host.style.display = "none"), 8000);
  }

  // ---------- messages from the popup ----------

  const publicState = () => ({ ...state });

  async function handle(msg) {
    if (!cfg) return { ok: false, error: "unsupported site" };
    switch (msg && msg.type) {
      case "ping":
        return { ok: true, platform: platformKey, label: cfg.label, pinnedWord: cfg.pinnedWord };
      case "scan":
        return { ok: true, chats: scan() };
      case "loadMore": {
        const grew = await loadMore();
        return { ok: true, grew, chats: scan() };
      }
      case "status":
        return { ok: true, state: publicState() };
      case "stop":
        state.stop = true;
        render();
        return { ok: true };
      case "start": {
        if (state.busy) return { ok: false, error: "a job is already running" };
        const limit = msg.mode === "all" ? null : Math.max(1, Math.min(100, Number(msg.limit) || 100));
        runSpeed = ["fast", "paced", "gentle"].includes(msg.speed) ? msg.speed : "fast";
        runJob({ mode: msg.mode, limit, keepPinned: !!msg.keepPinned });
        return { ok: true };
      }
      case "deleteOne": {
        if (state.busy) return { ok: false, error: "a job is already running" };
        const res = await runSingle(String(msg.id), !!msg.keepPinned);
        return { ok: true, result: res };
      }
      default:
        return { ok: false, error: "unknown message" };
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        try {
          sendResponse(await handle(msg));
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true; // keep the channel open for the async reply
    });
  }

  // Test hook: lets the jsdom tests drive the engine directly.
  globalThis.__AICC__ = { handle, state, CONFIG, scan, deleteChat };
})();
