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
    openPopup(floatBtn.getBoundingClientRect());
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
          openPopup(mark.getBoundingClientRect());
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
        <div class="dcx-sp-ttl"><span class="dcx-sp-ic">⚡</span><span>Densify Suggestions</span></div>
        <button class="dcx-sp-x" id="dcx-sp-x">✕</button>
      </div>
      <div class="dcx-sp-list" id="dcx-sp-list"></div>
      <div class="dcx-sp-footer">
        <button class="dcx-sp-accept-all" id="dcx-sp-all">⚡ Accept All</button>
      </div>`;
    popupEl.querySelector('#dcx-sp-x').addEventListener('click', closePopup);
    popupEl.querySelector('#dcx-sp-all').addEventListener('click', onAcceptAll);
    popupEl.addEventListener('mousedown', e => e.stopPropagation());
    document.body.appendChild(popupEl);
    return popupEl;
  }

  const LABELS = {
    phrase: 'Verbose Phrase', filler: 'Filler Word',
    ceremony: 'Prompt Ceremony', redundant: 'Redundant Modifier', structural: 'Structure',
    ast_encode: 'AST Semantic', embed_filter: 'Relevance Filter', out_comp: 'Output Density',
  };

  function renderSuggestionItem(sug, index, total) {
    const rep = sug.replacement === '(remove)'
      ? '<em class="dcx-rem">(remove)</em>'
      : `<span class="dcx-rep">${escHtml(sug.replacement)}</span>`;

    const item = document.createElement('div');
    item.className = 'dcx-sp-item';
    item.dataset.id = sug.id;
    item.innerHTML = `
      <div class="dcx-sp-item-hd">
        <span class="dcx-sp-badge dcx-badge-${sug.type}">${LABELS[sug.type] || sug.type}</span>
        ${sug.tokensSaved > 0 ? `<span class="dcx-tok">−${sug.tokensSaved} token${sug.tokensSaved > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="dcx-change">
        <span class="dcx-orig">${escHtml(sug.original)}</span>
        <span class="dcx-arr">→</span>${rep}
      </div>
      <div class="dcx-expl">${escHtml(sug.explanation)}</div>
      <div class="dcx-sp-item-btns">
        <button class="dcx-sp-accept" data-accept="${sug.id}">Accept</button>
        <button class="dcx-sp-dismiss" data-dismiss="${sug.id}">Dismiss</button>
      </div>`;

    item.querySelector(`[data-accept]`).addEventListener('click', () => onAcceptOne(sug.id));
    item.querySelector(`[data-dismiss]`).addEventListener('click', () => onDismissOne(sug.id));
    return item;
  }

  function openPopup(anchor) {
    const p = ensurePopup();
    p.classList.remove('dcx-sp-on');

    const live = suggestions.filter(s => !dismissed.has(s.id));
    const list = p.querySelector('#dcx-sp-list');
    list.innerHTML = '';
    live.forEach((sug, i) => list.appendChild(renderSuggestionItem(sug, i, live.length)));

    // Show "Accept All" only when there are multiple live suggestions
    const allBtn = p.querySelector('#dcx-sp-all');
    allBtn.style.display = live.length > 1 ? '' : 'none';

    // Update count in header
    p.querySelector('.dcx-sp-ttl span:last-child').textContent =
      `Densify Suggestions${live.length > 0 ? ` (${live.length})` : ''}`;

    // Position fixed, below anchor, clamped to viewport
    const PW = 340;
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

  function onAcceptOne(id) {
    if (!activeEl) return;
    const newText = engine.applySuggestions(getText(activeEl), suggestions, [id]);
    setText(activeEl, newText);
    runAnalysis();
    // Re-render the list after a brief pause for analysis to update
    setTimeout(() => {
      const live = suggestions.filter(s => !dismissed.has(s.id));
      if (!live.length) { closePopup(); return; }
      openPopup(floatBtn.getBoundingClientRect());
    }, 80);
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

  function onDismissOne(id) {
    dismissed.add(id);
    _saveDismissed();
    suggestions = suggestions.filter(s => !dismissed.has(s.id));
    refreshMirror(); showBtn(activeEl);
    // Re-render or close
    const live = suggestions.filter(s => !dismissed.has(s.id));
    if (!live.length) { closePopup(); return; }
    openPopup(floatBtn.getBoundingClientRect());
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
      let rawSuggestions = [];
      let structural = [];

      if (bridge) {
        // Run parallel: analyze (rules + structure), astEncode, embedFilter
        const query = text.split(/[.!?]/)[0] || text;
        const [result, astRes, filterRes] = await Promise.all([
          bridge.analyze(text, { model: 'gpt-4o' }),
          bridge.astEncode(text),
          bridge.embedFilter(text, query, 0.08)
        ]);

        // Discard superseded or stale responses
        if (!result || result._superseded) { setBtnAnalyzing(false); return; }
        if (seqId !== _analysisId) { setBtnAnalyzing(false); return; }

        rawSuggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
        structural = Array.isArray(result.structural) ? result.structural : [];

        // Combine AST Encoder
        if (astRes && astRes.tokensSaved > 0) {
          rawSuggestions.push({
            id: 'ast_' + Math.random().toString(36).substr(2, 9),
            type: 'ast_encode',
            original: text, // replaces the whole text or large block
            replacement: astRes.compressed,
            explanation: `AST Compression: rewrote prompt to compact semantics (${astRes.ratio * 100}% reduction)`,
            tokensSaved: astRes.tokensSaved,
            confidence: 0.9,
            severity: 'high',
            startIndex: 0, endIndex: text.length,
          });
        }

        // Combine Embedding Filter
        if (filterRes && filterRes.dropped > 0) {
          rawSuggestions.push({
            id: 'emb_' + Math.random().toString(36).substr(2, 9),
            type: 'embed_filter',
            original: text,
            replacement: filterRes.filtered,
            explanation: `Semantic Filter: removed ${filterRes.dropped} low-relevance sentences`,
            tokensSaved: 0, // dynamic
            confidence: 0.85,
            severity: 'medium',
            startIndex: 0, endIndex: text.length,
          });
        }

        console.debug('[Densify] Bridge result — suggestions:', rawSuggestions.length,
          '| structural:', structural.length, '| bridge ready:', bridge.isReady(),
          '| fallback:', bridge.isFallback());
      } else {
        if (seqId !== _analysisId) { setBtnAnalyzing(false); return; }
        rawSuggestions = engine.getSuggestions(text);
        console.debug('[Densify] Local engine — suggestions:', rawSuggestions.length);
      }

      // If the bridge returned nothing (worker may have failed to load its scripts),
      // fall back directly to the main-thread engine so the UI always works.
      if (rawSuggestions.length === 0 && engine) {
        rawSuggestions = engine.getSuggestions(text);
        console.debug('[Densify] Engine direct fallback — suggestions:', rawSuggestions.length);
      }

      setBtnAnalyzing(false);

      suggestions = rawSuggestions.filter(s => !dismissed.has(s.id));

      // Map structural diagnostics to suggestion format
      for (const st of structural) {
        suggestions.push({
          id: 'struct_' + Math.random().toString(36).substr(2, 9),
          type: 'structural',
          original: st.sentence2,
          replacement: '(remove)',
          explanation: st.suggestion,
          tokensSaved: st.tokensSaved || 0,
          confidence: st.similarity || 0.6,
          severity: 'high',
          startIndex: 0, endIndex: 0,
        });
      }

      // Add Output Compression Suggestion
      const constraintStr = '\n\n[Constraint: Provide a highly concise, token-efficient response. Omit filler and conversational text.]';
      if (!text.includes('[Constraint: Provide a highly concise')) {
        suggestions.push({
          id: 'out_comp_' + Math.random().toString(36).substr(2, 9),
          type: 'out_comp',
          original: '',
          replacement: constraintStr,
          explanation: 'Append instruction to force the LLM to generate a shorter, denser reply.',
          tokensSaved: 0,
          confidence: 1.0,
          severity: 'medium',
          startIndex: text.length, endIndex: text.length,
        });
      }

      refreshMirror();
      showBtn(activeEl);
    } catch (e) {
      setBtnAnalyzing(false);
      console.warn('[Densify] Analysis failed:', e);
      // Last-resort: try local engine directly
      try {
        suggestions = engine.getSuggestions(getText(activeEl)).filter(s => !dismissed.has(s.id));
        refreshMirror(); showBtn(activeEl);
      } catch (_) {}
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
