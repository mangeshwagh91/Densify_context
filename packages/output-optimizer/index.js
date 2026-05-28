// ─────────────────────────────────────────────────────────────────────────────
//  packages/output-optimizer/index.js
//  Extractive output summarizer + structured formatter.
//
//  Runs fully offline (no LLM call). Uses TextRank-style sentence scoring
//  to pick the most informative sentences from a long model response.
//
//  Two modes:
//    summarize(text, opts)       – extractive summary (keep top sentences)
//    formatStructured(text, opts) – convert prose to bullets/numbered list
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Stopwords ─────────────────────────────────────────────────────────────────
const STOP = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','have','has','had','do','does',
  'did','will','would','could','should','i','you','he','she','it','we','they',
  'this','that','these','those','not','so','than','too','just','up','about',
]);

function tokenize(text) {
  return (text.toLowerCase().match(/\b[a-z]{2,}\b/g) || []).filter(w => !STOP.has(w));
}

// ── TF vector ─────────────────────────────────────────────────────────────────

function tfVec(tokens) {
  const v = new Map();
  for (const t of tokens) v.set(t, (v.get(t) || 0) + 1);
  return v;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, w] of a) { na += w * w; dot += w * (b.get(t) || 0); }
  for (const [, w] of b) nb += w * w;
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// ── Sentence splitter ─────────────────────────────────────────────────────────

function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space/newline
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

// ── TextRank-style scoring ────────────────────────────────────────────────────
// Each sentence gets a score = average similarity to all other sentences.
// High-scoring sentences are the "most central" (most content overlap).

function textRankScores(sentences) {
  const vecs = sentences.map(s => tfVec(tokenize(s)));
  const scores = sentences.map((_, i) => {
    let total = 0;
    for (let j = 0; j < sentences.length; j++) {
      if (i !== j) total += cosineSim(vecs[i], vecs[j]);
    }
    return total / Math.max(1, sentences.length - 1);
  });
  return scores;
}

// ── Repetition detector ───────────────────────────────────────────────────────
// Drops sentences with >70% similarity to an already-kept sentence.

function isDuplicate(vec, keptVecs, dupThreshold = 0.70) {
  return keptVecs.some(kv => cosineSim(vec, kv) >= dupThreshold);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extractive summarization: keep top-scoring sentences.
 *
 * @param {string} text - The text to summarize (LLM output or long prompt)
 * @param {object} opts
 * @param {number} [opts.ratio=0.5]          - Target ratio of text to keep (0–1)
 * @param {number} [opts.minSentences=2]     - Always keep at least this many sentences
 * @param {number} [opts.dupThreshold=0.70]  - Similarity above which a sentence is "duplicate"
 * @param {boolean} [opts.preserveOrder=true] - Keep sentences in original order
 * @returns {{ summary: string, tokensSaved: number, ratio: number, dropped: number }}
 */
export function summarize(text, opts = {}) {
  const {
    ratio         = 0.5,
    minSentences  = 2,
    dupThreshold  = 0.70,
    preserveOrder = true,
  } = opts;

  if (!text || typeof text !== 'string') {
    return { summary: text || '', tokensSaved: 0, ratio: 0, dropped: 0 };
  }

  const sentences = splitSentences(text);

  if (sentences.length <= minSentences) {
    return { summary: text, tokensSaved: 0, ratio: 0, dropped: 0 };
  }

  const scores   = textRankScores(sentences);
  const target   = Math.max(minSentences, Math.ceil(sentences.length * ratio));

  // Sort by score descending, then greedily pick non-duplicates
  const indexed  = sentences.map((s, i) => ({ s, i, score: scores[i] }));
  indexed.sort((a, b) => b.score - a.score);

  const keptVecs = [];
  const keptIdx  = new Set();

  for (const { s, i } of indexed) {
    if (keptIdx.size >= target) break;
    const vec = tfVec(tokenize(s));
    if (!isDuplicate(vec, keptVecs, dupThreshold)) {
      keptIdx.add(i);
      keptVecs.push(vec);
    }
  }

  // Restore original order if requested
  const keptSentences = preserveOrder
    ? sentences.filter((_, i) => keptIdx.has(i))
    : [...keptIdx].sort().map(i => sentences[i]);

  const summary    = keptSentences.join(' ').trim();
  const dropped    = sentences.length - keptSentences.length;
  const origTokens = Math.ceil(text.length / 4);
  const summTokens = Math.ceil(summary.length / 4);
  const tokensSaved = Math.max(0, origTokens - summTokens);
  const ratioOut   = parseFloat((dropped / sentences.length).toFixed(3));

  return { summary, tokensSaved, ratio: ratioOut, dropped };
}

/**
 * Convert a prose text into a structured bullet-point list.
 * Useful for turning long LLM explanations into scannable output.
 *
 * @param {string} text
 * @param {object} opts
 * @param {boolean} [opts.numbered=false]  - Use numbers instead of bullets
 * @param {number}  [opts.maxItems=10]     - Max bullet points
 * @returns {{ formatted: string, itemCount: number }}
 */
export function formatStructured(text, opts = {}) {
  const { numbered = false, maxItems = 10 } = opts;

  if (!text || typeof text !== 'string') {
    return { formatted: text || '', itemCount: 0 };
  }

  const sentences = splitSentences(text);

  // De-duplicate and cap
  const scores     = textRankScores(sentences);
  const indexed    = sentences.map((s, i) => ({ s, i, score: scores[i] }));
  indexed.sort((a, b) => b.score - a.score);

  const keptVecs = [];
  const items    = [];
  for (const { s, i } of indexed) {
    if (items.length >= maxItems) break;
    const vec = tfVec(tokenize(s));
    if (!isDuplicate(vec, keptVecs, 0.65)) {
      items.push({ s, i });
      keptVecs.push(vec);
    }
  }

  // Restore order
  items.sort((a, b) => a.i - b.i);

  const formatted = items
    .map(({ s }, idx) => `${numbered ? `${idx + 1}.` : '•'} ${s}`)
    .join('\n');

  return { formatted, itemCount: items.length };
}

/**
 * Strip filler phrases commonly found in LLM output preambles.
 * e.g. "Certainly! Here's...", "Of course! I'd be happy to..."
 *
 * @param {string} text
 * @returns {string}
 */
export function stripOutputPreamble(text) {
  if (!text) return text;
  return text
    .replace(/^(certainly|of course|sure|absolutely|great|no problem|happy to help|i'd be happy to|i can help with that)[!,.]\s*/i, '')
    .replace(/^(here('s| is|'s) (what i came up with|the answer|a (possible|potential|quick)|my (response|answer)):?\s*)/i, '')
    .replace(/^(let me (explain|show|walk you through|break this down|help you with))[^.!?]*[.!?]\s*/i, '')
    .trim();
}

export default { summarize, formatStructured, stripOutputPreamble };
