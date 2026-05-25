// ─────────────────────────────────────────────────────────
//  popup.js — Popup UI logic for Densify Context
// ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const engine = window.DensifyEngine;

  // ── DOM References ──────────────────────────────────
  const inputText    = document.getElementById('input-text');
  const outputText   = document.getElementById('output-text');
  const optimizeBtn  = document.getElementById('optimize-btn');
  const statsBar     = document.getElementById('stats-bar');
  const outputGroup  = document.getElementById('output-group');
  const actionBtns   = document.getElementById('action-buttons');
  const changesSection = document.getElementById('changes-section');
  const changesToggle  = document.getElementById('changes-toggle');
  const changesList    = document.getElementById('changes-list');
  const changesCount   = document.getElementById('changes-count');
  const modelSelect    = document.getElementById('model-select');
  const btnCopy        = document.getElementById('btn-copy');
  const btnReplace     = document.getElementById('btn-replace');
  const btnClear       = document.getElementById('btn-clear');
  const statTokens     = document.getElementById('stat-tokens');
  const statPercent    = document.getElementById('stat-percent');
  const statCost       = document.getElementById('stat-cost');
  const confidenceBadge = document.getElementById('confidence-badge');

  let lastResult = null;

  // ── Enable button when input has text ───────────────
  inputText.addEventListener('input', () => {
    optimizeBtn.disabled = inputText.value.trim().length === 0;
  });

  // ── Optimize ────────────────────────────────────────
  optimizeBtn.addEventListener('click', () => {
    const text = inputText.value.trim();
    if (!text) return;

    optimizeBtn.classList.add('loading');
    optimizeBtn.disabled = true;

    // Use requestAnimationFrame to let the UI update (show spinner)
    requestAnimationFrame(() => {
      setTimeout(() => {
        const model = modelSelect.value;
        const result = engine.optimizePrompt(text, { model });
        lastResult = result;

        displayResult(result);

        optimizeBtn.classList.remove('loading');
        optimizeBtn.disabled = false;
      }, 50); // tiny delay for visual feedback
    });
  });

  // ── Display Result ──────────────────────────────────
  function displayResult(result) {
    // Output text
    outputText.value = result.optimized;

    // Stats
    animateValue(statTokens, 0, result.savings.saved, 400);
    statPercent.textContent = result.savings.percentage + '%';
    statCost.textContent = '$' + result.savings.costSaved.toFixed(4);

    // Confidence badge
    const confLevel = result.confidence >= 0.85 ? 'high'
                    : result.confidence >= 0.65 ? 'medium' : 'low';
    confidenceBadge.className = 'confidence-badge ' + confLevel;
    confidenceBadge.textContent = '● ' + result.confidence.toFixed(2);

    // Changes
    const meaningful = result.changes.filter(c => c.type !== 'whitespace');
    changesCount.textContent = meaningful.length;
    renderChanges(meaningful);

    // Show sections
    statsBar.classList.add('visible');
    outputGroup.classList.add('visible');
    actionBtns.classList.add('visible');
    if (meaningful.length > 0) {
      changesSection.classList.add('visible');
    }
  }

  // ── Animate counter ─────────────────────────────────
  function animateValue(el, start, end, duration) {
    const range = end - start;
    const startTime = performance.now();

    function update(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out expo
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + range * eased);
      if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
  }

  // ── Render changes list ─────────────────────────────
  function renderChanges(changes) {
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

  // ── Changes toggle ──────────────────────────────────
  changesToggle.addEventListener('click', () => {
    changesToggle.classList.toggle('open');
    changesList.classList.toggle('open');
  });

  // ── Copy ────────────────────────────────────────────
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
    } catch (err) {
      // Fallback
      outputText.select();
      document.execCommand('copy');
    }
  });

  // ── Replace on page ─────────────────────────────────
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
          btnReplace.innerHTML = '🔄 Replace on Page';
          btnReplace.classList.remove('success');
        }, 1500);
      }
    } catch (err) {
      btnReplace.innerHTML = '⚠ No active input';
      setTimeout(() => {
        btnReplace.innerHTML = '🔄 Replace on Page';
      }, 1500);
    }
  });

  // ── Clear ───────────────────────────────────────────
  btnClear.addEventListener('click', () => {
    inputText.value = '';
    outputText.value = '';
    lastResult = null;
    optimizeBtn.disabled = true;

    statsBar.classList.remove('visible');
    outputGroup.classList.remove('visible');
    actionBtns.classList.remove('visible');
    changesSection.classList.remove('visible');
    changesList.classList.remove('open');
    changesToggle.classList.remove('open');

    inputText.focus();
  });

  // ── Try to grab text from active page on open ──────
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'DENSIFY_GET_TEXT' });
        if (response && response.text && response.text.trim().length > 0) {
          inputText.value = response.text;
          optimizeBtn.disabled = false;
        }
      }
    } catch (e) {
      // Content script not available — user can paste manually
    }
  })();

  // Keyboard shortcut: Ctrl+Enter to optimize
  inputText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!optimizeBtn.disabled) optimizeBtn.click();
    }
  });
});
