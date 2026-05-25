// ─────────────────────────────────────────────────────────
//  service-worker.js — Background service worker
// ─────────────────────────────────────────────────────────
//  Handles extension lifecycle events and context menus.
//  The optimization engine runs in content scripts and
//  popup, not here — keeping the SW lightweight.
// ─────────────────────────────────────────────────────────

// ── Installation ────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Densify Context] Extension installed');
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
    // Open popup with the selected text
    // Since we can't programmatically open the popup,
    // we send the text to the content script for inline optimization
    chrome.tabs.sendMessage(tab.id, {
      type: 'DENSIFY_OPTIMIZE_SELECTION',
      text: info.selectionText,
    }).catch(() => {
      // Content script not available on this page
      console.log('[Densify Context] Content script not available on this page');
    });
  }
});

// ── Message relay (if needed between popup ↔ content) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Future: relay messages, handle storage, etc.
  return false;
});
