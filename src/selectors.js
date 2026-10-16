// Per-site selectors and pure helpers. Everything that breaks when a site
// redesigns its sidebar lives in this file.
//
// STATUS: these selectors were cross-checked against the open-source
// hirakujira/AI-Chat-Bulk-Deleter `src/selectors.js` (read on 2026-10-15).
// They have NOT been run against the live sites by the author of this file.
// If a site stops working, fix the entry for that site here.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.AICC_SELECTORS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PLATFORMS = {
    chatgpt: {
      label: "ChatGPT",
      pinnedWord: "pinned",
      // Conversation id from /c/<id>, also when nested under a project path.
      hrefPattern: /\/c\/([0-9a-zA-Z-]+)/,
      // Radix menus open on pointerdown, not click.
      triggerActivation: "pointerdown",
      selectors: {
        // Two sidebar shapes seen live: the older one keys rows with
        // data-sidebar-chatgpt-conversation-key; a newer bundle uses
        // a[data-interactive-row-link] directly. Accept both.
        conversationLink:
          '[data-sidebar-chatgpt-conversation-key] a[href*="/c/"], a[data-interactive-row-link][href*="/c/"]',
        optionsTrigger: 'button[aria-haspopup="menu"]',
        menu: '[role="menu"]',
        // Class-based, so fragile; text matching is the fallback.
        deleteMenuItem: '[role="menuitem"].text-danger',
        confirmDialog: '[role="dialog"]',
        confirmDeleteButton: 'button[type="submit"]',
      },
    },
    gemini: {
      label: "Gemini",
      pinnedWord: "pinned",
      // /app/<id> or the account-scoped /u/<n>/app/<id>.
      hrefPattern: /\/app\/([0-9a-zA-Z_-]+)/,
      triggerActivation: "click",
      selectors: {
        conversationLink: '[data-test-id="conversation"] a[href*="/app/"], a[href^="/app/"]',
        optionsTrigger: 'button:has(mat-icon[fonticon="more_vert"]), button[aria-haspopup="menu"]',
        menu: '[role="menu"]',
        deleteMenuItem: 'button[data-test-id="delete-button"]',
        confirmDialog: '[role="dialog"], mat-dialog-container, .mat-mdc-dialog-surface',
        confirmDeleteButton:
          'gem-button[cdkfocusinitial] button, [cdkfocusinitial] button, button[cdkfocusinitial]',
      },
    },
    claude: {
      label: "Claude",
      pinnedWord: "starred",
      hrefPattern: /\/chat\/([0-9a-zA-Z-]+)/,
      triggerActivation: "click",
      selectors: {
        conversationLink:
          'a[data-row-main-button][href^="/chat/"], a[data-dd-action-name="sidebar-chat-item"], a[data-primary="true"][href^="/chat/"]',
        optionsTrigger: 'button[data-row-action][aria-haspopup="menu"], button[aria-haspopup="menu"]',
        menu: '[role="menu"]',
        deleteMenuItem: '[data-testid="delete-chat-trigger"]',
        // Claude's confirm dialog is role="alertdialog".
        confirmDialog: '[role="alertdialog"]',
        confirmDeleteButton: null,
      },
    },
  };

  function detectPlatform(hostname) {
    if (typeof hostname !== "string") return null;
    if (hostname === "chatgpt.com" || hostname === "chat.openai.com") return "chatgpt";
    if (hostname === "gemini.google.com") return "gemini";
    if (hostname === "claude.ai") return "claude";
    return null;
  }

  function parseConversationId(href, platformKey) {
    const platform = PLATFORMS[platformKey];
    if (!platform || typeof href !== "string" || href.length === 0) return null;
    let path = href;
    try {
      path = new URL(href, "https://example.invalid").pathname;
    } catch (_e) {
      // keep href as a path
    }
    const match = platform.hrefPattern.exec(path);
    return match ? match[1] : null;
  }

  // Pin state comes from the row's own menu: a pinned chat offers "Unpin"
  // (ChatGPT, Gemini) or "Unstar" (Claude); an unpinned one offers "Pin"/"Star".
  // English labels only. Anything else returns "unknown", and the engine
  // treats "unknown" as "do not delete" while the keep-pinned toggle is on.
  const PINNED_RE = /\bun-?(pin|star)/i;
  const UNPINNED_RE = /^\s*(pin|star)\b/i;
  const DELETE_RE = /\bdelete\b/i;

  function classifyMenu(labels) {
    if (!Array.isArray(labels)) return "unknown";
    if (labels.some((t) => PINNED_RE.test(t))) return "pinned";
    if (labels.some((t) => UNPINNED_RE.test(t))) return "unpinned";
    return "unknown";
  }

  return { PLATFORMS, detectPlatform, parseConversationId, classifyMenu, DELETE_RE };
});
