// ─────────────────────────────────────────────────────────────────────────────
//  browser-extension/workers/compress-worker.js
//  WebWorker: Output compression / summarization worker.
//
//  Message protocol (postMessage):
//    Main → Worker: { id, type, text, options }
//    Worker → Main: { id, type, result, error? }
//
//  Message types:
//    'SUMMARIZE'      → { summary, tokensSaved, ratio, dropped }
//    'FORMAT'         → { formatted, itemCount }
//    'STRIP_PREAMBLE' → { stripped }
//    'PING'           → { pong: true }
// ─────────────────────────────────────────────────────────────────────────────

// ── Inline TextRank summarizer (no external deps) ─────────────────────────────

const STOP = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','have','has','had','do','does',
  'did','will','would','could','should','i','you','he','she','it','we','they',
  'this','that','these','those','not','so','than','too','just','up','about',
]);

function tokenize(text) {
  return (text.toLowerCase().match(/\b[a-z]{2,}\b/g) || []).filter(w => !STOP.has(w));
}

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

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+|\n{2,}/).map(s => s.trim()).filter(s => s.length > 10);
}

function textRankScores(sentences) {
  const vecs = sentences.map(s => tfVec(tokenize(s)));
  return sentences.map((_, i) => {
    let total = 0;
    for (let j = 0; j < sentences.length; j++) {
      if (i !== j) total += cosineSim(vecs[i], vecs[j]);
    }
    return total / Math.max(1, sentences.length - 1);
  });
}

function isDuplicate(vec, keptVecs, thresh) {
  return keptVecs.some(kv => cosineSim(vec, kv) >= thresh);
}

function summarize(text, opts) {
  opts = opts || {};
  const ratio        = opts.ratio        || 0.5;
  const minSentences = opts.minSentences || 2;
  const dupThreshold = opts.dupThreshold || 0.70;
  const preserveOrder = opts.preserveOrder !== false;

  if (!text) return { summary: text || '', tokensSaved: 0, ratio: 0, dropped: 0 };

  const sentences = splitSentences(text);
  if (sentences.length <= minSentences) return { summary: text, tokensSaved: 0, ratio: 0, dropped: 0 };

  const scores  = textRankScores(sentences);
  const target  = Math.max(minSentences, Math.ceil(sentences.length * ratio));
  const indexed = sentences.map((s, i) => ({ s, i, score: scores[i] }));
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

  const keptSentences = preserveOrder
    ? sentences.filter((_, i) => keptIdx.has(i))
    : [...keptIdx].sort().map(i => sentences[i]);

  const summary     = keptSentences.join(' ').trim();
  const dropped     = sentences.length - keptSentences.length;
  const origTokens  = Math.ceil(text.length / 4);
  const summTokens  = Math.ceil(summary.length / 4);
  const tokensSaved = Math.max(0, origTokens - summTokens);
  const ratioOut    = parseFloat((dropped / sentences.length).toFixed(3));

  return { summary, tokensSaved, ratio: ratioOut, dropped };
}

function formatStructured(text, opts) {
  opts = opts || {};
  const numbered = opts.numbered || false;
  const maxItems = opts.maxItems || 10;

  if (!text) return { formatted: text || '', itemCount: 0 };

  const sentences = splitSentences(text);
  const scores    = textRankScores(sentences);
  const indexed   = sentences.map((s, i) => ({ s, i, score: scores[i] }));
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
  items.sort((a, b) => a.i - b.i);

  const formatted = items.map(({ s }, idx) => `${numbered ? `${idx + 1}.` : '•'} ${s}`).join('\n');
  return { formatted, itemCount: items.length };
}

function stripOutputPreamble(text) {
  if (!text) return text;
  return text
    .replace(/^(certainly|of course|sure|absolutely|great|no problem|happy to help|i'd be happy to|i can help with that)[!,.]\s*/i, '')
    .replace(/^(here('s| is|'s) (what i came up with|the answer|a (possible|potential|quick)|my (response|answer)):?\s*)/i, '')
    .replace(/^(let me (explain|show|walk you through|break this down|help you with))[^.!?]*[.!?]\s*/i, '')
    .trim();
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { id, type, text, options } = e.data;

  try {
    switch (type) {
      case 'PING':
        self.postMessage({ id, type: 'PING', result: { pong: true } });
        break;

      case 'SUMMARIZE': {
        const result = summarize(text, options);
        self.postMessage({ id, type: 'SUMMARIZE', result });
        break;
      }

      case 'FORMAT': {
        const result = formatStructured(text, options);
        self.postMessage({ id, type: 'FORMAT', result });
        break;
      }

      case 'STRIP_PREAMBLE': {
        const stripped = stripOutputPreamble(text);
        self.postMessage({ id, type: 'STRIP_PREAMBLE', result: { stripped } });
        break;
      }

      default:
        self.postMessage({ id, type: 'ERROR', error: `Unknown type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, type: 'ERROR', error: err.message || String(err) });
  }
};

console.debug('[CompressWorker] Output optimizer worker ready');
