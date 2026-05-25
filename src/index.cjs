// ─────────────────────────────────────────────────────────
//  index.cjs — CommonJS wrapper for densify-context
// ─────────────────────────────────────────────────────────
//  This file is auto-generated for CJS consumers.
//  Use `require('densify-context')` in CommonJS environments.
// ─────────────────────────────────────────────────────────

// Dynamic import wrapper for CommonJS
let _module = null;

async function load() {
  if (!_module) {
    _module = await import('./src/index.js');
  }
  return _module;
}

module.exports = {
  async optimizePrompt(...args) {
    const m = await load();
    return m.optimizePrompt(...args);
  },
  async countTokens(...args) {
    const m = await load();
    return m.countTokens(...args);
  },
  async estimateSavings(...args) {
    const m = await load();
    return m.estimateSavings(...args);
  },
  async availableModels() {
    const m = await load();
    return m.availableModels();
  },
  async getSuggestions(...args) {
    const m = await load();
    return m.getSuggestions(...args);
  },
  async applySuggestions(...args) {
    const m = await load();
    return m.applySuggestions(...args);
  },
};
