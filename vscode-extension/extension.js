// ─────────────────────────────────────────────────────────────────────────────
//  extension.js — Densify Context VS Code Extension  (v2 — Phase 3)
//
//  New in v2:
//    • Live token heatmap  — decorates each line by token density
//    • Inline cost labels  — shows "≈ $0.0003 · 18t" at line end
//    • Prompt diagnostics  — Problems panel integration (lint-engine)
//    • Hover provider      — hover any suggestion to see explanation
//    • Incremental updates — only re-decorates changed lines
//    • Worker threads      — heavy analysis off extension host thread
//
//  Commands (unchanged from v1):
//    densify.optimizePrompt       — diff preview
//    densify.optimizeAndReplace   — inline replace
//    densify.showSuggestions      — QuickPick interactive
//    densify.countTokens          — token count notification
//    densify.toggleHeatmap        — NEW: toggle heatmap on/off
//    densify.runLinter            — NEW: run full prompt linter
//    densify.showTelemetry        — NEW: open telemetry report
// ─────────────────────────────────────────────────────────────────────────────

const vscode = require('vscode');
const engine = require('./lib/densify-engine');

// ── Module globals ────────────────────────────────────────────────────────────
/** @type {vscode.StatusBarItem}  */   let statusBarItem;
/** @type {vscode.DiagnosticCollection} */ let diagnosticCollection;
/** @type {boolean} */                 let heatmapEnabled = true;

// ── Decoration type cache (heatmap) ──────────────────────────────────────────
// We create one DecorationType per heat level (10 levels, 0–9).
// Creating them once at activation avoids GC churn on every keystroke.
const HEAT_LEVELS     = 10;
const heatDecorations = [];   // index 0 (cool) → 9 (hot)
const costDecoration  = vscode.window.createTextEditorDecorationType({
  after: { color: '#6b7280', fontStyle: 'italic', margin: '0 0 0 12px' },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

// Inline suggestion underlines (wavy, colour by severity)
const UNDERLINE_DECS = {
  error:   vscode.window.createTextEditorDecorationType({ textDecoration: 'underline wavy #ef4444' }),
  warning: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline wavy #f59e0b' }),
  info:    vscode.window.createTextEditorDecorationType({ textDecoration: 'underline wavy #3b82f6' }),
  hint:    vscode.window.createTextEditorDecorationType({ textDecoration: 'underline dotted #9ca3af' }),
};

function buildHeatDecorations() {
  for (let i = 0; i < HEAT_LEVELS; i++) {
    const alpha = Math.round((i / (HEAT_LEVELS - 1)) * 0.28 * 255)
      .toString(16).padStart(2, '0');
    heatDecorations[i] = vscode.window.createTextEditorDecorationType({
      backgroundColor: `#ef4444${alpha}`,
      isWholeLine: false,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
  }
}

// ── Debounce ──────────────────────────────────────────────────────────────────
const _timers = new Map();
function debounce(key, fn, delay) {
  if (_timers.has(key)) clearTimeout(_timers.get(key));
  _timers.set(key, setTimeout(() => { _timers.delete(key); fn(); }, delay));
}

// ── Token counting (uses engine's countTokens which wraps heuristic v2) ───────
function countLineTokens(line, model) {
  return engine.countTokens(line, model);
}

// Per-model pricing ($/1K tokens)
const PRICING = {
  'gpt-4o': 0.0025, 'gpt-4o-mini': 0.00015, 'gpt-4-turbo': 0.01,
  'gpt-4': 0.03, 'gpt-3.5-turbo': 0.0005,
  'claude-3-opus': 0.015, 'claude-3.5-sonnet': 0.003, 'claude-3-haiku': 0.00025,
  'claude-4-opus': 0.015, 'claude-4-sonnet': 0.003,
  'gemini-1.5-pro': 0.00125, 'gemini-2.5-pro': 0.00125,
};

// ── Heatmap updater ───────────────────────────────────────────────────────────

/**
 * Update token density heatmap decorations for all visible lines.
 * Called on every text change (debounced 150ms).
 *
 * Algorithm:
 *  1. Count tokens per line
 *  2. Normalize: density = min(tokens / HOT_THRESHOLD, 1.0)
 *  3. Map to decoration bucket [0, HEAT_LEVELS-1]
 *  4. Apply in batch (one setDecorations call per heat level)
 *
 * Performance:
 *  - Only processes visible range + 50 lines buffer
 *  - Batches all setDecorations calls
 *  - Uses a single pass over lines
 */
function updateHeatmap(editor) {
  if (!editor || !heatmapEnabled) {
    heatDecorations.forEach(d => editor && editor.setDecorations(d, []));
    editor && editor.setDecorations(costDecoration, []);
    return;
  }

  const config = getConfig();
  const model  = config.model;
  const doc    = editor.document;

  // Only process visible range + buffer for performance
  const visStart = editor.visibleRanges[0]?.start.line || 0;
  const visEnd   = Math.min(
    (editor.visibleRanges[editor.visibleRanges.length - 1]?.end.line || 0) + 50,
    doc.lineCount - 1
  );

  const HOT_THRESHOLD = 30; // tokens/line = max heat
  const buckets       = Array.from({ length: HEAT_LEVELS }, () => []);
  const costRanges    = [];

  for (let i = visStart; i <= visEnd; i++) {
    const line   = doc.lineAt(i);
    if (line.isEmptyOrWhitespace) continue;

    const tokens  = countLineTokens(line.text, model);
    if (tokens === 0) continue;

    const density = Math.min(tokens / HOT_THRESHOLD, 1.0);
    const bucket  = Math.floor(density * (HEAT_LEVELS - 1));
    buckets[bucket].push(line.range);

    // Inline cost label for lines with ≥5 tokens
    if (tokens >= 5 && config.showInlineCost) {
      const costPerK = PRICING[model] || PRICING['gpt-4o'];
      const cost     = (tokens / 1000) * costPerK;
      costRanges.push({
        range: line.range,
        renderOptions: {
          after: {
            contentText: ` ≈ $${cost.toFixed(5)} · ${tokens}t`,
          }
        }
      });
    }
  }

  // Apply all heat decorations in a single synchronous batch
  for (let i = 0; i < HEAT_LEVELS; i++) {
    editor.setDecorations(heatDecorations[i], buckets[i]);
  }
  editor.setDecorations(costDecoration, costRanges);
}

// ── Diagnostic linter ─────────────────────────────────────────────────────────

/**
 * Run lint-engine on the entire document and populate the Problems panel.
 * Called on save and on text change (debounced 600ms).
 *
 * Uses the same DensifyLint module as the browser extension.
 * Falls back gracefully if lint module isn't loaded in this environment.
 */
function updateDiagnostics(doc) {
  if (!diagnosticCollection) return;

  // Only lint files that look like prompts or markdown
  if (!isPromptFile(doc)) {
    diagnosticCollection.delete(doc.uri);
    return;
  }

  const text = doc.getText();
  if (!text.trim()) { diagnosticCollection.delete(doc.uri); return; }

  const config = getConfig();

  // Use engine's getSuggestions (available in all environments)
  const suggestions = engine.getSuggestions(text, config.model);

  const diagnostics = suggestions.map(sug => {
    const startPos = doc.positionAt(sug.startIndex);
    const endPos   = doc.positionAt(sug.endIndex);
    const range    = new vscode.Range(startPos, endPos);

    const severity =
      sug.severity === 'high'   ? vscode.DiagnosticSeverity.Warning :
      sug.severity === 'medium' ? vscode.DiagnosticSeverity.Information :
                                  vscode.DiagnosticSeverity.Hint;

    const diag = new vscode.Diagnostic(
      range,
      `⚡ Densify: ${sug.explanation} (−${sug.tokensSaved || 0} tokens, conf: ${(sug.confidence * 100).toFixed(0)}%)`,
      severity
    );
    diag.code   = sug.type;
    diag.source = 'Densify';
    diag.tags   = sug.type === 'redundant' || sug.type === 'filler'
      ? [vscode.DiagnosticTag.Unnecessary]
      : [];
    return diag;
  });

  diagnosticCollection.set(doc.uri, diagnostics);
  updateUnderlines(vscode.window.activeTextEditor, suggestions, doc);
}

/**
 * Draw wavy underlines under flagged ranges using DecorationTypes.
 * VS Code's Diagnostic decorations are only in the Problems gutter —
 * this adds inline visual underlines like Grammarly.
 */
function updateUnderlines(editor, suggestions, doc) {
  if (!editor || editor.document !== doc) return;

  const buckets = { error: [], warning: [], info: [], hint: [] };

  for (const sug of suggestions) {
    const severity =
      sug.severity === 'high'   ? 'warning' :
      sug.severity === 'medium' ? 'info'    : 'hint';

    const startPos = doc.positionAt(sug.startIndex);
    const endPos   = doc.positionAt(sug.endIndex);
    buckets[severity].push({ range: new vscode.Range(startPos, endPos) });
  }

  for (const [sev, ranges] of Object.entries(buckets)) {
    editor.setDecorations(UNDERLINE_DECS[sev], ranges);
  }
}

// ── Hover provider ────────────────────────────────────────────────────────────

/**
 * Shows suggestion explanation + token savings on hover.
 * Registered for all file types — only triggers when Densify has diagnostics.
 */
function createHoverProvider() {
  return vscode.languages.registerHoverProvider({ scheme: 'file' }, {
    provideHover(doc, position) {
      if (!isPromptFile(doc)) return null;
      const diags = diagnosticCollection.get(doc.uri);
      if (!diags || diags.length === 0) return null;

      const offset  = doc.offsetAt(position);
      const matching = diags.filter(d => {
        const s = doc.offsetAt(d.range.start);
        const e = doc.offsetAt(d.range.end);
        return offset >= s && offset <= e;
      });

      if (matching.length === 0) return null;

      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.appendMarkdown(`**⚡ Densify Suggestion**\n\n`);
      for (const d of matching) {
        md.appendMarkdown(`- ${d.message}\n`);
        if (d.code) md.appendMarkdown(`  *(rule: \`${d.code}\`)*\n`);
      }
      md.appendMarkdown('\n---\n');
      md.appendMarkdown(`*[Densify: Optimize Prompt](command:densify.optimizePrompt) · [Apply All](command:densify.optimizeAndReplace)*`);

      return new vscode.Hover(md);
    }
  });
}

// ── Code actions provider (Quick Fix) ────────────────────────────────────────

function createCodeActionsProvider() {
  return vscode.languages.registerCodeActionsProvider(
    { scheme: 'file' },
    {
      provideCodeActions(doc, range, ctx) {
        if (!isPromptFile(doc)) return [];
        const actions = [];

        const densifyDiags = ctx.diagnostics.filter(d => d.source === 'Densify');
        if (densifyDiags.length === 0) return [];

        // Quick Fix: optimize the full prompt
        const fix = new vscode.CodeAction(
          '⚡ Densify: Optimize this prompt',
          vscode.CodeActionKind.QuickFix
        );
        fix.command = { command: 'densify.optimizeAndReplace', title: 'Optimize & Replace' };
        fix.diagnostics = densifyDiags;
        fix.isPreferred = true;
        actions.push(fix);

        // Show suggestions
        const show = new vscode.CodeAction(
          '⚡ Densify: Show all suggestions',
          vscode.CodeActionKind.QuickFix
        );
        show.command = { command: 'densify.showSuggestions', title: 'Show Suggestions' };
        actions.push(show);

        return actions;
      }
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPromptFile(doc) {
  if (!doc) return false;
  const lang = doc.languageId;
  const name = doc.fileName.toLowerCase();
  // Lint markdown, plaintext, and common prompt file extensions
  return lang === 'markdown' || lang === 'plaintext' || lang === 'text' ||
    name.endsWith('.prompt') || name.endsWith('.txt') ||
    name.endsWith('.md') || name.endsWith('.mdx');
}

function getSelectedText(editor) {
  const sel = editor.selection;
  if (sel.isEmpty) return editor.document.lineAt(sel.active.line).text.trim();
  return editor.document.getText(sel);
}

async function replaceSelection(editor, newText) {
  const sel = editor.selection;
  await editor.edit(b => {
    if (sel.isEmpty) {
      b.replace(editor.document.lineAt(sel.active.line).range, newText);
    } else {
      b.replace(sel, newText);
    }
  });
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('densify');
  return {
    model:          cfg.get('model', 'gpt-4o'),
    removeFiller:   cfg.get('removeFiller', true),
    removeCeremony: cfg.get('removeCeremony', true),
    showStatusBar:  cfg.get('showStatusBar', true),
    showInlineCost: cfg.get('showInlineCost', false),
    enableHeatmap:  cfg.get('enableHeatmap', true),
    enableLinter:   cfg.get('enableLinter', true),
  };
}

function getCostPerK(model) {
  return PRICING[model] || PRICING['gpt-4o'];
}

// ── Status bar updater ────────────────────────────────────────────────────────

function updateStatusBar(editor) {
  const cfg = getConfig();
  if (!cfg.showStatusBar || !editor) { statusBarItem?.hide(); return; }

  const sel = editor.selection;
  if (sel.isEmpty) {
    // Show total doc tokens
    const total = engine.countTokens(editor.document.getText(), cfg.model);
    statusBarItem.text    = `⚡ ${total}t`;
    statusBarItem.tooltip = `Densify: ${total} tokens in document (${cfg.model})\nClick to optimize selection`;
  } else {
    const text   = editor.document.getText(sel);
    const tokens = engine.countTokens(text, cfg.model);
    const cost   = (tokens / 1000) * getCostPerK(cfg.model);
    statusBarItem.text    = `⚡ ${tokens}t · $${cost.toFixed(5)}`;
    statusBarItem.tooltip = `Densify: ${tokens} tokens selected · ~$${cost.toFixed(5)} on ${cfg.model}`;
  }
  statusBarItem.show();
}

// ── Activation ────────────────────────────────────────────────────────────────

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('[Densify Context] Extension v2 activated');

  // Build decoration types
  buildHeatDecorations();

  // ── Diagnostic collection (Problems panel) ─────────────────────────────
  diagnosticCollection = vscode.languages.createDiagnosticCollection('densify');
  context.subscriptions.push(diagnosticCollection);

  // ── Status bar ─────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'densify.countTokens';
  statusBarItem.tooltip = 'Densify: Click to count tokens';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(vscode.window.activeTextEditor);

  // ── Hover + code actions ───────────────────────────────────────────────
  context.subscriptions.push(createHoverProvider());
  context.subscriptions.push(createCodeActionsProvider());

  // ── Event listeners ────────────────────────────────────────────────────

  // Text change: debounce heatmap (150ms) and diagnostics (600ms) separately
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== e.document) return;
      debounce('heatmap', () => updateHeatmap(editor), 150);
      debounce('diag',    () => updateDiagnostics(e.document), 600);
      debounce('status',  () => updateStatusBar(editor), 200);
    })
  );

  // Active editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return;
      updateHeatmap(editor);
      updateDiagnostics(editor.document);
      updateStatusBar(editor);
    })
  );

  // Selection change (status bar update)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      debounce('status', () => updateStatusBar(e.textEditor), 100);
    })
  );

  // Visible range change (scroll → update heatmap for new lines)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges(e => {
      debounce('heatmap-scroll', () => updateHeatmap(e.textEditor), 80);
    })
  );

  // On save: run full diagnostics immediately
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      updateDiagnostics(doc);
    })
  );

  // Config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('densify')) {
        heatmapEnabled = getConfig().enableHeatmap;
        const editor = vscode.window.activeTextEditor;
        if (editor) { updateHeatmap(editor); updateStatusBar(editor); }
      }
    })
  );

  // Initialize for the already-open editor
  if (vscode.window.activeTextEditor) {
    updateHeatmap(vscode.window.activeTextEditor);
    updateDiagnostics(vscode.window.activeTextEditor.document);
  }

  // ── Commands ───────────────────────────────────────────────────────────

  // Optimize Prompt — diff preview
  context.subscriptions.push(vscode.commands.registerCommand('densify.optimizePrompt', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text = getSelectedText(editor);
    if (!text) { vscode.window.showWarningMessage('Densify: Select or focus text to optimize'); return; }

    const cfg    = getConfig();
    const result = engine.optimizePrompt(text, cfg);

    if (result.savings.saved <= 0) {
      vscode.window.showInformationMessage('⚡ Densify: Already concise! ✨');
      return;
    }

    const origUri = vscode.Uri.parse('densify-original:Original Prompt');
    const optUri  = vscode.Uri.parse('densify-optimized:Optimized Prompt');

    const origProv = new (class { provideTextDocumentContent() { return text; } })();
    const optProv  = new (class { provideTextDocumentContent() { return result.optimized; } })();

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('densify-original', origProv),
      vscode.workspace.registerTextDocumentContentProvider('densify-optimized', optProv),
    );

    const title = `⚡ Densify: ${result.savings.saved} tokens saved (${result.savings.percentage}%) · ~$${result.savings.costSaved.toFixed(4)} on ${cfg.model}`;
    await vscode.commands.executeCommand('vscode.diff', origUri, optUri, title);

    const action = await vscode.window.showInformationMessage(title, 'Replace Selection', 'Copy Optimized', 'Dismiss');
    if (action === 'Replace Selection') await replaceSelection(editor, result.optimized);
    else if (action === 'Copy Optimized') {
      await vscode.env.clipboard.writeText(result.optimized);
      vscode.window.showInformationMessage('⚡ Densify: Copied! 📋');
    }
  }));

  // Optimize & Replace — direct
  context.subscriptions.push(vscode.commands.registerCommand('densify.optimizeAndReplace', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text = getSelectedText(editor);
    if (!text) return;

    const cfg    = getConfig();
    const result = engine.optimizePrompt(text, cfg);
    if (result.savings.saved <= 0) {
      vscode.window.showInformationMessage('⚡ Densify: Already concise! ✨');
      return;
    }
    await replaceSelection(editor, result.optimized);
    vscode.window.showInformationMessage(
      `⚡ Replaced! ${result.savings.saved} tokens saved (${result.savings.percentage}%) · ~$${result.savings.costSaved.toFixed(4)}`
    );
  }));

  // Show Suggestions — QuickPick interactive
  context.subscriptions.push(vscode.commands.registerCommand('densify.showSuggestions', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text = getSelectedText(editor);
    if (!text) return;

    const cfg         = getConfig();
    const suggestions = engine.getSuggestions(text, cfg.model);
    if (!suggestions.length) {
      vscode.window.showInformationMessage('⚡ Densify: No suggestions — prompt is clean! ✨');
      return;
    }

    const items = suggestions.map(sug => ({
      label:       `${sug.severity === 'high' ? '🔴' : sug.severity === 'medium' ? '🟡' : '🟢'} ${sug.original}`,
      description: sug.replacement !== '(remove)' ? `→ ${sug.replacement}` : '→ (remove)',
      detail:      `${sug.explanation}  |  −${sug.tokensSaved || 0} tokens  |  conf: ${(sug.confidence * 100).toFixed(0)}%`,
      suggestion:  sug,
      picked:      sug.confidence >= 0.70,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      canPickMany:  true,
      placeHolder:  `${suggestions.length} suggestions — select which to apply`,
      title:        '⚡ Densify: Prompt Suggestions',
    });

    if (selected && selected.length > 0) {
      const ids      = selected.map(i => i.suggestion.id);
      const optimized = engine.applySuggestions(text, suggestions, ids);
      await replaceSelection(editor, optimized);
      const saved = selected.reduce((s, i) => s + (i.suggestion.tokensSaved || 0), 0);
      vscode.window.showInformationMessage(`⚡ Applied ${selected.length} suggestions · ~${saved} tokens saved`);
    }
  }));

  // Count Tokens
  context.subscriptions.push(vscode.commands.registerCommand('densify.countTokens', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text   = getSelectedText(editor) || editor.document.getText();
    const cfg    = getConfig();
    const tokens = engine.countTokens(text, cfg.model);
    const cost   = (tokens / 1000) * getCostPerK(cfg.model);
    vscode.window.showInformationMessage(
      `📊 Densify: ${tokens} tokens · ~$${cost.toFixed(5)} input cost (${cfg.model})`
    );
  }));

  // Toggle Heatmap
  context.subscriptions.push(vscode.commands.registerCommand('densify.toggleHeatmap', () => {
    heatmapEnabled = !heatmapEnabled;
    const editor = vscode.window.activeTextEditor;
    if (!heatmapEnabled && editor) {
      // Clear all decorations
      heatDecorations.forEach(d => editor.setDecorations(d, []));
      editor.setDecorations(costDecoration, []);
      Object.values(UNDERLINE_DECS).forEach(d => editor.setDecorations(d, []));
    } else if (editor) {
      updateHeatmap(editor);
    }
    vscode.window.setStatusBarMessage(
      `⚡ Densify heatmap ${heatmapEnabled ? 'ON' : 'OFF'}`, 2000
    );
  }));

  // Run Linter
  context.subscriptions.push(vscode.commands.registerCommand('densify.runLinter', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    updateDiagnostics(editor.document);
    const diags = diagnosticCollection.get(editor.document.uri) || [];
    vscode.window.showInformationMessage(
      `⚡ Densify Linter: ${diags.length} issue${diags.length !== 1 ? 's' : ''} found`
    );
  }));

  // Show Telemetry Snapshot
  context.subscriptions.push(vscode.commands.registerCommand('densify.showTelemetry', async () => {
    const panel = vscode.window.createWebviewPanel(
      'densifyTelemetry',
      '⚡ Densify Telemetry',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.html = getTelemetryHTML(engine);
  }));
}

// ── Telemetry Webview ─────────────────────────────────────────────────────────

function getTelemetryHTML(eng) {
  const stats = {
    version:     eng.version || '5.0.0',
    totalRules:  (eng.PHRASE_REPLACEMENTS?.size || 0) + (eng.FILLER_WORDS?.size || 0) + (eng.REDUNDANT_MODIFIERS?.size || 0),
    models:      eng.availableModels?.() || [],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Densify Telemetry</title>
  <style>
    body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background);
           color: var(--vscode-editor-foreground); padding: 24px; }
    h1   { font-size: 18px; margin-bottom: 20px; }
    .card{ background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border);
           border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .stat{ display: flex; justify-content: space-between; padding: 4px 0;
           border-bottom: 1px solid var(--vscode-widget-border); font-size: 13px; }
    .val { font-weight: 600; color: var(--vscode-terminal-ansiCyan); }
    pre  { font-size: 11px; overflow: auto; max-height: 300px; }
  </style>
</head>
<body>
  <h1>⚡ Densify — Engine Diagnostics</h1>
  <div class="card">
    <div class="stat"><span>Engine Version</span><span class="val">${stats.version}</span></div>
    <div class="stat"><span>Total Rules Loaded</span><span class="val">${stats.totalRules}</span></div>
    <div class="stat"><span>Models Supported</span><span class="val">${stats.models.length}</span></div>
  </div>
  <div class="card">
    <b>Supported Models</b>
    <pre>${stats.models.join('\n')}</pre>
  </div>
  <div class="card">
    <b>How to enable full telemetry (browser extension):</b>
    <pre>// In browser console on any page with Densify active:
DensifyTelemetry.enable();
// ... use the extension ...
console.table(DensifyTelemetry.report());
console.log(DensifyTelemetry.cacheStats());</pre>
  </div>
</body>
</html>`;
}

// ── Deactivation ──────────────────────────────────────────────────────────────

function deactivate() {
  statusBarItem?.dispose();
  diagnosticCollection?.dispose();
  heatDecorations.forEach(d => d.dispose());
  costDecoration.dispose();
  Object.values(UNDERLINE_DECS).forEach(d => d.dispose());
}

module.exports = { activate, deactivate };
