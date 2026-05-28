// ─────────────────────────────────────────────────────────────────────────────
//  lib/worker-bridge.js  —  Worker communication layer for content script
//  v3 — Phase 3: adds embed-worker + compress-worker
//
//  Workers:
//    optimizer-worker.js — Layer 1+2 analysis (rules, structural, lint)
//    embed-worker.js     — TF-IDF semantic filter (Phase 3)
//    compress-worker.js  — Output summarizer (Phase 3)
//
//  All calls are Promise-based; heavy work stays off the main thread.
//  Fallback: if any worker fails, all calls use synchronous main-thread fallback.
// ─────────────────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  let _instance = null;
  let _msgId    = 0;

  // ── Timeouts per message type (ms) ─────────────────────────────────────────
  const TIMEOUTS = {
    PING:         2500,
    TOKENIZE:     1000,
    OPTIMIZE:     1500,
    LINT:         2000,
    ANALYZE:      2000,
    // Phase 3
    AST_ENCODE:    500,
    EMBED_FILTER: 1500,
    SUMMARIZE:    2000,
    FORMAT:       1500,
    STRIP_PREAMBLE: 500,
  };

  const MAX_RESTARTS = 3;

  class WorkerBridge {
    constructor() {
      this._worker       = null;   // optimizer worker
      this._embedWorker  = null;   // embed/filter worker (Phase 3)
      this._compWorker   = null;   // output compress worker (Phase 3)
      this._pending      = new Map();  // id → { resolve, reject, timer, type }
      this._ready        = false;
      this._fallback     = false;
      this._restarts     = 0;
      this._restarting   = false;

      // Request-superseding: track the latest ANALYZE request id
      // When a new ANALYZE arrives, the previous one is resolved with null
      // so the caller can detect staleness and discard it.
      this._latestAnalyzeId = null;

      this._init();
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    _init() {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
        console.debug('[Densify Worker] chrome.runtime unavailable — using main-thread fallback');
        this._fallback = true;
        return;
      }

      try {
        // ── Optimizer worker ────────────────────────────────────────────────
        const workerUrl = chrome.runtime.getURL('workers/optimizer-worker.js');
        this._worker = new Worker(workerUrl);
        this._worker.onmessage = (e) => this._onMessage(e);
        this._worker.onerror   = (e) => this._onError(e);

        this.ping().then(() => {
          this._ready      = true;
          this._restarting = false;
          console.debug('[Densify Worker] Optimizer ready');
        }).catch(() => {
          console.warn('[Densify Worker] Optimizer ping timed out — main-thread fallback');
          this._fallback = true;
        });

        // ── Embed worker (Phase 3) ──────────────────────────────────────────
        try {
          const embedUrl = chrome.runtime.getURL('workers/embed-worker.js');
          this._embedWorker = new Worker(embedUrl);
          this._embedWorker.onmessage = (e) => this._onMessage(e);
          this._embedWorker.onerror   = () => { this._embedWorker = null; };
          console.debug('[Densify Worker] Embed worker started');
        } catch (e) {
          console.debug('[Densify Worker] Embed worker unavailable:', e.message);
          this._embedWorker = null;
        }

        // ── Compress worker (Phase 3) ───────────────────────────────────────
        try {
          const compUrl = chrome.runtime.getURL('workers/compress-worker.js');
          this._compWorker = new Worker(compUrl);
          this._compWorker.onmessage = (e) => this._onMessage(e);
          this._compWorker.onerror   = () => { this._compWorker = null; };
          console.debug('[Densify Worker] Compress worker started');
        } catch (e) {
          console.debug('[Densify Worker] Compress worker unavailable:', e.message);
          this._compWorker = null;
        }

      } catch (e) {
        console.debug('[Densify Worker] Worker unavailable (' + e.message + ') — main-thread fallback');
        this._fallback = true;
      }
    }

    _onError(e) {
      console.warn('[Densify Worker] Error:', e.message);
      this._rejectAllPending('Worker error: ' + e.message);
      this._scheduleRestart();
    }

    _scheduleRestart() {
      if (this._restarts >= MAX_RESTARTS) {
        console.warn('[Densify Worker] Max restarts reached — permanent fallback');
        this._fallback = true;
        return;
      }
      if (this._restarting) return;
      this._restarting = true;
      this._ready      = false;

      const delay = 1000 * (this._restarts + 1); // 1s, 2s, 3s back-off
      setTimeout(() => {
        this._restarts++;
        console.debug(`[Densify Worker] Restarting (attempt ${this._restarts})`);
        if (this._worker) { try { this._worker.terminate(); } catch (_) {} }
        this._worker = null;
        this._init();
      }, delay);
    }

    _rejectAllPending(message) {
      for (const [id, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
      }
      this._pending.clear();
    }

    // ── Message handling ──────────────────────────────────────────────────────

    _onMessage(e) {
      const { id, result, error } = e.data;
      const pending = this._pending.get(id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this._pending.delete(id);

      if (error) pending.reject(new Error(error));
      else       pending.resolve(result);
    }

    // ── Core send ─────────────────────────────────────────────────────────────

    /** Pick the right worker for the message type. */
    _workerFor(type) {
      if (['EMBED_FILTER','SIMILARITY','SCORE'].includes(type)) return this._embedWorker;
      if (['SUMMARIZE','FORMAT','STRIP_PREAMBLE'].includes(type)) return this._compWorker;
      return this._worker;
    }

    _send(type, text, options, timeoutMs) {
      timeoutMs = timeoutMs || TIMEOUTS[type] || 2000;

      const worker = this._workerFor(type);

      // Fallback: run on main thread synchronously
      if (this._fallback || !worker) {
        return Promise.resolve(this._mainThreadFallback(type, text, options));
      }

      const id = ++_msgId;

      // ── Request superseding for ANALYZE ────────────────────────────────────
      // If a previous ANALYZE is in-flight, supersede it: resolve with a
      // sentinel { _superseded: true } so the caller can discard it cheaply.
      if (type === 'ANALYZE') {
        const prevId = this._latestAnalyzeId;
        if (prevId !== null && this._pending.has(prevId)) {
          const prev = this._pending.get(prevId);
          clearTimeout(prev.timer);
          this._pending.delete(prevId);
          prev.resolve({ _superseded: true });
        }
        this._latestAnalyzeId = id;
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id);
          if (type === 'ANALYZE' && this._latestAnalyzeId === id) {
            this._latestAnalyzeId = null;
          }
          // On timeout, gracefully fall back to main thread
          resolve(this._mainThreadFallback(type, text, options));
        }, timeoutMs);

        this._pending.set(id, { resolve, reject, timer, type });
        worker.postMessage({ id, type, text, options });
      });
    }

    // ── Main-thread fallback ──────────────────────────────────────────────────

    _mainThreadFallback(type, text, options) {
      const eng  = root.DensifyEngine;
      const tok  = root.DensifyTokenizer;
      const lint = root.DensifyLint;
      const ast  = root.DensifyAST;

      switch (type) {
        case 'PING':     return { pong: true };
        case 'TOKENIZE': return { tokens: tok ? tok.countSync(text, options?.model) : 0 };
        case 'OPTIMIZE': return eng ? eng.optimizePrompt(text, options) : { optimized: text };
        case 'LINT':     return lint
          ? { diagnostics: lint.lint(text, options), summary: lint.summarize([]) }
          : { diagnostics: [], summary: {} };

        case 'ANALYZE': {
          const sug = eng  ? eng.getSuggestions(text, options?.model) : [];
          const lnt = lint ? lint.lint(text, options) : [];
          const tokBefore = tok ? tok.countSync(text, options?.model) : 0;
          return { suggestions: sug, lint: lnt, structural: [], conflicts: [],
                   tokensBefore: tokBefore, tokensAfter: tokBefore, tokensSaved: 0 };
        }

        // ── Phase 3 fallbacks ────────────────────────────────────────────────
        case 'AST_ENCODE': {
          if (!ast) return { compressed: text, tokensSaved: 0, ratio: 0 };
          return ast.compress(text);
        }

        case 'EMBED_FILTER': {
          // Simple fallback: no filtering, return as-is
          return { filtered: text, dropped: 0, scores: [], ratio: 0 };
        }

        case 'SUMMARIZE': {
          // Simple extractive fallback: keep first 50% of sentences
          const sents  = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 10);
          const keep   = Math.max(2, Math.ceil(sents.length * ((options?.ratio) || 0.5)));
          const summary = sents.slice(0, keep).join(' ').trim();
          const saved   = Math.max(0, Math.ceil(text.length / 4) - Math.ceil(summary.length / 4));
          return { summary, tokensSaved: saved, ratio: parseFloat(((sents.length - keep) / (sents.length || 1)).toFixed(3)), dropped: sents.length - keep };
        }

        case 'FORMAT': {
          const sents2 = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 10).slice(0, options?.maxItems || 10);
          const formatted = sents2.map((s, i) => `${options?.numbered ? `${i+1}.` : '•'} ${s}`).join('\n');
          return { formatted, itemCount: sents2.length };
        }

        case 'STRIP_PREAMBLE': {
          const stripped = text
            .replace(/^(certainly|of course|sure|absolutely|great|no problem|happy to help|i'd be happy to)[!,.] */i, '')
            .replace(/^(here('s| is) (the answer|what i came up with):?\s*)/i, '')
            .trim();
          return { stripped };
        }

        default: return null;
      }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    ping()                  { return this._send('PING',     '', null); }
    tokenize(text, model)   { return this._send('TOKENIZE', text, { model }); }
    optimize(text, options) { return this._send('OPTIMIZE', text, options); }
    lint(text, options)     { return this._send('LINT',     text, options); }

    /**
     * Full Layer 2 analysis: suggestions + lint + structural + tokens.
     * Supersedes any in-flight ANALYZE automatically.
     */
    analyze(text, options)  { return this._send('ANALYZE',  text, options); }

    // ── Phase 3 API ───────────────────────────────────────────────────────────

    /** AST/DSL encode: compress verbose prompt to dense natural language. */
    astEncode(text)                   { return this._send('AST_ENCODE',    text, null); }

    /** Semantic sentence filter: drop low-relevance sentences. */
    embedFilter(text, query, thresh)  { return this._send('EMBED_FILTER',  text, { query, threshold: thresh }); }

    /** Extractive output summarization. */
    summarize(text, options)          { return this._send('SUMMARIZE',     text, options); }

    /** Format prose as bullet / numbered list. */
    formatOutput(text, options)       { return this._send('FORMAT',        text, options); }

    /** Strip LLM output preamble filler. */
    stripPreamble(text)               { return this._send('STRIP_PREAMBLE', text, null); }

    /** True once the optimizer worker has responded to its first PING. */
    isReady()    { return this._ready; }

    /** True when the optimizer worker is permanently unavailable. */
    isFallback() { return this._fallback; }

    terminate() {
      if (this._worker)      { this._worker.terminate();      this._worker = null; }
      if (this._embedWorker) { this._embedWorker.terminate(); this._embedWorker = null; }
      if (this._compWorker)  { this._compWorker.terminate();  this._compWorker = null; }
      this._rejectAllPending('Bridge terminated');
    }

    static getInstance() {
      if (!_instance) _instance = new WorkerBridge();
      return _instance;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  if (typeof module !== 'undefined' && module.exports) module.exports = { WorkerBridge };
  root.DensifyWorkerBridge = WorkerBridge;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
