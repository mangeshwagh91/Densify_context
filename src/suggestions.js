// ─────────────────────────────────────────────────────────
//  suggestions.js — Non-destructive suggestion generator
// ─────────────────────────────────────────────────────────
//  Unlike optimizePrompt(), which returns one optimized
//  string, getSuggestions() returns individual actionable
//  suggestions the user can accept or reject one by one.
// ─────────────────────────────────────────────────────────

import {
  PHRASE_REPLACEMENTS,
  FILLER_WORDS,
  REDUNDANT_MODIFIERS,
  PROMPT_CEREMONY_PATTERNS,
} from './rules.js';
import { countTokens } from './tokenizer.js';

/** Escape a literal string for use in a RegExp. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @typedef {Object} Suggestion
 * @property {string}  id          - Unique identifier for the suggestion
 * @property {string}  type        - Category: 'phrase' | 'filler' | 'redundant' | 'ceremony' | 'structural'
 * @property {string}  original    - The matched text in the prompt
 * @property {string}  replacement - Suggested replacement text
 * @property {number}  confidence  - 0–1 score
 * @property {string}  explanation - Human-readable reason
 * @property {number}  tokensSaved - Estimated token savings for this specific change
 * @property {number}  startIndex  - Character offset where the match starts
 * @property {number}  endIndex    - Character offset where the match ends
 * @property {string}  severity    - 'high' | 'medium' | 'low'
 */

let suggestionCounter = 0;
function nextId() {
  return `sug_${++suggestionCounter}`;
}

function severity(confidence) {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.65) return 'medium';
  return 'low';
}

/**
 * Generates a list of individual, non-overlapping suggestions.
 *
 * @param {string} text - The user's prompt.
 * @returns {Suggestion[]} Sorted by position in text (startIndex ascending).
 */
export function getSuggestions(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }

  /** @type {Suggestion[]} */
  const suggestions = [];

  // Track matched ranges to prevent overlapping suggestions
  const matchedRanges = /** @type {{ start: number, end: number }[]} */ [];

  function overlaps(start, end) {
    return matchedRanges.some(
      r => (start >= r.start && start < r.end) || (end > r.start && end <= r.end)
    );
  }

  function recordRange(start, end) {
    matchedRanges.push({ start, end });
  }

  // ── 1. Redundant modifiers ────────────────────────
  for (const [verbose, concise] of REDUNDANT_MODIFIERS) {
    const regex = new RegExp(`\\b${escapeRegex(verbose)}\\b`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!overlaps(start, end)) {
        recordRange(start, end);
        suggestions.push({
          id: nextId(),
          type: 'redundant',
          original: match[0],
          replacement: concise,
          confidence: 0.92,
          explanation: `"${match[0]}" is redundant — "${concise}" already implies the modifier.`,
          tokensSaved: countTokens(match[0]) - countTokens(concise),
          startIndex: start,
          endIndex: end,
          severity: severity(0.92),
        });
      }
    }
  }

  // ── 2. Verbose phrases ────────────────────────────
  const sortedPhrases = [...PHRASE_REPLACEMENTS.entries()]
    .sort((a, b) => b[0].length - a[0].length);

  for (const [verbose, concise] of sortedPhrases) {
    const regex = new RegExp(`\\b${escapeRegex(verbose)}\\b`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!overlaps(start, end)) {
        recordRange(start, end);
        const conf = concise ? 0.88 : 0.80;
        suggestions.push({
          id: nextId(),
          type: 'phrase',
          original: match[0],
          replacement: concise || '(remove)',
          confidence: conf,
          explanation: concise
            ? `"${match[0]}" → "${concise}" (same meaning, fewer tokens)`
            : `"${match[0]}" is unnecessary and can be removed.`,
          tokensSaved: countTokens(match[0]) - countTokens(concise || ''),
          startIndex: start,
          endIndex: end,
          severity: severity(conf),
        });
      }
    }
  }

  // ── 3. Prompt ceremony ────────────────────────────
  for (const { pattern, replacement, label } of PROMPT_CEREMONY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].trim().length === 0) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (!overlaps(start, end)) {
        recordRange(start, end);
        suggestions.push({
          id: nextId(),
          type: 'ceremony',
          original: match[0].trim(),
          replacement: replacement || '(remove)',
          confidence: 0.78,
          explanation: `${capitalize(label)}: "${match[0].trim()}" — LLMs don't need social niceties.`,
          tokensSaved: countTokens(match[0]) - countTokens(replacement || ''),
          startIndex: start,
          endIndex: end,
          severity: severity(0.78),
        });
      }
      // For non-global patterns, break after first match
      if (!pattern.global) break;
    }
  }

  // ── 4. Filler words ───────────────────────────────
  for (const filler of FILLER_WORDS) {
    const regex = new RegExp(`\\b${escapeRegex(filler)}\\b`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!overlaps(start, end)) {
        recordRange(start, end);
        suggestions.push({
          id: nextId(),
          type: 'filler',
          original: match[0],
          replacement: '(remove)',
          confidence: 0.65,
          explanation: `"${match[0]}" is a filler word that adds no meaning.`,
          tokensSaved: countTokens(match[0]),
          startIndex: start,
          endIndex: end,
          severity: severity(0.65),
        });
      }
    }
  }

  // ── 5. Structural suggestions ─────────────────────

  // Detect overly long sentences (> 40 words)
  const sentences = text.split(/(?<=[.!?])\s+/);
  let charOffset = 0;
  for (const sentence of sentences) {
    const wordCount = sentence.split(/\s+/).length;
    if (wordCount > 40) {
      const start = text.indexOf(sentence, charOffset);
      if (start !== -1 && !overlaps(start, start + sentence.length)) {
        suggestions.push({
          id: nextId(),
          type: 'structural',
          original: sentence.slice(0, 60) + '…',
          replacement: '(split into shorter sentences)',
          confidence: 0.50,
          explanation: `This sentence has ${wordCount} words. Consider splitting it for clarity.`,
          tokensSaved: 0,
          startIndex: start,
          endIndex: start + sentence.length,
          severity: 'low',
        });
      }
    }
    charOffset += sentence.length + 1;
  }

  // Sort by position
  suggestions.sort((a, b) => a.startIndex - b.startIndex);

  return suggestions;
}

/**
 * Apply a subset of suggestions to the text.
 * Suggestions are applied in reverse order (right to left)
 * to preserve character offsets.
 *
 * @param {string} text
 * @param {Suggestion[]} suggestions - Must be the suggestions returned for this exact text.
 * @param {string[]} [acceptedIds] - IDs of suggestions to apply. If omitted, all are applied.
 * @returns {string}
 */
export function applySuggestions(text, suggestions, acceptedIds) {
  const toApply = acceptedIds
    ? suggestions.filter(s => acceptedIds.includes(s.id))
    : suggestions;

  // Sort right-to-left so splicing doesn't shift offsets
  const sorted = [...toApply].sort((a, b) => b.startIndex - a.startIndex);

  let result = text;
  for (const sug of sorted) {
    const replacement = sug.replacement === '(remove)' ? '' : sug.replacement;
    result = result.slice(0, sug.startIndex) + replacement + result.slice(sug.endIndex);
  }

  // Clean up double spaces
  result = result.replace(/  +/g, ' ').trim();
  return result;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
