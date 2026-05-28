// ─────────────────────────────────────────────────────────────────────────────
//  browser-extension/workers/embed-worker.js
//  WebWorker: Embedding / semantic filter worker.
//
//  Message protocol (postMessage):
//    Main → Worker: { id, type, text, query, threshold }
//    Worker → Main: { id, type, result, error? }
//
//  Message types:
//    'FILTER'     → { filtered, dropped, scores, ratio }
//    'SIMILARITY' → { similarity }
//    'SCORE'      → { score }
//    'PING'       → { pong: true }
//
//  v1: TF-IDF cosine similarity (no ONNX required)
//  v2 upgrade: swap scoreSentence() with ONNX MiniLM without changing API
// ─────────────────────────────────────────────────────────────────────────────

// Load engine libs via importScripts
try {
  self.importScripts('../lib/ast-encoder.js');
} catch (e) {
  console.warn('[EmbedWorker] Could not load ast-encoder:', e.message);
}

// ── Inline TF-IDF (self-contained, no external deps) ─────────────────────────

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
  const total = tokens.length || 1;
  for (const [k, val] of v) v.set(k, val / total);
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
  return text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 5);
}

const PROTECTED_RE = /\b(not|never|no|without|except|unless|neither|nor|don't|doesn't|won't|can't|shouldn't)\b|\b\d+\b/i;

function filterSentences(text, query, threshold) {
  threshold = threshold || 0.08;
  const sentences = splitSentences(text);
  if (sentences.length <= 2) return { filtered: text, dropped: 0, scores: [1], ratio: 0 };

  const queryTF = tfVec(tokenize(query || text));
  const scores  = [];
  const kept    = [];
  let   dropped = 0;

  for (const s of sentences) {
    const score = cosineSim(tfVec(tokenize(s)), queryTF);
    scores.push(parseFloat(score.toFixed(3)));
    if (score >= threshold || PROTECTED_RE.test(s)) {
      kept.push(s);
    } else {
      dropped++;
    }
  }

  const filtered = kept.join(' ').replace(/\s+/g, ' ').trim();
  return { filtered, dropped, scores, ratio: parseFloat((dropped / sentences.length).toFixed(3)) };
}

function semanticSimilarity(textA, textB) {
  return parseFloat(cosineSim(tfVec(tokenize(textA || '')), tfVec(tokenize(textB || ''))).toFixed(3));
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { id, type, text, query, threshold, textB } = e.data;

  try {
    switch (type) {
      case 'PING':
        self.postMessage({ id, type: 'PING', result: { pong: true } });
        break;

      case 'FILTER': {
        const result = filterSentences(text, query, threshold);
        self.postMessage({ id, type: 'FILTER', result });
        break;
      }

      case 'SIMILARITY': {
        const similarity = semanticSimilarity(text, textB);
        self.postMessage({ id, type: 'SIMILARITY', result: { similarity } });
        break;
      }

      case 'SCORE': {
        const qTF   = tfVec(tokenize(query || ''));
        const sTF   = tfVec(tokenize(text || ''));
        const score = parseFloat(cosineSim(sTF, qTF).toFixed(3));
        self.postMessage({ id, type: 'SCORE', result: { score } });
        break;
      }

      default:
        self.postMessage({ id, type: 'ERROR', error: `Unknown type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, type: 'ERROR', error: err.message || String(err) });
  }
};

console.debug('[EmbedWorker] TF-IDF filter worker ready');
