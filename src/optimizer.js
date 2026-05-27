// ─────────────────────────────────────────────────────────
//  optimizer.js — Core prompt optimization engine
// ─────────────────────────────────────────────────────────
//  Applies rules from rules.js in a deterministic pipeline:
//    1. Redundant modifiers
//    2. Verbose phrase replacements
//    3. Prompt ceremony removal
//    4. Filler word removal
//    5. Whitespace normalization
//    6. Sentence-start capitalization repair
//
//  Every transformation is tracked so we can surface it
//  in getSuggestions() and compute a confidence score.
// ─────────────────────────────────────────────────────────

import {
  PHRASE_REPLACEMENTS,
  FILLER_WORDS,
  REDUNDANT_MODIFIERS,
  PROMPT_CEREMONY_PATTERNS,
  WHITESPACE_RULES,
} from './rules.js';
import { countTokens, estimateSavings } from './tokenizer.js';

// ── Helpers ─────────────────────────────────────────────

/** Escape a literal string for use in a RegExp. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Capitalize the first letter of a string.
 * Used to repair sentence starts after deletions.
 */
function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── Transformation pipeline ─────────────────────────────

/**
 * @typedef {Object} Change
 * @property {string} type       - Category: 'phrase' | 'filler' | 'redundant' | 'ceremony' | 'whitespace'
 * @property {string} original   - The matched text
 * @property {string} replacement - What it was replaced with
 * @property {number} confidence  - 0–1 score
 * @property {string} explanation - Human-readable reason
 */

/**
 * Apply redundant modifier rules.
 * @param {string} text
 * @param {Change[]} changes
 * @returns {string}
 */
function applyRedundantModifiers(text, changes) {
  for (const [verbose, concise] of REDUNDANT_MODIFIERS) {
    const regex = new RegExp(`\\b${escapeRegex(verbose)}\\b`, 'gi');
    if (regex.test(text)) {
      text = text.replace(regex, (match) => {
        changes.push({
          type: 'redundant',
          original: match,
          replacement: concise,
          confidence: 0.92,
          explanation: `"${match}" is redundant — "${concise}" already implies the modifier.`,
        });
        // Preserve original casing of first char
        return match[0] === match[0].toUpperCase()
          ? capitalizeFirst(concise)
          : concise;
      });
    }
  }
  return text;
}

/**
 * Apply verbose phrase → concise replacements.
 * Sorted by key length descending so longer matches win.
 * @param {string} text
 * @param {Change[]} changes
 * @returns {string}
 */
function applyPhraseReplacements(text, changes) {
  // Sort by length descending for greedy matching
  const sorted = [...PHRASE_REPLACEMENTS.entries()]
    .sort((a, b) => b[0].length - a[0].length);

  for (const [verbose, concise] of sorted) {
    const regex = new RegExp(`\\b${escapeRegex(verbose)}\\b`, 'gi');
    if (regex.test(text)) {
      // Reset lastIndex after test()
      regex.lastIndex = 0;
      text = text.replace(regex, (match) => {
        changes.push({
          type: 'phrase',
          original: match,
          replacement: concise || '(removed)',
          confidence: 0.88,
          explanation: concise
            ? `"${match}" → "${concise}" (same meaning, fewer tokens)`
            : `"${match}" is unnecessary filler and can be removed.`,
        });
        return concise;
      });
    }
  }
  return text;
}

/**
 * Remove prompt-specific ceremony (greetings, closings, meta-framing).
 * @param {string} text
 * @param {Change[]} changes
 * @returns {string}
 */
function applyPromptCeremony(text, changes) {
  for (const { pattern, replacement, label } of PROMPT_CEREMONY_PATTERNS) {
    // Clone the regex so we don't share state
    const regex = new RegExp(pattern.source, pattern.flags);
    // Use replace callback to capture each full match safely
    let hadMatch = false;
    const replaced = text.replace(regex, (fullMatch) => {
      if (fullMatch.trim().length > 0) {
        hadMatch = true;
        changes.push({
          type: 'ceremony',
          original: fullMatch.trim(),
          replacement: replacement || '(removed)',
          confidence: 0.78,
          explanation: `Removed ${label}: "${fullMatch.trim()}" — LLMs don't need social niceties.`,
        });
      }
      return replacement;
    });
    if (hadMatch) {
      text = replaced;
    }
  }
  return text;
}

/**
 * Remove filler words.
 * We only remove a filler word when it is surrounded by word boundaries
 * and not the only word in the sentence.
 * @param {string} text
 * @param {Change[]} changes
 * @returns {string}
 */
function applyFillerWordRemoval(text, changes) {
  for (const filler of FILLER_WORDS) {
    // Match optional leading space + filler word + optional trailing whitespace
    // This catches fillers mid-sentence AND at end-of-sentence (before punctuation)
    const regex = new RegExp(`\\s*\\b${escapeRegex(filler)}\\b\\s*`, 'gi');
    text = text.replace(regex, (match) => {
      const trimmed = match.trim();
      if (!trimmed) return match;
      changes.push({
        type: 'filler',
        original: trimmed,
        replacement: '(removed)',
        confidence: 0.65,
        explanation: `"${trimmed}" is a filler word that adds no meaning.`,
      });
      // Preserve a single space to avoid merging adjacent words
      return ' ';
    });
  }
  return text;
}

/**
 * Normalize whitespace and punctuation.
 * @param {string} text
 * @param {Change[]} changes
 * @returns {string}
 */
function applyWhitespaceNormalization(text, changes) {
  const before = text;
  for (const { pattern, replacement } of WHITESPACE_RULES) {
    text = text.replace(pattern, replacement);
  }
  // Trim the whole result
  text = text.trim();

  if (text !== before) {
    changes.push({
      type: 'whitespace',
      original: '(whitespace)',
      replacement: '(normalized)',
      confidence: 1.0,
      explanation: 'Collapsed extra whitespace and fixed punctuation spacing.',
    });
  }
  return text;
}

/**
 * Repair capitalization at sentence starts after deletions.
 * @param {string} text
 * @returns {string}
 */
function repairCapitalization(text) {
  // After a period/newline + space, uppercase the next letter
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, char) => {
    return prefix + char.toUpperCase();
  });
  // Capitalize very first character
  if (text.length > 0 && /[a-z]/.test(text[0])) {
    text = capitalizeFirst(text);
  }
  return text;
}

// ── Public API ──────────────────────────────────────────

/**
 * Optimizes a prompt string by applying all compression rules.
 *
 * @param {string} text - The original prompt.
 * @param {Object} [options]
 * @param {boolean}  [options.removeFiller=true]   - Remove filler words.
 * @param {boolean}  [options.removeCeremony=true] - Remove greetings / politeness.
 * @param {boolean}  [options.compressPhrases=true] - Apply phrase replacements.
 * @param {boolean}  [options.removeRedundant=true] - Remove redundant modifiers.
 * @param {string}   [options.model='gpt-4o']       - Model for cost estimate.
 * @returns {{
 *   original: string,
 *   optimized: string,
 *   changes: Change[],
 *   tokensBefore: number,
 *   tokensAfter: number,
 *   savings: { saved: number, percentage: number, costSaved: number, model: string },
 *   confidence: number,
 * }}
 */
export function optimizePrompt(text, options = {}) {
  const {
    removeFiller = true,
    removeCeremony = true,
    compressPhrases = true,
    removeRedundant = true,
    model = 'gpt-4o',
  } = options;

  if (!text || typeof text !== 'string') {
    return {
      original: text ?? '',
      optimized: text ?? '',
      changes: [],
      tokensBefore: 0,
      tokensAfter: 0,
      savings: { saved: 0, percentage: 0, costSaved: 0, model },
      confidence: 1.0,
    };
  }

  const original = text;
  const changes = /** @type {Change[]} */ [];

  const tokensBefore = countTokens(original);

  // ── Pipeline ──────────────────────────────────────
  let result = text;

  if (removeRedundant)   result = applyRedundantModifiers(result, changes);
  if (compressPhrases)   result = applyPhraseReplacements(result, changes);
  if (removeCeremony)    result = applyPromptCeremony(result, changes);
  if (removeFiller)      result = applyFillerWordRemoval(result, changes);

  result = applyWhitespaceNormalization(result, changes);
  result = repairCapitalization(result);

  const tokensAfter = countTokens(result);
  const savings = estimateSavings(tokensBefore, tokensAfter, model);

  // ── Aggregate confidence ──────────────────────────
  // Weighted average of individual change confidences,
  // or 1.0 if no changes were made.
  const meaningfulChanges = changes.filter(c => c.type !== 'whitespace');
  const confidence = meaningfulChanges.length > 0
    ? parseFloat(
        (meaningfulChanges.reduce((sum, c) => sum + c.confidence, 0) /
          meaningfulChanges.length
        ).toFixed(2)
      )
    : 1.0;

  return {
    original,
    optimized: result,
    changes,
    tokensBefore,
    tokensAfter,
    savings,
    confidence,
  };
}
