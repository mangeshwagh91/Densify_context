// ─────────────────────────────────────────────────────────
//  content.js — Densify Context v5
//  Grammarly-style: Shadow DOM aware, proactive DOM scanning,
//  multi-strategy focus detection, instant button display.
//
//  v5 improvements:
//    - React-compatible setText() using nativeInputValueSetter
//    - "Analyzing…" pulse animation on float badge during analysis
//    - "Accept All" button in popup
//    - Tab-visibility pause: polling stops when tab is hidden
//    - ResizeObserver on activeEl to reposition on layout shift
//    - Stale result guard: superseded worker responses are discarded
//    - sessionStorage per-host dismissal persistence (cleared on new session)
//    - Mirror rebuild throttled with rAF to avoid heavy sync DOM work
// ─────────────────────────────────────────────────────────

; (function () {
  'use strict';

  const engine = window.DensifyEngine;
  const bridge = window.DensifyWorkerBridge ? window.DensifyWorkerBridge.getInstance() : null;

  if (!engine) { console.warn('[Densify] Engine not loaded'); return; }
  if (bridge) { console.log('[Densify] Web Worker bridge initialized'); }

  // ── State ─────────────────────────────────────────────
  let activeEl = null;
  let floatBtn = null;
  let popupEl = null;
  let mirrorEl = null;
  let suggestions = [];
  let dismissed = new Set();
  let activeSugId = null;
  let debounce = null;
  let mirrorRaf = null;         // rAF handle for mirror rebuild
  let resizeObs = null;         // ResizeObserver on activeEl

  // Track elements we've already attached direct listeners to
  const attached = new WeakSet();

  // ── Dismissed persistence (per hostname, session-scoped) ──────────────────

  const _storageKey = 'dcx_dismissed_' + location.hostname;

  function _loadDismissed() {
    try {
      const raw = sessionStorage.getItem(_storageKey);
      if (raw) { const ids = JSON.parse(raw); if (Array.isArray(ids)) return new Set(ids); }
    } catch (_) { }
    return new Set();
  }

  function _saveDismissed() {
    try {
      sessionStorage.setItem(_storageKey, JSON.stringify([...dismissed]));
    } catch (_) { }
  }

  dismissed = _loadDismissed();

  // ── Editable detection ────────────────────────────────

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email'].includes(t);
    }
    const ce = el.getAttribute('contenteditable');
    if (ce === 'true' || ce === 'plaintext-only') return true;
    const role = el.getAttribute('role');
    if (role === 'textbox' || role === 'combobox') return true;
    return false;
  }

  function findEditable(el) {
    let cur = el;
    for (let i = 0; i < 25; i++) {
      if (!cur || cur === document.body || cur === document.documentElement) break;
      if (isEditable(cur)) {
        // Found a candidate — but if it only matches via role="textbox" and
        // contains a direct contenteditable child (e.g. ChatGPT ProseMirror
        // wrapper), prefer the inner element to get accurate dimensions.
        const ce = cur.querySelector('[contenteditable="true"],[contenteditable="plaintext-only"]');
        return (ce && cur.contains(ce)) ? ce : cur;
      }
      cur = cur.parentElement || cur.parentNode;
    }
    return null;
  }

  function getDeepActive(root) {
    root = root || document;
    const ae = root.activeElement;
    if (!ae) return null;
    if (ae.shadowRoot) return getDeepActive(ae.shadowRoot) || ae;
    return ae;
  }

  // ── Text helpers ──────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
  }

  /**
   * Set text value in a way that works for:
   *  - Plain <textarea>/<input> elements
   *  - React-controlled inputs (uses nativeInputValueSetter to bypass
   *    React's synthetic event wrapper which intercepts direct .value =)
   *  - contenteditable divs
   */
  function setText(el, text) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // Try React's native setter first (ChatGPT, Claude, etc.)
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, text);
      } else {
        el.value = text;
      }
      // Dispatch events that React's synthetic system listens to
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      // React 16+ also needs this for controlled inputs
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true,
        inputType: 'insertText', data: text,
      }));
    } else {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true,
        inputType: 'insertText', data: text,
      }));
    }
  }

  // ── Float button ──────────────────────────────────────

  function ensureBtn() {
    if (floatBtn) return floatBtn;
    floatBtn = document.createElement('button');
    floatBtn.className = 'dcx-float-btn';
    floatBtn.title = 'Densify — optimize this prompt';
    floatBtn.innerHTML = '<span class="dcx-fi">⚡</span><span class="dcx-fc"></span>';
    floatBtn.addEventListener('mousedown', onBtnClick);
    document.body.appendChild(floatBtn);
    return floatBtn;
  }

  function showBtn(el) {
    if (!el) return;
    const btn = ensureBtn();
    const r = el.getBoundingClientRect();

    // Skip if element isn't painted yet (avoids btn stuck at 0,0)
    if (r.width === 0 && r.height === 0) return;

    // ── Position: bottom-right corner of the element ──────────────
    // Clamp to viewport so the button is always visible.
    // If the natural position is in the bottom 60px (behind ChatGPT send area),
    // flip it to appear ABOVE the element instead.
    const BTN_W = 52, BTN_H = 26, PAD = 8;
    let top  = Math.round(r.top + r.height - BTN_H);
    let left = Math.round(r.left + r.width  - BTN_W);

    const nearBottom = top > window.innerHeight - BTN_H - 60;
    if (nearBottom) {
      // Place just above the element
      top = Math.round(r.top - BTN_H - 6);
    }

    // Final clamp
    top  = Math.max(PAD, Math.min(top,  window.innerHeight - BTN_H - PAD));
    left = Math.max(PAD, Math.min(left, window.innerWidth  - BTN_W - PAD));

    btn.style.top  = top  + 'px';
    btn.style.left = left + 'px';

    // Badge count
    const live = suggestions.filter(s => !dismissed.has(s.id));
    const fc   = btn.querySelector('.dcx-fc');
    fc.textContent   = live.length > 0 ? live.length : '';
    fc.style.display = live.length > 0 ? 'flex' : 'none';
    btn.classList.add('dcx-visible');
  }

  function hideBtn() {
    floatBtn && floatBtn.classList.remove('dcx-visible');
  }

  /** Show a "…" pulse in the badge to signal analysis in progress */
  function setBtnAnalyzing(on) {
    const btn = floatBtn;
    if (!btn) return;
    if (on) {
      btn.classList.add('dcx-analyzing');
      const fc = btn.querySelector('.dcx-fc');
      fc.textContent = '…';
      fc.style.display = 'flex';
    } else {
      btn.classList.remove('dcx-analyzing');
    }
  }

  function onBtnClick(e) {
    e.preventDefault(); e.stopPropagation();
    const live = suggestions.filter(s => !dismissed.has(s.id));
    if (!live.length) return;
    if (popupEl && popupEl.classList.contains('dcx-sp-on')) { closePopup(); return; }
    openPopupFor(live[0], floatBtn.getBoundingClientRect());
  }

  // ── Mirror overlay ────────────────────────────────────

  const COPY_STYLES = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant', 'fontStretch',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textTransform',
    'textIndent', 'wordBreak', 'wordWrap', 'whiteSpace', 'tabSize',
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
    const r = el.getBoundingClientRect();
    for (const p of COPY_STYLES) m.style[p] = cs[p];
    Object.assign(m.style, {
      position: 'fixed', top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px',
      overflow: 'hidden', background: 'transparent', color: 'transparent',
      zIndex: '2147483643', pointerEvents: 'none',
    });
    m.scrollTop = el.scrollTop;
    m.scrollLeft = el.scrollLeft;
  }

  function buildMirrorHTML(text, live) {
    if (!live.length) return escHtml(text);
    const sorted = [...live].sort((a, b) => a.startIndex - b.startIndex);
    let html = '', pos = 0;
    for (const s of sorted) {
      if (s.startIndex < pos) continue;
      html += escHtml(text.slice(pos, s.startIndex));
      html += `<mark class="dcx-hl dcx-hl-${s.type}" data-id="${s.id}">${escHtml(text.slice(s.startIndex, s.endIndex))}</mark>`;
      pos = s.endIndex;
    }
    return html + escHtml(text.slice(pos));
  }

  /**
   * Throttle mirror rebuilds via rAF — avoids multiple synchronous innerHTML
   * writes during rapid typing bursts.
   */
  function refreshMirror() {
    if (mirrorRaf) cancelAnimationFrame(mirrorRaf);
    mirrorRaf = requestAnimationFrame(() => {
      mirrorRaf = null;
      if (!activeEl) return;
      syncMirror(activeEl);
      const m = ensureMirror();
      const text = getText(activeEl);
      const live = suggestions.filter(s => !dismissed.has(s.id));
      m.innerHTML = buildMirrorHTML(text, live);
      m.querySelectorAll('.dcx-hl').forEach(mark => {
        mark.style.pointerEvents = 'auto';
        mark.style.cursor = 'pointer';
        mark.addEventListener('mousedown', e => {
          e.preventDefault(); e.stopPropagation();
          const sug = suggestions.find(s => s.id === mark.dataset.id);
          if (sug) openPopupFor(sug, mark.getBoundingClientRect());
        });
      });
    });
  }

  // ── Popup ─────────────────────────────────────────────

  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.className = 'dcx-suggestion-popup';
    popupEl.innerHTML = `
      <div class="dcx-sp-hd">
        <div class="dcx-sp-ttl"><span class="dcx-sp-ic">⚡</span><span>Densify Suggestion</span></div>
        <button class="dcx-sp-x" id="dcx-sp-x">✕</button>
      </div>
      <div class="dcx-sp-badge" id="dcx-sp-badge"></div>
      <div class="dcx-sp-body" id="dcx-sp-body"></div>
      <div class="dcx-sp-nav" id="dcx-sp-nav"></div>
      <div class="dcx-sp-btns">
        <button class="dcx-sp-accept" id="dcx-sp-ok">Accept</button>
        <button class="dcx-sp-accept-all" id="dcx-sp-all">Accept All</button>
        <button class="dcx-sp-dismiss" id="dcx-sp-no">Dismiss</button>
      </div>`;
    popupEl.querySelector('#dcx-sp-x').addEventListener('click', closePopup);
    popupEl.querySelector('#dcx-sp-ok').addEventListener('click', onAccept);
    popupEl.querySelector('#dcx-sp-all').addEventListener('click', onAcceptAll);
    popupEl.querySelector('#dcx-sp-no').addEventListener('click', onDismiss);
    popupEl.addEventListener('mousedown', e => e.stopPropagation());
    document.body.appendChild(popupEl);
    return popupEl;
  }

  function openPopupFor(sug, anchor) {
    const p = ensurePopup();
    activeSugId = sug.id;
    p.classList.remove('dcx-sp-on');

    const LABELS = {
      phrase: 'Verbose Phrase', filler: 'Filler Word',
      ceremony: 'Prompt Ceremony', redundant: 'Redundant Modifier', structural: 'Structure',
    };
    const badge = p.querySelector('#dcx-sp-badge');
    badge.textContent = LABELS[sug.type] || sug.type;
    badge.className = 'dcx-sp-badge dcx-badge-' + sug.type;

    const rep = sug.replacement === '(remove)'
      ? '<em class="dcx-rem">(remove)</em>'
      : `<span class="dcx-rep">${escHtml(sug.replacement)}</span>`;

    p.querySelector('#dcx-sp-body').innerHTML = `
      <div class="dcx-change">
        <span class="dcx-orig">${escHtml(sug.original)}</span>
        <span class="dcx-arr">→</span>${rep}
      </div>
      <div class="dcx-expl">${escHtml(sug.explanation)}</div>
      ${sug.tokensSaved > 0 ? `<div class="dcx-tok">−${sug.tokensSaved} token${sug.tokensSaved > 1 ? 's' : ''}</div>` : ''}`;

    const live = suggestions.filter(s => !dismissed.has(s.id));
    const idx = live.findIndex(s => s.id === sug.id);
    const nav = p.querySelector('#dcx-sp-nav');

    if (live.length > 1) {
      nav.innerHTML = `
        <button class="dcx-nav-btn" id="dcx-prev" ${idx === 0 ? 'disabled' : ''}>‹</button>
        <span>${idx + 1} / ${live.length}</span>
        <button class="dcx-nav-btn" id="dcx-next" ${idx === live.length - 1 ? 'disabled' : ''}>›</button>`;
      nav.querySelector('#dcx-prev')?.addEventListener('click', () => {
        if (idx > 0) openPopupFor(live[idx - 1], floatBtn.getBoundingClientRect());
      });
      nav.querySelector('#dcx-next')?.addEventListener('click', () => {
        if (idx < live.length - 1) openPopupFor(live[idx + 1], floatBtn.getBoundingClientRect());
      });
      nav.style.display = 'flex';
    } else {
      nav.style.display = 'none';
    }

    // Show "Accept All" only when there are multiple live suggestions
    const allBtn = p.querySelector('#dcx-sp-all');
    allBtn.style.display = live.length > 1 ? '' : 'none';

    // Position fixed, below anchor, clamped to viewport
    const PW = 320;
    let t = anchor.bottom + 10, l = anchor.left;
    if (l + PW > window.innerWidth - 8) l = window.innerWidth - PW - 8;
    if (l < 8) l = 8;
    p.style.top = t + 'px'; p.style.left = l + 'px';

    void p.offsetHeight; // reflow
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
    popupEl && popupEl.classList.remove('dcx-sp-on');
    activeSugId = null;
  }

  function onAccept() {
    if (!activeSugId || !activeEl) return;
    const newText = engine.applySuggestions(getText(activeEl), suggestions, [activeSugId]);
    setText(activeEl, newText);
    closePopup();
    runAnalysis();
  }

  /** Accept every live suggestion in a single pass (applied in reverse-index order). */
  function onAcceptAll() {
    if (!activeEl) return;
    const live = suggestions.filter(s => !dismissed.has(s.id));
    if (!live.length) return;
    const ids = live.map(s => s.id);
    const newText = engine.applySuggestions(getText(activeEl), suggestions, ids);
    setText(activeEl, newText);
    closePopup();
    runAnalysis();
  }

  function onDismiss() {
    if (!activeSugId) return;
    dismissed.add(activeSugId);
    _saveDismissed();
    closePopup();
    suggestions = suggestions.filter(s => !dismissed.has(s.id));
    refreshMirror(); showBtn(activeEl);
    // Show next suggestion popup
    if (suggestions.length > 0) {
      setTimeout(() => openPopupFor(suggestions[0], floatBtn.getBoundingClientRect()), 120);
    }
  }

  // ── Analysis ──────────────────────────────────────────

  function scheduleAnalyze() {
    clearTimeout(debounce);
    debounce = setTimeout(runAnalysis, 350);
  }

  let _analysisId = 0;
  async function runAnalysis() {
    if (!activeEl) return;
    const text = getText(activeEl);
    if (text.trim().length < 3) {
      suggestions = [];
      setBtnAnalyzing(false);
      refreshMirror(); showBtn(activeEl);
      return;
    }

    const seqId = ++_analysisId;
    setBtnAnalyzing(true);

    try {
      let result;
      if (bridge) {
        result = await bridge.analyze(text, { model: 'gpt-4o' });
      } else {
        result = { suggestions: engine.getSuggestions(text) };
      }

      // Discard superseded responses
      if (!result || result._superseded) return;
      // Discard if a newer local analysis was started
      if (seqId !== _analysisId) return;

      setBtnAnalyzing(false);

      suggestions = result.suggestions.filter(s => !dismissed.has(s.id));

      // Map structural diagnostics to suggestion format
      if (result.structural && result.structural.length > 0) {
        for (const st of result.structural) {
          suggestions.push({
            id: 'struct_' + Math.random().toString(36).substr(2, 9),
            type: 'structural',
            original: st.sentence2,
            replacement: '(remove)',
            explanation: st.suggestion,
            tokensSaved: st.tokensSaved,
            confidence: st.similarity,
            severity: 'high',
          });
        }
      }

      refreshMirror();
      showBtn(activeEl);
    } catch (e) {
      setBtnAnalyzing(false);
      console.warn('[Densify] Analysis failed:', e);
    }
  }

  // ── Activate an element ───────────────────────────────

  function _attachResizeObserver(el) {
    if (resizeObs) resizeObs.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    resizeObs = new ResizeObserver(() => {
      if (activeEl) { syncMirror(activeEl); showBtn(activeEl); }
    });
    resizeObs.observe(el);
  }

  function activateEl(el) {
    if (!el || el === activeEl) return;

    if (activeEl) {
      activeEl.removeEventListener('input', onElInput);
      activeEl.removeEventListener('keyup', onElInput);
      activeEl.removeEventListener('scroll', onElScroll);
    }

    activeEl = el;
    dismissed = _loadDismissed(); // re-read persisted dismissals for this host
    suggestions = [];

    el.addEventListener('input', onElInput, { passive: true });
    el.addEventListener('keyup', onElInput, { passive: true });
    el.addEventListener('scroll', onElScroll, { passive: true });

    _attachResizeObserver(el);

    showBtn(el);
    scheduleAnalyze();
  }

  function onElInput() { syncMirror(activeEl); showBtn(activeEl); scheduleAnalyze(); }
  function onElScroll() { if (activeEl && mirrorEl) syncMirror(activeEl); showBtn(activeEl); }

  // ── Multi-strategy focus detection ────────────────────

  document.addEventListener('focusin', e => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const target = path[0] || e.target;
    const el = findEditable(target);
    if (el) activateEl(el);
  }, true);

  document.addEventListener('click', e => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const target = path[0] || e.target;
    const el = findEditable(target);
    if (el && el !== activeEl) activateEl(el);
  }, true);

  // Strategy 3: poll document.activeElement (catches shadow-DOM apps like Copilot)
  // Paused automatically when tab is not visible to save CPU.
  let _pollInterval = null;

  function _startPoll() {
    if (_pollInterval) return;
    _pollInterval = setInterval(() => {
      const deep = getDeepActive(document);
      if (!deep) return;
      const el = findEditable(deep);
      if (el && el !== activeEl) activateEl(el);
    }, 500);
  }

  function _stopPoll() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  }

  _startPoll();

  // Pause polling when tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      _stopPoll();
    } else {
      _startPoll();
      // Re-run analysis after returning to tab
      if (activeEl) scheduleAnalyze();
    }
  });

  // ── Focus out ─────────────────────────────────────────

  document.addEventListener('focusout', e => {
    setTimeout(() => {
      const deep = getDeepActive(document);
      const focused = deep || document.activeElement;
      if (!focused) { hideBtn(); closePopup(); return; }
      if (floatBtn?.contains(focused) || popupEl?.contains(focused)) return;
      const ne = findEditable(focused);
      if (ne) return;
      hideBtn(); closePopup();
      if (mirrorEl) mirrorEl.innerHTML = '';
    }, 200);
  }, true);

  // ── Proactive DOM scanning ─────────────────────────────

  function attachDirectListeners(root) {
    const selector = 'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
    root.querySelectorAll(selector).forEach(el => {
      if (attached.has(el)) return;
      attached.add(el);
      el.addEventListener('focus', () => activateEl(el));
      el.addEventListener('click', () => activateEl(el));
    });
  }

  attachDirectListeners(document);

  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        attachDirectListeners(node);
        if (node.shadowRoot) attachDirectListeners(node.shadowRoot);
      }
    }
    if (activeEl && !document.contains(activeEl)) {
      activeEl = null;
      if (resizeObs) resizeObs.disconnect();
      if (mirrorEl) mirrorEl.innerHTML = '';
      hideBtn(); closePopup();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ── Reposition on scroll / resize ─────────────────────

  let rafId = null;
  function reposition() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      if (activeEl) { if (mirrorEl) syncMirror(activeEl); showBtn(activeEl); }
    });
  }
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  // ── Close popup on outside click / Escape ─────────────

  document.addEventListener('mousedown', e => {
    if (!popupEl) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (popupEl.contains(path[0])) return;
    if (floatBtn?.contains(path[0])) return;
    closePopup();
  }, true);

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

  // ── Chrome extension message bridge ───────────────────

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'DENSIFY_GET_TEXT') {
      reply({ text: activeEl ? getText(activeEl) : '' }); return true;
    }
    if (msg.type === 'DENSIFY_REPLACE' && activeEl && msg.text) {
      setText(activeEl, msg.text); runAnalysis(); reply({ success: true }); return true;
    }
    if (msg.type === 'DENSIFY_OPTIMIZE_SELECTION' && msg.text) {
      if (activeEl) {
        const result = engine.optimizePrompt(msg.text);
        if (result && result.optimized) {
          setText(activeEl, result.optimized);
          runAnalysis();
          reply({ success: true, tokensSaved: result.savings?.saved || 0 });
        } else {
          reply({ success: false, reason: 'Optimization returned no result' });
        }
      } else {
        reply({ success: false, reason: 'No active editable element' });
      }
      return true;
    }
    if (msg.type === 'DENSIFY_PING') {
      reply({ alive: true, suggestions: suggestions.length }); return true;
    }
  });

  console.log('[Densify] ✓ v5 — React-safe setText + Accept All + visibility-aware polling');
})();
