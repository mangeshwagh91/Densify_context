// ─────────────────────────────────────────────────────────────────────────────
//  packages/embedding-filter/index.js
//  Semantic sentence filter using TF-IDF cosine similarity.
//
//  No external dependencies, no ONNX model required for v1.
//  Each sentence gets a relevance score against the query intent.
//  Sentences below the threshold are dropped (but protected tokens are kept).
//
//  v2 upgrade path: swap scoreSentence() with an ONNX MiniLM embedding
//  without changing the public API.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Stopwords (English) ───────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'i','you','he','she','it','we','they','me','him','her','us','them',
  'my','your','his','its','our','their','this','that','these','those',
  'what','which','who','whom','whose','when','where','why','how',
  'all','each','every','both','few','more','most','other','some','such',
  'not','only','own','same','so','than','too','very','just','into','up',
  'about','above','after','as','before','between','during','if','then',
]);

// ── Tokenise to terms (lowercase, no stopwords) ───────────────────────────────

function tokenize(text) {
  return (text.toLowerCase().match(/\b[a-z]{2,}\b/g) || [])
    .filter(w => !STOPWORDS.has(w));
}

// ── TF (term frequency within a document) ────────────────────────────────────

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const total = tokens.length || 1;
  for (const [k, v] of tf) tf.set(k, v / total);
  return tf;
}

// ── Cosine similarity between two TF maps ────────────────────────────────────

function cosineSim(tfA, tfB) {
  let dot = 0, normA = 0, normB = 0;
  for (const [term, wA] of tfA) {
    normA += wA * wA;
    const wB = tfB.get(term) || 0;
    dot += wA * wB;
  }
  for (const [, wB] of tfB) normB += wB * wB;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Sentence splitter ─────────────────────────────────────────────────────────

function splitSentences(text) {
  // Split on sentence boundaries, keeping the delimiter
  const raw = text.split(/(?<=[.!?])\s+/);
  // Also split on newlines (treat paragraphs as separate units)
  const result = [];
  for (const s of raw) {
    const lines = s.split(/\n+/).map(l => l.trim()).filter(Boolean);
    result.push(...lines);
  }
  return result.filter(s => s.length > 0);
}

// ── Protected token check ─────────────────────────────────────────────────────
// A sentence is "protected" if it contains negations or numbers —
// we never drop it regardless of score.

const PROTECTED_RE = /\b(not|never|no|without|except|unless|neither|nor|don't|doesn't|won't|can't|shouldn't)\b|\b\d+\b/i;

function isProtected(sentence) {
  return PROTECTED_RE.test(sentence);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score each sentence for relevance to query intent using TF-IDF cosine sim.
 *
 * @param {string} text       - Input prompt (possibly multi-sentence)
 * @param {string} query      - The core query/intent to score against
 * @param {number} threshold  - 0–1; sentences below this are dropped (default 0.08)
 * @returns {{ filtered: string, dropped: number, scores: number[], ratio: number }}
 */
export function filterSentences(text, query, threshold = 0.08) {
  if (!text || typeof text !== 'string') {
    return { filtered: text || '', dropped: 0, scores: [], ratio: 0 };
  }

  const sentences = splitSentences(text);

  // With 1–2 sentences, no filtering needed
  if (sentences.length <= 2) {
    return { filtered: text, dropped: 0, scores: [1], ratio: 0 };
  }

  const queryTF  = termFreq(tokenize(query || text));
  const scores   = [];
  const kept     = [];
  let   dropped  = 0;

  for (const sentence of sentences) {
    const sentTF  = termFreq(tokenize(sentence));
    const score   = cosineSim(sentTF, queryTF);
    scores.push(parseFloat(score.toFixed(3)));

    if (score >= threshold || isProtected(sentence)) {
      kept.push(sentence);
    } else {
      dropped++;
    }
  }

  const filtered = kept.join(' ').replace(/\s+/g, ' ').trim();
  const ratio    = parseFloat((dropped / sentences.length).toFixed(3));

  return { filtered, dropped, scores, ratio };
}

/**
 * Score a single sentence against a reference query (0–1).
 * Useful for ranking/sorting rather than filtering.
 *
 * @param {string} sentence
 * @param {string} query
 * @returns {number}
 */
export function scoreSentence(sentence, query) {
  const sTF = termFreq(tokenize(sentence));
  const qTF = termFreq(tokenize(query));
  return parseFloat(cosineSim(sTF, qTF).toFixed(3));
}

/**
 * Compute cosine similarity between two arbitrary texts (0–1).
 * Used by the benchmark suite and telemetry.
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {number}
 */
export function semanticSimilarity(textA, textB) {
  const tfA = termFreq(tokenize(textA || ''));
  const tfB = termFreq(tokenize(textB || ''));
  return parseFloat(cosineSim(tfA, tfB).toFixed(3));
}

export default { filterSentences, scoreSentence, semanticSimilarity };
