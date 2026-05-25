// ─────────────────────────────────────────────────────────
//  extension.js — Densify Context VS Code Extension
// ─────────────────────────────────────────────────────────
//  Commands:
//    1. densify.optimizePrompt     — Show diff preview
//    2. densify.optimizeAndReplace — Replace selection inline
//    3. densify.showSuggestions    — Show individual suggestions
//    4. densify.countTokens        — Count tokens in selection
// ─────────────────────────────────────────────────────────

const vscode = require('vscode');
const engine = require('./lib/densify-engine');

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('[Densify Context] Extension activated');

  // ── Status bar item ─────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'densify.countTokens';
  statusBarItem.tooltip = 'Densify: Click to count tokens in selection';
  context.subscriptions.push(statusBarItem);

  // Update status bar on selection change
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(updateStatusBar),
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar)
  );

  // Show status bar initially
  updateStatusBar();

  // ── Command: Optimize Prompt (Diff Preview) ─────
  context.subscriptions.push(
    vscode.commands.registerCommand('densify.optimizePrompt', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Densify: No active editor');
        return;
      }

      const text = getSelectedText(editor);
      if (!text) {
        vscode.window.showWarningMessage('Densify: Select text to optimize');
        return;
      }

      const config = getConfig();
      const result = engine.optimizePrompt(text, config);

      if (result.savings.saved <= 0) {
        vscode.window.showInformationMessage('Densify: Your prompt is already concise! ✨');
        return;
      }

      // Show diff in a virtual document
      const originalUri = vscode.Uri.parse('densify-original:Original Prompt');
      const optimizedUri = vscode.Uri.parse('densify-optimized:Optimized Prompt');

      // Register content providers for the diff
      const originalProvider = new (class {
        provideTextDocumentContent() { return text; }
      })();
      const optimizedProvider = new (class {
        provideTextDocumentContent() { return result.optimized; }
      })();

      const origDisposable = vscode.workspace.registerTextDocumentContentProvider(
        'densify-original', originalProvider
      );
      const optDisposable = vscode.workspace.registerTextDocumentContentProvider(
        'densify-optimized', optimizedProvider
      );

      context.subscriptions.push(origDisposable, optDisposable);

      // Open diff editor
      const diffTitle = `Densify: ${result.savings.saved} tokens saved (${result.savings.percentage}%)`;
      await vscode.commands.executeCommand('vscode.diff', originalUri, optimizedUri, diffTitle);

      // Show savings notification with action
      const action = await vscode.window.showInformationMessage(
        `⚡ Densify: ${result.savings.saved} tokens saved (${result.savings.percentage}%) | ` +
        `~$${result.savings.costSaved.toFixed(4)} saved on ${result.savings.model} | ` +
        `Confidence: ${(result.confidence * 100).toFixed(0)}%`,
        'Replace Selection',
        'Copy Optimized'
      );

      if (action === 'Replace Selection') {
        await replaceSelection(editor, result.optimized);
      } else if (action === 'Copy Optimized') {
        await vscode.env.clipboard.writeText(result.optimized);
        vscode.window.showInformationMessage('Densify: Optimized prompt copied! 📋');
      }
    })
  );

  // ── Command: Optimize & Replace ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('densify.optimizeAndReplace', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const text = getSelectedText(editor);
      if (!text) {
        vscode.window.showWarningMessage('Densify: Select text to optimize');
        return;
      }

      const config = getConfig();
      const result = engine.optimizePrompt(text, config);

      if (result.savings.saved <= 0) {
        vscode.window.showInformationMessage('Densify: Already concise! ✨');
        return;
      }

      await replaceSelection(editor, result.optimized);

      vscode.window.showInformationMessage(
        `⚡ Densify: Replaced! ${result.savings.saved} tokens saved (${result.savings.percentage}%) | ` +
        `~$${result.savings.costSaved.toFixed(4)} saved`
      );
    })
  );

  // ── Command: Show Suggestions ───────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('densify.showSuggestions', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const text = getSelectedText(editor);
      if (!text) {
        vscode.window.showWarningMessage('Densify: Select text to analyze');
        return;
      }

      const suggestions = engine.getSuggestions(text);

      if (suggestions.length === 0) {
        vscode.window.showInformationMessage('Densify: No suggestions — your prompt is clean! ✨');
        return;
      }

      // Build QuickPick items
      const items = suggestions.map((sug) => {
        const icon = sug.severity === 'high' ? '🔴' : sug.severity === 'medium' ? '🟡' : '🟢';
        return {
          label: `${icon} ${sug.original}`,
          description: `→ ${sug.replacement}`,
          detail: `${sug.explanation} | ${sug.tokensSaved} token(s) saved | Confidence: ${(sug.confidence * 100).toFixed(0)}%`,
          suggestion: sug,
          picked: sug.confidence >= 0.70,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `${suggestions.length} suggestions found — select which to apply`,
        title: 'Densify: Prompt Suggestions',
      });

      if (selected && selected.length > 0) {
        const acceptedIds = selected.map(item => item.suggestion.id);
        const optimized = engine.applySuggestions(text, suggestions, acceptedIds);
        await replaceSelection(editor, optimized);

        const totalSaved = selected.reduce((sum, item) => sum + item.suggestion.tokensSaved, 0);
        vscode.window.showInformationMessage(
          `⚡ Densify: Applied ${selected.length} suggestions, ~${totalSaved} tokens saved`
        );
      }
    })
  );

  // ── Command: Count Tokens ───────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('densify.countTokens', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const text = getSelectedText(editor) || editor.document.getText();
      const tokens = engine.countTokens(text);
      const config = getConfig();
      const cost = engine.estimateSavings(tokens, 0, config.model);

      vscode.window.showInformationMessage(
        `📊 Densify: ${tokens} tokens | ` +
        `Est. input cost: ~$${((tokens / 1000) * getCostPerK(config.model)).toFixed(4)} (${config.model})`
      );
    })
  );
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Get text from the current selection, or the entire line if no selection.
 * @param {vscode.TextEditor} editor
 * @returns {string}
 */
function getSelectedText(editor) {
  const selection = editor.selection;

  if (selection.isEmpty) {
    // Get the entire line
    const line = editor.document.lineAt(selection.active.line);
    return line.text.trim() || '';
  }

  return editor.document.getText(selection);
}

/**
 * Replace the current selection with new text.
 * @param {vscode.TextEditor} editor
 * @param {string} newText
 */
async function replaceSelection(editor, newText) {
  const selection = editor.selection;

  if (selection.isEmpty) {
    // Replace entire line
    const line = editor.document.lineAt(selection.active.line);
    await editor.edit(editBuilder => {
      editBuilder.replace(line.range, newText);
    });
  } else {
    await editor.edit(editBuilder => {
      editBuilder.replace(selection, newText);
    });
  }
}

/**
 * Get extension config options.
 * @returns {{ model: string, removeFiller: boolean, removeCeremony: boolean }}
 */
function getConfig() {
  const config = vscode.workspace.getConfiguration('densify');
  return {
    model: config.get('model', 'gpt-4o'),
    removeFiller: config.get('removeFiller', true),
    removeCeremony: config.get('removeCeremony', true),
  };
}

/**
 * Simple pricing lookup (matches the engine's MODEL_PRICING).
 */
function getCostPerK(model) {
  const pricing = {
    'gpt-4o': 0.0025,
    'gpt-4o-mini': 0.00015,
    'gpt-4-turbo': 0.01,
    'gpt-4': 0.03,
    'gpt-3.5-turbo': 0.0005,
    'claude-3-opus': 0.015,
    'claude-3.5-sonnet': 0.003,
    'claude-3-haiku': 0.00025,
    'claude-4-opus': 0.015,
    'claude-4-sonnet': 0.003,
    'gemini-1.5-pro': 0.00125,
    'gemini-2.5-pro': 0.00125,
  };
  return pricing[model] || pricing['gpt-4o'];
}

/**
 * Update the status bar with token count for current selection.
 */
function updateStatusBar() {
  const config = vscode.workspace.getConfiguration('densify');
  if (!config.get('showStatusBar', true)) {
    statusBarItem.hide();
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    statusBarItem.hide();
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    statusBarItem.text = '⚡ Densify';
    statusBarItem.show();
    return;
  }

  const text = editor.document.getText(selection);
  const tokens = engine.countTokens(text);
  statusBarItem.text = `⚡ ${tokens} tokens`;
  statusBarItem.show();
}

function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
