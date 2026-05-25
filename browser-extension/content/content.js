// ─────────────────────────────────────────────────────────
//  content.js — Densify Context content script
// ─────────────────────────────────────────────────────────
//  Injected into LLM chat pages. Detects textareas and
//  contenteditable elements, injects a floating "⚡"
//  optimize button, and shows an overlay with the result.
// ─────────────────────────────────────────────────────────

;(function () {
  'use strict';

  const engine = window.DensifyEngine;
  if (!engine) {
    console.warn('[Densify Context] Engine not loaded');
    return;
  }

  // ── State ─────────────────────────────────────────
  let activeElement = null;     // The textarea/contenteditable currently focused
  let floatBtn = null;          // The floating ⚡ button
  let overlay = null;           // The results overlay
  let lastOptimized = null;     // Last optimization result

  // ── Create floating button ────────────────────────
  function createFloatButton() {
    const btn = document.createElement('button');
    btn.className = 'dcx-float-btn';
    btn.textContent = '⚡';
    btn.title = 'Densify — Optimize this prompt';
    btn.addEventListener('click', handleOptimize);
    document.body.appendChild(btn);
    return btn;
  }

  // ── Position the float button near the active input ─
  function positionFloatButton(el) {
    if (!floatBtn || !el) return;

    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    // Place at top-right corner of the textarea
    floatBtn.style.top  = (rect.top + scrollY + 4) + 'px';
    floatBtn.style.left = (rect.right + scrollX - 40) + 'px';
  }

  // ── Show / hide float button ──────────────────────
  function showFloatButton(el) {
    if (!floatBtn) floatBtn = createFloatButton();
    activeElement = el;
    positionFloatButton(el);
    floatBtn.classList.add('dcx-visible');
  }

  function hideFloatButton() {
    if (floatBtn) floatBtn.classList.remove('dcx-visible');
  }

  // ── Get text from element ─────────────────────────
  function getTextFromElement(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el.value;
    }
    // contenteditable
    return el.innerText || el.textContent || '';
  }

  // ── Set text on element ───────────────────────────
  function setTextOnElement(el, text) {
    if (!el) return;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // Use native input setter to trigger React/framework change events
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, text);
      } else {
        el.value = text;
      }

      // Dispatch events for React/Vue/Angular
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ── Handle optimize click ─────────────────────────
  function handleOptimize(e) {
    e.stopPropagation();
    e.preventDefault();

    if (!activeElement) return;

    const text = getTextFromElement(activeElement);
    if (!text || text.trim().length < 5) return;

    // Loading state
    floatBtn.classList.add('dcx-loading');

    requestAnimationFrame(() => {
      const result = engine.optimizePrompt(text);
      lastOptimized = result;

      floatBtn.classList.remove('dcx-loading');

      if (result.savings.saved > 0) {
        showOverlay(result);
      }
    });
  }

  // ── Create overlay panel ──────────────────────────
  function createOverlay() {
    const el = document.createElement('div');
    el.className = 'dcx-overlay';
    el.innerHTML = `
      <div class="dcx-overlay-header">
        <div class="dcx-overlay-title">
          <span class="dcx-icon">⚡</span>
          <span>Densify Context</span>
        </div>
        <button class="dcx-close-btn" id="dcx-close">✕</button>
      </div>
      <div class="dcx-stats">
        <div class="dcx-stat">
          <div class="dcx-stat-value dcx-tokens" id="dcx-stat-tokens">0</div>
          <div class="dcx-stat-label">Tokens Saved</div>
        </div>
        <div class="dcx-stat">
          <div class="dcx-stat-value dcx-percent" id="dcx-stat-percent">0%</div>
          <div class="dcx-stat-label">Compressed</div>
        </div>
        <div class="dcx-stat">
          <div class="dcx-stat-value dcx-cost" id="dcx-stat-cost">$0</div>
          <div class="dcx-stat-label">Saved</div>
        </div>
      </div>
      <div class="dcx-optimized-text" id="dcx-optimized"></div>
      <div class="dcx-actions">
        <button class="dcx-action-btn dcx-primary" id="dcx-replace">🔄 Replace</button>
        <button class="dcx-action-btn dcx-secondary" id="dcx-copy">📋 Copy</button>
        <button class="dcx-action-btn dcx-secondary" id="dcx-dismiss">Dismiss</button>
      </div>
    `;

    document.body.appendChild(el);

    // Event listeners
    el.querySelector('#dcx-close').addEventListener('click', hideOverlay);
    el.querySelector('#dcx-dismiss').addEventListener('click', hideOverlay);
    el.querySelector('#dcx-replace').addEventListener('click', handleReplace);
    el.querySelector('#dcx-copy').addEventListener('click', handleCopy);

    // Prevent clicks from propagating to the page
    el.addEventListener('mousedown', e => e.stopPropagation());

    return el;
  }

  // ── Show overlay with result ──────────────────────
  function showOverlay(result) {
    if (!overlay) overlay = createOverlay();

    // Position near the active element
    if (activeElement) {
      const rect = activeElement.getBoundingClientRect();
      const overlayWidth = 380;
      const overlayHeight = 320;

      let top = rect.bottom + 8;
      let left = rect.right - overlayWidth;

      // Keep within viewport
      if (left < 8) left = 8;
      if (top + overlayHeight > window.innerHeight) {
        top = rect.top - overlayHeight - 8;
      }

      overlay.style.position = 'fixed';
      overlay.style.top = top + 'px';
      overlay.style.left = left + 'px';
    }

    // Populate
    overlay.querySelector('#dcx-stat-tokens').textContent = result.savings.saved;
    overlay.querySelector('#dcx-stat-percent').textContent = result.savings.percentage + '%';
    overlay.querySelector('#dcx-stat-cost').textContent = '$' + result.savings.costSaved.toFixed(4);
    overlay.querySelector('#dcx-optimized').textContent = result.optimized;

    // Show with animation
    requestAnimationFrame(() => {
      overlay.classList.add('dcx-visible');
    });
  }

  function hideOverlay() {
    if (overlay) {
      overlay.classList.remove('dcx-visible');
    }
  }

  // ── Replace text in active element ────────────────
  function handleReplace() {
    if (!lastOptimized || !activeElement) return;

    setTextOnElement(activeElement, lastOptimized.optimized);
    hideOverlay();

    // Brief success flash on the float button
    if (floatBtn) {
      floatBtn.textContent = '✓';
      floatBtn.style.background = 'linear-gradient(135deg, #00D68F, #00B377)';
      setTimeout(() => {
        floatBtn.textContent = '⚡';
        floatBtn.style.background = '';
      }, 1200);
    }
  }

  // ── Copy optimized text ───────────────────────────
  async function handleCopy() {
    if (!lastOptimized) return;
    try {
      await navigator.clipboard.writeText(lastOptimized.optimized);
      const btn = overlay.querySelector('#dcx-copy');
      btn.textContent = '✓ Copied!';
      btn.classList.add('dcx-success');
      setTimeout(() => {
        btn.textContent = '📋 Copy';
        btn.classList.remove('dcx-success');
      }, 1200);
    } catch (e) {
      // Fallback: create temp textarea
      const tmp = document.createElement('textarea');
      tmp.value = lastOptimized.optimized;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
    }
  }

  // ── Detect textareas and contenteditable ──────────
  function isInputElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT' && el.type === 'text') return true;
    if (el.contentEditable === 'true' || el.contentEditable === 'plaintext-only') return true;
    // Also check parent for contenteditable
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    return false;
  }

  function getEditableElement(el) {
    if (!el) return null;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) return el;
    if (el.contentEditable === 'true' || el.contentEditable === 'plaintext-only') return el;
    const parent = el.closest && el.closest('[contenteditable="true"]');
    if (parent) return parent;
    return null;
  }

  // ── Focus / blur handlers ─────────────────────────
  document.addEventListener('focusin', (e) => {
    const editable = getEditableElement(e.target);
    if (editable) {
      // Delay slightly so the element is fully rendered
      setTimeout(() => showFloatButton(editable), 200);
    }
  }, true);

  document.addEventListener('focusout', (e) => {
    // Don't hide if focus moved to our button or overlay
    setTimeout(() => {
      const focused = document.activeElement;
      if (focused && (
        focused.classList.contains('dcx-float-btn') ||
        focused.closest('.dcx-overlay')
      )) return;

      hideFloatButton();
    }, 150);
  }, true);

  // ── Reposition on scroll/resize ───────────────────
  let repositionRAF = null;
  function handleReposition() {
    if (repositionRAF) cancelAnimationFrame(repositionRAF);
    repositionRAF = requestAnimationFrame(() => {
      if (activeElement) positionFloatButton(activeElement);
    });
  }

  window.addEventListener('scroll', handleReposition, { passive: true });
  window.addEventListener('resize', handleReposition, { passive: true });

  // ── Message handler (from popup) ──────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'DENSIFY_GET_TEXT') {
      const text = activeElement ? getTextFromElement(activeElement) : '';
      sendResponse({ text });
      return true;
    }

    if (msg.type === 'DENSIFY_REPLACE') {
      if (activeElement && msg.text) {
        setTextOnElement(activeElement, msg.text);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false });
      }
      return true;
    }
  });

  // ── MutationObserver for dynamically added textareas
  const observer = new MutationObserver((mutations) => {
    // If the active element was removed, clean up
    if (activeElement && !document.contains(activeElement)) {
      activeElement = null;
      hideFloatButton();
      hideOverlay();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // ── Close overlay on Escape ───────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideOverlay();
    }
  });

  console.log('[Densify Context] Content script loaded ✓');
})();
