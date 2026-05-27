// ─────────────────────────────────────────────────────────
//  service-worker.js — Background service worker  (v2)
// ─────────────────────────────────────────────────────────
//  Handles extension lifecycle events and context menus.
//  The optimization engine runs in content scripts and
//  popup, not here — keeping the SW lightweight.
//
//  v2 additions:
//    - Persists model preference via chrome.storage.local
//    - Sets extension badge text/color after context-menu optimize
//    - DENSIFY_PING health-check handler so popup can detect
//      whether a content script is alive on the current tab
// ─────────────────────────────────────────────────────────

// ── Installation ────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Densify Context] Extension installed');
    // Set default model preference
    chrome.storage.local.set({ dcx_model: 'gpt-4o' });
  } else if (details.reason === 'update') {
    console.log('[Densify Context] Extension updated to', chrome.runtime.getManifest().version);
  }

  // Create context menu
  chrome.contextMenus?.create({
    id: 'densify-optimize',
    title: 'Densify — Optimize selected text',
    contexts: ['selection'],
  });
});

// ── Context menu handler ────────────────────────────────
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'densify-optimize' && info.selectionText) {
    // Send the selected text to the content script for inline optimization
    chrome.tabs.sendMessage(tab.id, {
      type: 'DENSIFY_OPTIMIZE_SELECTION',
      text: info.selectionText,
    }).then((response) => {
      // Flash the badge to confirm optimization happened
      if (response && response.success) {
        const saved = response.tokensSaved || 0;
        const label = saved > 0 ? `-${saved}` : '✓';
        _flashBadge(tab.id, label, '#10b981'); // green
      }
    }).catch(() => {
      // Content script not available on this page
      console.log('[Densify Context] Content script not available on this page');
    });
  }
});

// ── Badge flash helper ──────────────────────────────────
function _flashBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId });
  }, 3000);
}

// ── Message relay ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Health-check: lets the popup know if a content script is alive
  // on a specific tab without needing to query the tab directly.
  if (msg.type === 'DENSIFY_PING_TAB' && msg.tabId) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'DENSIFY_PING' })
      .then(res => sendResponse({ alive: true, suggestions: res?.suggestions || 0 }))
      .catch(() => sendResponse({ alive: false }));
    return true; // keep channel open for async
  }

  // Model preference relay (future use for cross-context sync)
  if (msg.type === 'DENSIFY_SET_MODEL' && msg.model) {
    chrome.storage.local.set({ dcx_model: msg.model });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
