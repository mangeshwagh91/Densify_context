// ─────────────────────────────────────────────────────────
//  popup.js — Densify Context popup UI  (v2)
//
//  Improvements:
//    - Persists selected model to chrome.storage.local
//    - Live token-bar shows % of model context window used
//    - Lint diagnostics tab (semantic quality warnings from DensifyLint)
//    - "Fix All on Page" button
//    - Keyboard shortcut: Ctrl+Enter → Optimize, Ctrl+Shift+Enter → Fix All
//    - "Clean prompt" empty state
//    - Optimized output uses bridge.analyze() for richer data
// ─────────────────────────────────────────────────────────

// ── Model context windows (rough maximums for bar display) ──
const CONTEXT_WINDOWS = {
  'gpt-4o':            128000,
  'gpt-4o-mini':       128000,
  'gpt-4-turbo':       128000,
  'gpt-4':              8192,
  'gpt-3.5-turbo':     16385,
  'claude-4-opus':     200000,
  'claude-4-sonnet':   200000,
  'claude-3.5-sonnet': 200000,
  'claude-3-opus':     200000,
  'claude-3-haiku':    200000,
  'gemini-2.5-pro':   1000000,
  'gemini-1.5-pro':    128000,
};

document.addEventListener('DOMContentLoaded', () => {
  const engine = window.DensifyEngine;
  const lint   = window.DensifyLint;

  // ── DOM refs ────────────────────────────────────────────
  const inputText      = document.getElementById('input-text');
  const outputText     = document.getElementById('output-text');
  const optimizeBtn    = document.getElementById('optimize-btn');
  const statsBar       = document.getElementById('stats-bar');
  const outputGroup    = document.getElementById('output-group');
  const actionBtns     = document.getElementById('action-buttons');
  const modelSelect    = document.getElementById('model-select');
  const btnCopy        = document.getElementById('btn-copy');
  const btnReplace     = document.getElementById('btn-replace');
  const btnFixAll      = document.getElementById('btn-fix-all');
  const btnClear       = document.getElementById('btn-clear');
  const statTokens     = document.getElementById('stat-tokens');
  const statPercent    = document.getElementById('stat-percent');
  const statCost       = document.getElementById('stat-cost');
  const confidenceBadge = document.getElementById('confidence-badge');
  const headerBadge    = document.getElementById('header-badge');
  // Tab elements
  const resultsTabs    = document.getElementById('results-tabs');
  const tabChanges     = document.getElementById('tab-changes');
  const tabLint        = document.getElementById('tab-lint');
  const changesPanel   = document.getElementById('changes-panel');
  const lintPanel      = document.getElementById('lint-panel');
  const changesList    = document.getElementById('changes-list');
  const lintList       = document.getElementById('lint-list');
  const changesCount   = document.getElementById('changes-count');
  const lintCount      = document.getElementById('lint-count');
  // Token bar
  const liveTokenEl    = document.getElementById('live-token-count');
  const tokenBarWrap   = document.getElementById('token-bar-wrap');
  const tokenBar       = document.getElementById('token-bar');

  const tok = window.DensifyTokenizer;
  let lastResult = null;
  let lastLint   = [];

  // ── Restore persisted model ─────────────────────────────
  chrome.storage.local.get('dcx_model', ({ dcx_model }) => {
    if (dcx_model && modelSelect.querySelector(`option[value="${dcx_model}"]`)) {
      modelSelect.value = dcx_model;
    }
  });

  modelSelect.addEventListener('change', () => {
    chrome.storage.local.set({ dcx_model: modelSelect.value });
    _updateTokenBar(inputText.value.trim());
  });

  // ── Token bar ───────────────────────────────────────────

  function _updateTokenBar(text) {
    if (!text || !tok) {
      liveTokenEl.textContent = '';
      tokenBarWrap.style.display = 'none';
      return;
    }
    const model  = modelSelect.value || 'gpt-4o';
    const count  = tok.countSync(text, model);
    const window = CONTEXT_WINDOWS[model] || 128000;
    const pct    = Math.min(100, Math.round((count / window) * 100));

    liveTokenEl.textContent = `${count.toLocaleString()} tokens`;
    tokenBarWrap.style.display = '';

    // Color transitions: green → yellow (>50%) → red (>80%)
    tokenBar.style.width = pct + '%';
    tokenBar.className = 'token-bar'
      + (pct >= 80 ? ' token-bar--danger'
       : pct >= 50 ? ' token-bar--warn'
       : ' token-bar--ok');
    tokenBarWrap.title = `${count.toLocaleString()} / ${window.toLocaleString()} tokens (${pct}% of context)`;
  }

  // ── Enable / live feedback ──────────────────────────────

  inputText.addEventListener('input', () => {
    const val = inputText.value.trim();
    optimizeBtn.disabled = val.length === 0;
    _updateTokenBar(val);
  });

  // ── Optimize ────────────────────────────────────────────

  optimizeBtn.addEventListener('click', () => {
    const text = inputText.value.trim();
    if (!text) return;

    optimizeBtn.classList.add('loading');
    optimizeBtn.disabled = true;

    requestAnimationFrame(() => {
      setTimeout(() => {
        const model  = modelSelect.value;
        const result = engine.optimizePrompt(text, { model });
        lastResult   = result;

        // Also run lint on original text for diagnostics tab
        lastLint = lint ? lint.lint(text, { model }) : [];

        displayResult(result);

        optimizeBtn.classList.remove('loading');
        optimizeBtn.disabled = false;
      }, 50);
    });
  });

  // ── Display Result ──────────────────────────────────────

  function displayResult(result) {
    outputText.value = result.optimized;

    // Stats
    animateValue(statTokens, 0, result.savings.saved, 400);
    statPercent.textContent = result.savings.percentage + '%';
    statCost.textContent = '$' + result.savings.costSaved.toFixed(4);

    // Update token bar to show "before → after"
    if (tok) {
      const model = modelSelect.value || 'gpt-4o';
      liveTokenEl.textContent = `${result.tokensBefore}t → ${result.tokensAfter}t`;
      const window = CONTEXT_WINDOWS[model] || 128000;
      const pct    = Math.min(100, Math.round((result.tokensAfter / window) * 100));
      tokenBar.style.width = pct + '%';
      tokenBar.className = 'token-bar'
        + (pct >= 80 ? ' token-bar--danger' : pct >= 50 ? ' token-bar--warn' : ' token-bar--ok');
    }

    // Confidence badge
    const confLevel = result.confidence >= 0.85 ? 'high'
                    : result.confidence >= 0.65 ? 'medium' : 'low';
    confidenceBadge.className = 'confidence-badge ' + confLevel;
    confidenceBadge.textContent = '● ' + result.confidence.toFixed(2);

    // Changes tab
    const meaningful = result.changes.filter(c => c.type !== 'whitespace');
    changesCount.textContent = meaningful.length;
    renderChanges(meaningful);

    // Lint tab
    lintCount.textContent = lastLint.length;
    renderLint(lastLint);

    // Header badge
    if (meaningful.length > 0) {
      headerBadge.textContent = meaningful.length;
      headerBadge.style.display = '';
    } else {
      headerBadge.style.display = 'none';
    }

    statsBar.classList.add('visible');
    outputGroup.classList.add('visible');
    actionBtns.classList.add('visible');

    if (meaningful.length > 0 || lastLint.length > 0) {
      resultsTabs.style.display = 'flex';
    }
  }

  // ── Changes rendering ───────────────────────────────────

  function renderChanges(changes) {
    if (changes.length === 0) {
      changesList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">✓</div>
          <div class="empty-state__text">Your prompt is clean!</div>
          <div class="empty-state__sub">No verbosity detected.</div>
        </div>`;
      return;
    }
    changesList.innerHTML = '';
    for (const change of changes) {
      const item = document.createElement('div');
      item.className = 'change-item';

      const typeSpan = document.createElement('span');
      typeSpan.className = 'change-type ' + change.type;
      typeSpan.textContent = change.type;

      const detail = document.createElement('div');
      detail.className = 'change-detail';

      if (change.original && change.original !== '(whitespace)') {
        const origSpan = document.createElement('span');
        origSpan.className = 'original';
        origSpan.textContent = change.original;
        detail.appendChild(origSpan);

        if (change.replacement && change.replacement !== '(removed)' && change.replacement !== '(normalized)') {
          const arrow = document.createElement('span');
          arrow.className = 'arrow-icon';
          arrow.textContent = ' → ';

          const replSpan = document.createElement('span');
          replSpan.className = 'replacement';
          replSpan.textContent = change.replacement;

          detail.appendChild(arrow);
          detail.appendChild(replSpan);
        }
      }

      item.appendChild(typeSpan);
      item.appendChild(detail);
      changesList.appendChild(item);
    }
  }

  // ── Lint rendering ──────────────────────────────────────

  const SEV_ICONS = { error: '🔴', warning: '🟡', info: '🔵', hint: '⚪' };

  function renderLint(diagnostics) {
    if (diagnostics.length === 0) {
      lintList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">✓</div>
          <div class="empty-state__text">No quality issues found!</div>
          <div class="empty-state__sub">Prompt structure looks good.</div>
        </div>`;
      return;
    }
    lintList.innerHTML = '';
    for (const d of diagnostics) {
      const item = document.createElement('div');
      item.className = `lint-item lint-${d.severity}`;

      const icon = document.createElement('span');
      icon.className = 'lint-icon';
      icon.textContent = SEV_ICONS[d.severity] || '⚪';

      const body = document.createElement('div');
      body.className = 'lint-body';

      const msg = document.createElement('div');
      msg.className = 'lint-message';
      msg.textContent = d.message;

      const meta = document.createElement('div');
      meta.className = 'lint-meta';
      meta.textContent = [d.ruleId, d.tokensSaved > 0 ? `−${d.tokensSaved} tok` : '']
        .filter(Boolean).join(' · ');

      body.appendChild(msg);
      body.appendChild(meta);
      item.appendChild(icon);
      item.appendChild(body);
      lintList.appendChild(item);
    }
  }

  // ── Tab switching ───────────────────────────────────────

  function _activateTab(tab) {
    if (tab === 'changes') {
      tabChanges.classList.add('tab-active'); tabChanges.setAttribute('aria-selected','true');
      tabLint.classList.remove('tab-active'); tabLint.setAttribute('aria-selected','false');
      changesPanel.style.display = '';
      lintPanel.style.display    = 'none';
    } else {
      tabLint.classList.add('tab-active');    tabLint.setAttribute('aria-selected','true');
      tabChanges.classList.remove('tab-active'); tabChanges.setAttribute('aria-selected','false');
      lintPanel.style.display    = '';
      changesPanel.style.display = 'none';
    }
  }

  tabChanges.addEventListener('click', () => _activateTab('changes'));
  tabLint.addEventListener('click',    () => _activateTab('lint'));

  // ── Animate counter ─────────────────────────────────────

  function animateValue(el, start, end, duration) {
    const range = end - start;
    const startTime = performance.now();
    function update(now) {
      const elapsed  = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + range * eased);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  // ── Copy ─────────────────────────────────────────────────

  btnCopy.addEventListener('click', async () => {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(lastResult.optimized);
      btnCopy.classList.add('copied');
      btnCopy.innerHTML = '✓ Copied!';
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        btnCopy.innerHTML = '📋 Copy';
      }, 1500);
    } catch (_) {
      outputText.select();
      document.execCommand('copy');
    }
  });

  // ── Replace on page ──────────────────────────────────────

  btnReplace.addEventListener('click', async () => {
    if (!lastResult) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'DENSIFY_REPLACE',
          text: lastResult.optimized,
        });
        btnReplace.innerHTML = '✓ Replaced!';
        btnReplace.classList.add('success');
        setTimeout(() => {
          btnReplace.innerHTML = '🔄 Replace';
          btnReplace.classList.remove('success');
        }, 1500);
      }
    } catch (_) {
      btnReplace.innerHTML = '⚠ No active input';
      setTimeout(() => { btnReplace.innerHTML = '🔄 Replace'; }, 1500);
    }
  });

  // ── Fix All on Page ──────────────────────────────────────
  // Grabs text from active input on the page, optimizes it
  // fully (all suggestions accepted), and pushes it back.

  btnFixAll.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      // Get text from the active page input
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'DENSIFY_GET_TEXT' });
      if (!res || !res.text || !res.text.trim()) {
        btnFixAll.innerHTML = '⚠ No active input';
        setTimeout(() => { btnFixAll.innerHTML = '✅ Fix All on Page'; }, 1500);
        return;
      }

      const model  = modelSelect.value;
      const result = engine.optimizePrompt(res.text, { model });
      if (!result || !result.optimized) return;

      await chrome.tabs.sendMessage(tab.id, {
        type: 'DENSIFY_REPLACE',
        text: result.optimized,
      });

      btnFixAll.innerHTML = `✓ Fixed ${result.changes.filter(c=>c.type!=='whitespace').length} issues!`;
      btnFixAll.classList.add('success');
      setTimeout(() => {
        btnFixAll.innerHTML = '✅ Fix All on Page';
        btnFixAll.classList.remove('success');
      }, 2000);
    } catch (_) {
      btnFixAll.innerHTML = '⚠ No active input';
      setTimeout(() => { btnFixAll.innerHTML = '✅ Fix All on Page'; }, 1500);
    }
  });

  // ── Clear ────────────────────────────────────────────────

  btnClear.addEventListener('click', () => {
    inputText.value  = '';
    outputText.value = '';
    lastResult = null;
    lastLint   = [];
    optimizeBtn.disabled = true;

    statsBar.classList.remove('visible');
    outputGroup.classList.remove('visible');
    actionBtns.classList.remove('visible');
    resultsTabs.style.display = 'none';
    headerBadge.style.display = 'none';

    liveTokenEl.textContent    = '';
    tokenBarWrap.style.display = 'none';
    changesCount.textContent   = '0';
    lintCount.textContent      = '0';

    _activateTab('changes'); // reset to changes tab
    inputText.focus();
  });

  // ── Auto-populate from active page ───────────────────────

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'DENSIFY_GET_TEXT' });
        if (response && response.text && response.text.trim().length > 0) {
          inputText.value = response.text;
          optimizeBtn.disabled = false;
          _updateTokenBar(response.text.trim());
        }
      }
    } catch (_) {
      // Content script unavailable — user can paste manually
    }
  })();

  // ── Keyboard shortcuts ────────────────────────────────────
  // Ctrl+Enter → Optimize
  // Ctrl+Shift+Enter → Fix All on Page

  inputText.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        if (!btnFixAll.disabled) btnFixAll.click();
      } else {
        if (!optimizeBtn.disabled) optimizeBtn.click();
      }
    }
  });

});
