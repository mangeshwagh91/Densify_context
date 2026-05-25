// ─────────────────────────────────────────────────────────
//  index.js — Public API surface for densify-context
// ─────────────────────────────────────────────────────────

export { optimizePrompt } from './optimizer.js';
export { countTokens, estimateSavings, availableModels } from './tokenizer.js';
export { getSuggestions, applySuggestions } from './suggestions.js';

// Re-export rules for extensibility (users can add their own)
export {
  PHRASE_REPLACEMENTS,
  FILLER_WORDS,
  REDUNDANT_MODIFIERS,
  PROMPT_CEREMONY_PATTERNS,
} from './rules.js';
