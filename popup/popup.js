// Popup: talks to the content script in the active tab. All deleting happens
// in the page; the popup only asks for it and shows progress.

const $ = (id) => document.getElementById(id);

let tab = null;
let platform = null; // { key, label, pinnedWord }
let pollTimer = null;
let wasBusy = false;
let runSeq = 0; // bumped per run; a delayed reset only applies to its own run

function setMsg(text, isError = false) {
  const el = $("msg");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

async function send(message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (_firstError) {
    // Tab was open before the extension was installed: inject, then retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/selectors.js", "src/content.js"],
      });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
      throw new Error("Cannot reach the page. Reload the tab and try again.");
    }
  }
}

// ---------- individual chats ----------

function renderList(chats) {
  const list = $("list");
  list.replaceChildren();
  for (const chat of chats) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = chat.title;
    title.title = chat.title;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    armDeleteButton(btn, li, chat);
    li.append(title, btn);
    list.append(li);
  }
  $("listNote").textContent = chats.length
    ? `${chats.length} chats loaded in the sidebar.`
    : "No chats found in the sidebar. Open the sidebar, then refresh.";
}

// Two clicks within 3 seconds: the first arms the button, the second deletes.
function armDeleteButton(btn, li, chat) {
  let timer = null;
  btn.addEventListener("click", async () => {
    if (!timer) {
      btn.textContent = "Sure?";
      btn.classList.add("danger");
      timer = setTimeout(() => {
        timer = null;
        btn.textContent = "Delete";
        btn.classList.remove("danger");
      }, 3000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await send({ type: "deleteOne", id: chat.id, keepPinned: $("keepPinned").checked });
      const r = res && res.result;
      if (res && res.ok && r && r.status === "deleted") {
        li.remove();
        if (r.stuck) setMsg(r.reason, true);
        else setMsg("Chat deleted.");
      } else if (r && r.status === "skipped-pinned") {
        resetRowButton(btn);
        setMsg(`That chat is ${platform.pinnedWord}. Turn off "Keep ${platform.pinnedWord} chats" to delete it.`);
      } else {
        resetRowButton(btn);
        setMsg(`Not deleted: ${(r && r.reason) || (res && res.error) || "unknown reason"}.`, true);
      }
    } catch (e) {
      resetRowButton(btn);
      setMsg(e.message, true);
    }
  });
}

function resetRowButton(btn) {
  btn.disabled = false;
  btn.textContent = "Delete";
  btn.classList.remove("danger");
}

async function refreshList() {
  try {
    const res = await send({ type: "scan" });
    renderList((res && res.chats) || []);
  } catch (e) {
    setMsg(e.message, true);
  }
}

async function loadOlder() {
  $("moreBtn").disabled = true;
  try {
    const res = await send({ type: "loadMore" });
    renderList((res && res.chats) || []);
    if (res && !res.grew) setMsg("No older chats loaded. You may have reached the end.");
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    $("moreBtn").disabled = false;
  }
}

// ---------- bulk delete ----------

function selectedAmount() {
  return document.querySelector('input[name="amount"]:checked').value;
}

function selectedMode() {
  return selectedAmount() === "all" ? "all" : "newest";
}

function selectedLimit() {
  const a = selectedAmount();
  return a === "all" ? null : Number(a);
}

function describeMode(mode) {
  if (mode === "all") return "ALL chats";
  const n = selectedLimit();
  return `the ${mode} ${n} chats`;
}

function showConfirm() {
  const mode = selectedMode();
  const keep = $("keepPinned").checked;
  const word = platform.pinnedWord;
  $("confirmText").textContent =
    `Permanently delete ${describeMode(mode)} on ${platform.label}. ` +
    (keep ? `${cap(word)} chats are kept.` : `${cap(word)} chats will ALSO be deleted.`) +
    (keep && mode !== "all" ? " Kept chats do not count toward the limit." : "") +
    " This cannot be undone.";
  const needsTyping = mode === "all" || !keep;
  $("confirmInput").hidden = !needsTyping;
  $("confirmInput").value = "";
  $("confirmYes").disabled = needsTyping;
  $("confirmBox").hidden = false;
  if (needsTyping) $("confirmInput").focus();
  else $("confirmYes").focus();
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function startBulk() {
  try {
    const scan = await send({ type: "scan" });
    if (!scan || !scan.ok || !(scan.chats || []).length) {
      $("confirmBox").hidden = true;
      setMsg("Nothing to delete: the sidebar has no chats loaded.", true);
      return;
    }
    $("confirmBox").hidden = true;
    const res = await send({
      type: "start",
      mode: selectedMode(),
      limit: selectedLimit(),
      keepPinned: $("keepPinned").checked,
      speed: $("speed").value,
    });
    if (!res || !res.ok) {
      setMsg((res && res.error) || "Could not start.", true);
      return;
    }
    setMsg("");
    startPolling();
  } catch (e) {
    setMsg(e.message, true);
  }
}

// ---------- progress ----------

const PHASES = {
  loading: "Loading chats…",
  deleting: "Deleting…",
  paused: "Paused: ChatGPT is throttling…",
  done: "Done.",
  stopped: "Stopped.",
  error: "Stopped with an error.",
};

function renderStatus(s) {
  const show = s.phase !== "idle";
  $("statusBox").hidden = !show;
  if (!show) return;
  const bar = $("statusBar");
  if (bar) {
    const pct = s.limit
      ? Math.min(100, Math.round((s.deleted / s.limit) * 100))
      : s.phase === "done" && s.deleted ? 100 : 0;
    bar.style.width = pct + "%";
  }
  const parts = [`${s.deleted}${s.limit ? "/" + s.limit : ""} deleted`];
  const kept = s.skippedPinned + s.skippedUnknown;
  if (kept) parts.push(`${kept} kept`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.throttlePauses) parts.push(`${s.throttlePauses} pause${s.throttlePauses > 1 ? "s" : ""}`);
  let text = `${PHASES[s.phase] || s.phase} ${parts.join(" · ")}`;
  if (s.phase === "paused" && s.pauseLeftMs) {
    const secs = Math.ceil(s.pauseLeftMs / 1000);
    const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    text += `\nResuming in ~${dur}.`;
  }
  if (s.skippedUnknown) {
    text += `\n${s.skippedUnknown} kept because their ${platform.pinnedWord} state could not be read (the site menu may not be in English).`;
  }
  if (s.lastError && (s.phase === "error" || s.failed)) text += `\n${s.lastError}`;
  $("statusText").textContent = text;
  $("statusText").style.whiteSpace = "pre-line";
  $("stopBtn").hidden = !s.busy;
  if ($("bulkBtn")) $("bulkBtn").disabled = !!s.busy;
}

async function poll() {
  try {
    const res = await send({ type: "status" });
    if (!res || !res.ok) return;
    renderStatus(res.state);
    if (wasBusy && !res.state.busy) {
      stopPolling();
      await refreshList();
      // Show the terminal state briefly, then reset the progress card so the
      // next run starts clean. Guarded: a newer run cancels the reset.
      const seq = runSeq;
      setTimeout(() => {
        if (seq !== runSeq) return;
        $("statusBox").hidden = true;
        if ($("statusBar")) $("statusBar").style.width = "0%";
        $("statusText").textContent = "";
      }, 4000);
    }
    wasBusy = res.state.busy;
    if (!res.state.busy) stopPolling();
  } catch (_e) {
    stopPolling();
  }
}

function startPolling() {
  wasBusy = true;
  runSeq++;
  stopPolling();
  pollTimer = setInterval(poll, 600);
  poll();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- init ----------

async function init() {
  try {
    $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_e) {
    /* version display is best-effort */
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active;
  let host = "";
  try {
    host = new URL(tab.url).hostname;
  } catch (_e) {
    /* chrome:// pages and similar have no usable URL */
  }
  const key = globalThis.AICC_SELECTORS.detectPlatform(host);
  if (!key) return;

  const info = globalThis.AICC_SELECTORS.PLATFORMS[key];
  platform = { key, label: info.label, pinnedWord: info.pinnedWord };
  $("site").textContent = info.label;
  $("unsupported").hidden = true;
  $("app").hidden = false;

  $("keepLabel").textContent = `Keep ${platform.pinnedWord} chats`;
  $("keepHint").textContent =
    "Checked by opening each chat's menu, using its English labels (Pin/Unpin, Star/Unstar). " +
    "If the label cannot be read, the chat is kept.";

  const { keepPinned = true } = await chrome.storage.local.get("keepPinned");
  $("keepPinned").checked = keepPinned;
  $("keepPinned").addEventListener("change", () =>
    chrome.storage.local.set({ keepPinned: $("keepPinned").checked })
  );

  // Speed only changes ChatGPT behavior: Paced and Fast skip the site's ~11s
  // dialog-close timer; Gemini and Claude always use the wait-and-settle
  // path, so the row stays hidden there.
  const { speed = "paced" } = await chrome.storage.local.get("speed");
  $("speed").value = speed;
  $("speed").addEventListener("change", () => chrome.storage.local.set({ speed: $("speed").value }));
  if (key === "chatgpt") {
    $("speedRow").hidden = false;
    $("speedHint").textContent = `Paced and Fast skip ${info.label}'s ~11s dialog close timer. Gentle is the slowest, safest path.`;
  }

  $("bulkBtn").addEventListener("click", showConfirm);
  $("confirmNo").addEventListener("click", () => ($("confirmBox").hidden = true));
  $("confirmYes").addEventListener("click", startBulk);
  $("confirmInput").addEventListener("input", () => {
    $("confirmYes").disabled = $("confirmInput").value.trim() !== "DELETE";
  });
  $("stopBtn").addEventListener("click", () => send({ type: "stop" }));
  $("scanBtn").addEventListener("click", refreshList);
  $("moreBtn").addEventListener("click", loadOlder);

  try {
    const ping = await send({ type: "ping" });
    if (!ping || !ping.ok) throw new Error("no reply");
    const st = await send({ type: "status" });
    if (st && st.ok && st.state.busy) startPolling();
    else {
      // Never show a stale terminal state on open: progress belongs to a
      // live run only. A finished run already reset itself via poll().
      $("statusBox").hidden = true;
      if ($("statusBar")) $("statusBar").style.width = "0%";
      $("statusText").textContent = "";
    }
    await refreshList();
  } catch (e) {
    setMsg(e.message, true);
  }
}

init().catch((e) => setMsg(String(e.message || e), true));
