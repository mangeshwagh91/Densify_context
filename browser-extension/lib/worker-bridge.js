// ─────────────────────────────────────────────────────────────────────────────
//  lib/worker-bridge.js  —  Worker communication layer for content script
//
//  Creates and manages the persistent optimizer Web Worker.
//  Exposes a Promise-based API — callers never touch postMessage directly.
//
//  Usage:
//    const bridge = DensifyWorkerBridge.getInstance();
//    bridge.analyze(text, { model:'gpt-4o' }).then(result => { ... });
//
//  Thread model:
//    Content script (main thread) → WorkerBridge → Worker → result
//    Layer 1 analysis still happens synchronously on main thread (<2ms)
//    Layer 2 analysis happens in worker, result delivered via promise
//
//  Improvements (v2):
//    - Shorter timeouts: ANALYZE 2s, OPTIMIZE 1.5s, TOKENIZE 1s
//    - Request superseding: stale in-flight ANALYZE requests are auto-cancelled
//      when a newer one arrives (avoids overwriting newer results with older)
//    - Worker auto-restart: if onerror fires, retries _init() up to 3 times
//    - isReady() / isFallback() health-check getters for UI feedback
//    - Pending map cleared atomically on worker restart
//
//  Fallback: if Worker fails to load, all calls fall back to main-thread engine
// ─────────────────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  let _instance = null;
  let _msgId    = 0;

  // ── Timeouts per message type (ms) ─────────────────────────────────────────
  const TIMEOUTS = {
    PING:     2500,   // generous — importScripts can take a moment on first load
    TOKENIZE: 1000,
    OPTIMIZE: 1500,
    LINT:     2000,
    ANALYZE:  2000,
  };

  const MAX_RESTARTS = 3;

  class WorkerBridge {
    constructor() {
      this._worker       = null;
      this._pending      = new Map();  // id → { resolve, reject, timer, type }
      this._ready        = false;
      this._fallback     = false;      // true when worker failed permanently
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
      // Guard: chrome.runtime may not be fully available in all frame contexts
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
        console.debug('[Densify Worker] chrome.runtime unavailable — using main-thread fallback');
        this._fallback = true;
        return;
      }

      try {
        const workerUrl = chrome.runtime.getURL('workers/optimizer-worker.js');
        this._worker = new Worker(workerUrl);

        this._worker.onmessage = (e) => this._onMessage(e);
        this._worker.onerror   = (e) => this._onError(e);

        // Ping to confirm worker is alive.
        // On failure we simply fall back to main-thread — NO restart here.
        // _scheduleRestart() is reserved for hard onerror crashes only.
        this.ping().then(() => {
          this._ready      = true;
          this._restarting = false;
          console.debug('[Densify Worker] Ready');
        }).catch((err) => {
          console.warn('[Densify Worker] Ping timed out — using main-thread fallback');
          this._fallback = true;  // safe; all future calls use _mainThreadFallback()
        });

      } catch (e) {
        // Worker constructor failed (e.g. CSP, invalid URL, sandboxed frame).
        // Fall back silently — the extension still works on the main thread.
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

    _send(type, text, options, timeoutMs) {
      timeoutMs = timeoutMs || TIMEOUTS[type] || 2000;

      // Fallback: run on main thread synchronously
      if (this._fallback || !this._worker) {
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
        this._worker.postMessage({ id, type, text, options });
      });
    }

    // ── Main-thread fallback ──────────────────────────────────────────────────

    _mainThreadFallback(type, text, options) {
      const eng  = root.DensifyEngine;
      const tok  = root.DensifyTokenizer;
      const lint = root.DensifyLint;

      switch (type) {
        case 'PING':     return { pong: true };
        case 'TOKENIZE': return { tokens: tok ? tok.countSync(text, options?.model) : 0 };
        case 'OPTIMIZE': return eng ? eng.optimizePrompt(text, options) : { optimized: text };
        case 'LINT':     return lint
          ? { diagnostics: lint.lint(text, options), summary: lint.summarize([]) }
          : { diagnostics: [], summary: {} };
        case 'ANALYZE': {
          const sug      = eng  ? eng.getSuggestions(text, options?.model) : [];
          const lnt      = lint ? lint.lint(text, options) : [];
          const tokBefore = tok ? tok.countSync(text, options?.model) : 0;
          return {
            suggestions:  sug,
            lint:         lnt,
            structural:   [],
            conflicts:    [],
            tokensBefore: tokBefore,
            tokensAfter:  tokBefore,
            tokensSaved:  0,
          };
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
     * Supersedes any in-flight ANALYZE automatically — callers must check
     * result._superseded === true and discard it.
     */
    analyze(text, options)  { return this._send('ANALYZE',  text, options); }

    /** True once the worker has responded to its first PING. */
    isReady()    { return this._ready; }

    /** True when the worker is permanently unavailable (all calls use fallback). */
    isFallback() { return this._fallback; }

    terminate() {
      if (this._worker) { this._worker.terminate(); this._worker = null; }
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
