// ─────────────────────────────────────────────────────────────────────────────
//  workers/optimizer-worker.js  —  Browser Extension Web Worker  (Phase 3)
//
//  Runs in a dedicated Web Worker, completely off the main UI thread.
//  Handles Layer 2 analysis that is too heavy for inline execution:
//    - Structural redundancy detection (Jaccard similarity)
//    - Conflict detection (opposing instructions)
//    - Full lint engine analysis
//    - Accurate async token counting
//
//  Communication protocol (postMessage):
//    Main → Worker: { id, type, text, options }
//    Worker → Main: { id, type, result, error? }
//
//  Message types:
//    'ANALYZE'   → { suggestions, lint, structural, tokensBefore, tokensAfter }
//    'TOKENIZE'  → { tokens }
//    'OPTIMIZE'  → { optimized, changes, savings }
//    'PING'      → { pong: true }
//
//  Performance:
//    - Worker is persistent (created once at content script load)
//    - Messages are queued; in-flight requests identified by id
//    - Responds within <100ms for typical 500-token prompts
// ─────────────────────────────────────────────────────────────────────────────

// Load engine libs via importScripts (synchronous in workers)
// Paths are relative to the extension root when loaded via chrome.runtime.getURL
try {
  self.importScripts(
    '../lib/tokenizer.js',
    '../lib/confidence.js',
    '../lib/rules-registry.js',
    '../lib/lint-engine.js',
    '../lib/densify-engine.js',
  );
} catch (e) {
  self.postMessage({ type: 'ERROR', error: 'Failed to load engine libs: ' + e.message });
}

const Engine   = self.DensifyEngine;
const Tok      = self.DensifyTokenizer;
const Lint     = self.DensifyLint;

// ── Structural analysis (Layer 2) ────────────────────────────────────────────

function jaccard(setA, setB) {
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter || 1);
}

function structTokens(text) {
  return new Set((text.toLowerCase().match(/\b[a-z]{4,}\b/g) || []));
}

function findRedundantSentences(text) {
  const sents = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 15);
  const toks  = sents.map(s => structTokens(s));
  const results = [];

  for (let i = 0; i < sents.length; i++) {
    for (let j = i + 1; j < sents.length; j++) {
      const sim = jaccard(toks[i], toks[j]);
      if (sim >= 0.55) {
        results.push({
          type:        'structural_duplicate',
          sentence1:   sents[i].slice(0, 80),
          sentence2:   sents[j].slice(0, 80),
          similarity:  parseFloat(sim.toFixed(2)),
          suggestion:  `Sentence ${j+1} is ${Math.round(sim*100)}% similar to sentence ${i+1} — consider removing`,
          tokensSaved: Tok ? Tok.countSync(sents[j]) : 0,
        });
      }
    }
  }
  return results;
}

function detectConflicts(text) {
  const tl = text.toLowerCase();
  const PAIRS = [
    [['brief','concise','short','tldr'], ['comprehensive','detailed','thorough','extensive']],
    [['simple','beginner','basic'],       ['advanced','expert','complex','technical']],
    [['formal','professional'],           ['casual','informal','conversational']],
  ];

  const conflicts = [];
  for (const [a, b] of PAIRS) {
    const hasA = a.find(w => tl.includes(w));
    const hasB = b.find(w => tl.includes(w));
    if (hasA && hasB) {
      conflicts.push({
        type:    'conflicting_instructions',
        termA:   hasA,
        termB:   hasB,
        message: `Conflicting instructions: "${hasA}" vs "${hasB}"`,
      });
    }
  }
  return conflicts;
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { id, type, text, options } = e.data;

  try {
    switch (type) {

      case 'PING':
        self.postMessage({ id, type: 'PING', result: { pong: true } });
        break;

      case 'ANALYZE': {
        // Layer 1 (rule engine)
        const optimized   = Engine ? Engine.optimizePrompt(text, options) : null;
        // Layer 1 suggestions
        const suggestions = Engine ? Engine.getSuggestions(text, options?.model) : [];
        // Layer 2: structural analysis
        const structural  = findRedundantSentences(text);
        const conflicts   = detectConflicts(text);
        // Layer 2: lint engine
        const lint        = Lint ? Lint.lint(text, options) : [];
        // Token counts
        const tokensBefore = Tok ? Tok.countSync(text, options?.model) : 0;
        const tokensAfter  = optimized ? (Tok ? Tok.countSync(optimized.optimized, options?.model) : 0) : tokensBefore;

        self.postMessage({
          id, type: 'ANALYZE',
          result: {
            suggestions,
            lint,
            structural,
            conflicts,
            tokensBefore,
            tokensAfter,
            tokensSaved: tokensBefore - tokensAfter,
            optimized:   optimized?.optimized,
            savings:     optimized?.savings,
          }
        });
        break;
      }

      case 'TOKENIZE': {
        const tokens = Tok ? Tok.countSync(text, options?.model) : 0;
        self.postMessage({ id, type: 'TOKENIZE', result: { tokens } });
        break;
      }

      case 'OPTIMIZE': {
        const result = Engine ? Engine.optimizePrompt(text, options) : null;
        self.postMessage({ id, type: 'OPTIMIZE', result });
        break;
      }

      case 'LINT': {
        const diags = Lint ? Lint.lint(text, options) : [];
        const summary = Lint ? Lint.summarize(diags) : {};
        self.postMessage({ id, type: 'LINT', result: { diagnostics: diags, summary } });
        break;
      }

      default:
        self.postMessage({ id, type: 'ERROR', error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, type: 'ERROR', error: err.message || String(err) });
  }
};
