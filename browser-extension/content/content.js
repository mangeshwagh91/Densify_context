// ─────────────────────────────────────────────────────────
//  content.js — Densify Context content script v3
// ─────────────────────────────────────────────────────────

;(function () {
  'use strict';

  const engine = window.DensifyEngine;
  if (!engine) {
    console.warn('[Densify] Engine not loaded');
    return;
  }

  // ── State ─────────────────────────────────────────
  let activeEl    = null;   // Currently focused editable
  let floatBtn    = null;   // ⚡ badge button
  let popupEl     = null;   // Suggestion popup card
  let mirrorEl    = null;   // Transparent highlight overlay
  let suggestions = [];     // Current suggestion list
  let dismissed   = new Set();
  let activeSugId = null;   // ID shown in popup
  let debounce    = null;

  // ── Helpers ───────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function isEditable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT' && /^(text|search|url|email)$/.test(el.type || '')) return true;
    const ce = el.getAttribute('contenteditable');
    return ce === 'true' || ce === 'plaintext-only';
  }

  // Find the closest meaningful editable element
  function findEditable(el) {
    if (!el) return null;
    // Walk up at most 10 levels to find a real editable
    let cur = el;
    for (let i = 0; i < 10; i++) {
      if (!cur || cur === document.body) break;
      if (isEditable(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function getText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    // For contenteditable: use innerText for proper line breaks
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
  }

  function setText(el, text) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable – set innerText, dispatch InputEvent
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  // ── Float button ──────────────────────────────────

  function ensureFloatBtn() {
    if (floatBtn) return floatBtn;
    floatBtn = document.createElement('button');
    floatBtn.className = 'dcx-float-btn';
    floatBtn.title = 'Densify — optimize this prompt';
    floatBtn.innerHTML =
      '<span class="dcx-fi">⚡</span>' +
      '<span class="dcx-fc"></span>';
    floatBtn.addEventListener('mousedown', onBtnClick);
    document.body.appendChild(floatBtn);
    return floatBtn;
  }

  function placeBtn(el) {
    const btn = ensureFloatBtn();
    const rect = el.getBoundingClientRect();
    // Position inside the element at the bottom-right (like Grammarly)
    btn.style.top  = Math.round(rect.top  + rect.height - 34) + 'px';
    btn.style.left = Math.round(rect.left + rect.width  - 40) + 'px';
    // Update count badge
    const live = suggestions.filter(s => !dismissed.has(s.id));
    const fc = btn.querySelector('.dcx-fc');
    if (live.length > 0) {
      fc.textContent    = live.length;
      fc.style.display  = 'flex';
    } else {
      fc.style.display  = 'none';
    }
    btn.classList.add('dcx-visible');
  }

  function hideBtn() {
    if (floatBtn) floatBtn.classList.remove('dcx-visible');
  }

  function onBtnClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const live = suggestions.filter(s => !dismissed.has(s.id));
    if (!live.length) return;
    // Toggle popup
    if (popupEl && popupEl.classList.contains('dcx-sp-on')) {
      closePopup();
    } else {
      const rect = floatBtn.getBoundingClientRect();
      openPopupFor(live[0], rect);
    }
  }

  // ── Mirror overlay ────────────────────────────────

  const COPY_STYLES = [
    'boxSizing','paddingTop','paddingRight','paddingBottom','paddingLeft',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'fontFamily','fontSize','fontStyle','fontWeight','fontVariant','fontStretch',
    'lineHeight','letterSpacing','wordSpacing','textAlign','textTransform',
    'textIndent','wordBreak','wordWrap','whiteSpace','tabSize',
  ];

  function ensureMirror() {
    if (mirrorEl) return mirrorEl;
    mirrorEl = document.createElement('div');
    mirrorEl.className = 'dcx-mirror';
    document.body.appendChild(mirrorEl);
    return mirrorEl;
  }

  function syncMirror(el) {
    const m = ensureMirror();
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    // Copy text styles
    for (const p of COPY_STYLES) m.style[p] = cs[p];

    // Position with fixed so it tracks viewport
    m.style.position   = 'fixed';
    m.style.top        = rect.top    + 'px';
    m.style.left       = rect.left   + 'px';
    m.style.width      = rect.width  + 'px';
    m.style.height     = rect.height + 'px';
    m.style.overflow   = 'hidden';
    m.style.background = 'transparent';
    m.style.color      = 'transparent';
    m.style.zIndex     = '2147483643';
    m.style.pointerEvents = 'none';

    // Sync scroll
    m.scrollTop  = el.scrollTop;
    m.scrollLeft = el.scrollLeft;
  }

  function buildMirrorHTML(text, live) {
    if (!live.length) return escHtml(text);
    const sorted = [...live].sort((a,b) => a.startIndex - b.startIndex);
    let html = '', pos = 0;
    for (const s of sorted) {
      if (s.startIndex < pos) continue;
      html += escHtml(text.slice(pos, s.startIndex));
      html += `<mark class="dcx-hl dcx-hl-${s.type}" data-id="${s.id}">${escHtml(text.slice(s.startIndex, s.endIndex))}</mark>`;
      pos = s.endIndex;
    }
    html += escHtml(text.slice(pos));
    return html;
  }

  function refreshMirror() {
    if (!activeEl) return;
    const m = ensureMirror();
    syncMirror(activeEl);
    const text = getText(activeEl);
    const live = suggestions.filter(s => !dismissed.has(s.id));
    m.innerHTML = buildMirrorHTML(text, live);

    // Attach mousedown on marks (pointer-events auto)
    m.querySelectorAll('.dcx-hl').forEach(mark => {
      mark.style.pointerEvents = 'auto';
      mark.style.cursor = 'pointer';
      mark.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sug = suggestions.find(s => s.id === mark.dataset.id);
        if (!sug) return;
        openPopupFor(sug, mark.getBoundingClientRect());
      });
    });
  }

  // ── Popup ─────────────────────────────────────────

  function ensurePopup() {
    if (popupEl) return popupEl;

    popupEl = document.createElement('div');
    popupEl.className = 'dcx-suggestion-popup';
    popupEl.innerHTML = `
      <div class="dcx-sp-hd">
        <div class="dcx-sp-ttl">
          <span class="dcx-sp-ic">⚡</span>
          <span>Densify Suggestion</span>
        </div>
        <button class="dcx-sp-x" id="dcx-sp-x">✕</button>
      </div>
      <div class="dcx-sp-badge" id="dcx-sp-badge"></div>
      <div class="dcx-sp-body" id="dcx-sp-body"></div>
      <div class="dcx-sp-nav" id="dcx-sp-nav"></div>
      <div class="dcx-sp-btns">
        <button class="dcx-sp-accept" id="dcx-sp-ok">Accept</button>
        <button class="dcx-sp-dismiss" id="dcx-sp-no">Dismiss</button>
      </div>`;

    popupEl.querySelector('#dcx-sp-x').addEventListener('click',  closePopup);
    popupEl.querySelector('#dcx-sp-ok').addEventListener('click', onAccept);
    popupEl.querySelector('#dcx-sp-no').addEventListener('click', onDismiss);
    popupEl.addEventListener('mousedown', e => e.stopPropagation());
    document.body.appendChild(popupEl);
    return popupEl;
  }

  function openPopupFor(sug, anchor) {
    const p = ensurePopup();
    activeSugId = sug.id;

    const LABELS = {
      phrase:'Verbose Phrase', filler:'Filler Word',
      ceremony:'Prompt Ceremony', redundant:'Redundant Modifier', structural:'Structure',
    };

    // Badge
    const badge = p.querySelector('#dcx-sp-badge');
    badge.textContent  = LABELS[sug.type] || sug.type;
    badge.className    = 'dcx-sp-badge dcx-badge-' + sug.type;

    // Body
    const rep = sug.replacement === '(remove)'
      ? '<em class="dcx-rem">(remove)</em>'
      : `<span class="dcx-rep">${escHtml(sug.replacement)}</span>`;

    p.querySelector('#dcx-sp-body').innerHTML = `
      <div class="dcx-change">
        <span class="dcx-orig">${escHtml(sug.original)}</span>
        <span class="dcx-arr">→</span>
        ${rep}
      </div>
      <div class="dcx-expl">${escHtml(sug.explanation)}</div>
      ${sug.tokensSaved > 0 ? `<div class="dcx-tok">−${sug.tokensSaved} token${sug.tokensSaved>1?'s':''}</div>` : ''}`;

    // Nav: 1 of N
    const live = suggestions.filter(s => !dismissed.has(s.id));
    const idx  = live.findIndex(s => s.id === sug.id);
    const nav  = p.querySelector('#dcx-sp-nav');
    if (live.length > 1) {
      nav.innerHTML = `
        <button class="dcx-nav-btn" id="dcx-prev" ${idx===0?'disabled':''}>‹</button>
        <span>${idx+1} / ${live.length}</span>
        <button class="dcx-nav-btn" id="dcx-next" ${idx===live.length-1?'disabled':''}>›</button>`;
      nav.querySelector('#dcx-prev')?.addEventListener('click', () => {
        if (idx > 0) openPopupFor(live[idx-1], floatBtn.getBoundingClientRect());
      });
      nav.querySelector('#dcx-next')?.addEventListener('click', () => {
        if (idx < live.length-1) openPopupFor(live[idx+1], floatBtn.getBoundingClientRect());
      });
      nav.style.display = 'flex';
    } else {
      nav.style.display = 'none';
    }

    // Position (fixed, below anchor)
    const PW = 320;
    let t = anchor.bottom + 10;
    let l = anchor.left;
    if (l + PW > window.innerWidth - 8) l = window.innerWidth - PW - 8;
    if (l < 8) l = 8;
    p.style.top  = t + 'px';
    p.style.left = l + 'px';

    // Animate in
    p.classList.remove('dcx-sp-on');
    // Force reflow so removing class takes effect
    void p.offsetHeight;
    // Clamp bottom after layout
    requestAnimationFrame(() => {
      const h = p.offsetHeight;
      if (t + h > window.innerHeight - 8) {
        t = anchor.top - h - 10;
        if (t < 8) t = 8;
        p.style.top = t + 'px';
      }
      p.classList.add('dcx-sp-on');
    });
  }

  function closePopup() {
    if (!popupEl) return;
    popupEl.classList.remove('dcx-sp-on');
    activeSugId = null;
  }

  function onAccept() {
    if (!activeSugId || !activeEl) return;
    const text = getText(activeEl);
    const newText = engine.applySuggestions(text, suggestions, [activeSugId]);
    setText(activeEl, newText);
    closePopup();
    scheduleAnalyze(0);
  }

  function onDismiss() {
    if (!activeSugId) return;
    dismissed.add(activeSugId);
    closePopup();
    // Move to next if available
    const live = suggestions.filter(s => !dismissed.has(s.id));
    if (live.length > 0) {
      setTimeout(() => openPopupFor(live[0], floatBtn.getBoundingClientRect()), 100);
    }
    refreshMirror();
    placeBtn(activeEl);
  }

  // ── Analysis ──────────────────────────────────────

  function scheduleAnalyze(delay = 450) {
    clearTimeout(debounce);
    debounce = setTimeout(analyze, delay);
  }

  function analyze() {
    if (!activeEl) return;
    const text = getText(activeEl);
    if (!text || text.trim().length < 3) {
      suggestions = [];
      if (mirrorEl) mirrorEl.innerHTML = '';
      hideBtn();
      return;
    }
    suggestions = engine.getSuggestions(text).filter(s => !dismissed.has(s.id));
    refreshMirror();
    placeBtn(activeEl);
  }

  // ── Focus detection ───────────────────────────────
  // Use multiple strategies so we catch all frameworks

  function onFocusIn(e) {
    const el = findEditable(e.target);
    if (!el || el === activeEl) return;

    // Clean up previous listeners
    if (activeEl) {
      activeEl.removeEventListener('input', onInput);
      activeEl.removeEventListener('keyup', onInput);
      activeEl.removeEventListener('scroll', onScroll);
    }

    activeEl = el;
    dismissed.clear();
    suggestions = [];

    el.addEventListener('input',  onInput, { passive: true });
    el.addEventListener('keyup',  onInput, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });

    // Show button immediately (even before analysis)
    placeBtn(el);
    scheduleAnalyze(300);
  }

  function onFocusOut(e) {
    setTimeout(() => {
      const f = document.activeElement;
      if (!f) { hideBtn(); closePopup(); return; }
      if (
        f === floatBtn ||
        floatBtn?.contains(f) ||
        popupEl?.contains(f)
      ) return;
      // Check if focus is still in an editable
      const ne = findEditable(f);
      if (ne) return; // focus moved to another input — onFocusIn will handle
      hideBtn();
      closePopup();
      if (mirrorEl) mirrorEl.innerHTML = '';
    }, 200);
  }

  function onInput() {
    syncMirror(activeEl);
    scheduleAnalyze(450);
  }

  function onScroll() {
    if (activeEl && mirrorEl) syncMirror(activeEl);
    if (activeEl && floatBtn) placeBtn(activeEl);
  }

  // ── Reposition on page scroll / resize ───────────
  let rafId = null;
  function reposition() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      if (activeEl) {
        if (mirrorEl) syncMirror(activeEl);
        placeBtn(activeEl);
      }
    });
  }

  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  // ── Wire up events ────────────────────────────────
  document.addEventListener('focusin',  onFocusIn,  { capture: true });
  document.addEventListener('focusout', onFocusOut, { capture: true });

  // Close popup on outside click
  document.addEventListener('mousedown', (e) => {
    if (!popupEl) return;
    if (popupEl.contains(e.target)) return;
    if (floatBtn?.contains(e.target)) return;
    if (e.target.classList?.contains('dcx-hl')) return;
    closePopup();
  }, { capture: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopup();
  });

  // ── MutationObserver: clean up if active element removed ──
  new MutationObserver(() => {
    if (activeEl && !document.contains(activeEl)) {
      activeEl = null;
      if (mirrorEl) mirrorEl.innerHTML = '';
      hideBtn();
      closePopup();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ── Chrome extension message bridge ───────────────
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'DENSIFY_GET_TEXT') {
      reply({ text: activeEl ? getText(activeEl) : '' });
      return true;
    }
    if (msg.type === 'DENSIFY_REPLACE' && activeEl && msg.text) {
      setText(activeEl, msg.text);
      scheduleAnalyze(0);
      reply({ success: true });
      return true;
    }
  });

  console.log('[Densify] ✓ loaded (v3)');
})();
