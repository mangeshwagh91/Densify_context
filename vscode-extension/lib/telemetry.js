// ─────────────────────────────────────────────────────────────────────────────
//  lib/telemetry.js  —  Observability + DevTools  (Phase 2.5)
//
//  PRODUCTION DESIGN:
//  - Zero overhead when disabled (all paths short-circuit immediately)
//  - Ring-buffer metrics store (fixed memory, no unbounded growth)
//  - Event batching with requestIdleCallback / setTimeout fallback
//  - Traces automatically trimmed to last 100 events
//  - Available as DensifyTelemetry global; exposed to popup devtools panel
//
//  Enable:  DensifyTelemetry.enable()
//  Disable: DensifyTelemetry.disable()  (default in production)
//
//  Memory cost when enabled:  ~15-40 KB (ring buffer of 200 events max)
//  Memory cost when disabled: 0 bytes additional (just a flag check)
// ─────────────────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const RING_CAP      = 200;  // max events stored
  const BATCH_DELAY   = 100;  // ms to batch events before flushing
  const METRIC_CAP    = 100;  // max timing samples per metric key

  // ── State ─────────────────────────────────────────────────────────────────
  let _enabled  = false;
  let _events   = [];       // ring buffer of trace events
  let _metrics  = {};       // key → {samples: number[], count, sum, min, max}
  let _counters = {};       // key → number
  let _batchQ   = [];       // pending events before flush
  let _flushTimer = null;
  let _sessionStart = Date.now();

  // ── Ring buffer push ──────────────────────────────────────────────────────
  function ringPush(arr, item, cap) {
    arr.push(item);
    if (arr.length > cap) arr.shift();
  }

  // ── Timer utilities ───────────────────────────────────────────────────────
  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  // ── Batch flush ───────────────────────────────────────────────────────────
  function scheduleFl() {
    if (_flushTimer) return;
    const idle = typeof requestIdleCallback !== 'undefined';
    if (idle) {
      requestIdleCallback(() => { flush(); _flushTimer = null; }, { timeout: 500 });
      _flushTimer = true;
    } else {
      _flushTimer = setTimeout(() => { flush(); _flushTimer = null; }, BATCH_DELAY);
    }
  }

  function flush() {
    if (!_batchQ.length) return;
    const batch = _batchQ.splice(0);
    for (const ev of batch) {
      ringPush(_events, ev, RING_CAP);
    }
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  const T = {

    /** Enable telemetry (call in development or when devtools panel opens). */
    enable()  { _enabled = true;  console.debug('[Densify Telemetry] Enabled'); },
    /** Disable telemetry (call in production). */
    disable() { _enabled = false; console.debug('[Densify Telemetry] Disabled'); },
    isEnabled() { return _enabled; },

    // ── Span API (latency tracing) ─────────────────────────────────────────

    /**
     * Start a named span. Returns a function that ends the span.
     * Usage:
     *   const end = T.span('tokenizer.countSync');
     *   // ... work ...
     *   end();  // records duration
     */
    span(name, meta) {
      if (!_enabled) return noop;
      const t0 = now();
      return function end(result) {
        const duration = now() - t0;
        T._recordTiming(name, duration);
        _batchQ.push({ type:'span', name, duration, meta: meta || null,
          ts: Date.now() - _sessionStart, result: result || null });
        scheduleFl();
      };
    },

    /**
     * Record a timing sample directly.
     * @param {string} key
     * @param {number} ms
     */
    _recordTiming(key, ms) {
      if (!_metrics[key]) {
        _metrics[key] = { samples:[], count:0, sum:0, min:Infinity, max:-Infinity };
      }
      const m = _metrics[key];
      if (m.samples.length >= METRIC_CAP) m.samples.shift();
      m.samples.push(ms);
      m.count++;
      m.sum += ms;
      if (ms < m.min) m.min = ms;
      if (ms > m.max) m.max = ms;
    },

    /** Measure a synchronous function. */
    measure(name, fn, meta) {
      if (!_enabled) return fn();
      const end = T.span(name, meta);
      const result = fn();
      end(typeof result === 'number' ? result : null);
      return result;
    },

    /** Measure an async function. */
    async measureAsync(name, fn, meta) {
      if (!_enabled) return fn();
      const end = T.span(name, meta);
      const result = await fn();
      end(typeof result === 'number' ? result : null);
      return result;
    },

    // ── Counter API ────────────────────────────────────────────────────────

    /** Increment a named counter. */
    count(key, delta) {
      if (!_enabled) return;
      _counters[key] = (_counters[key] || 0) + (delta || 1);
    },

    /** Get current counter value. */
    getCount(key) { return _counters[key] || 0; },

    // ── Event API ──────────────────────────────────────────────────────────

    /** Log a named event with optional payload. */
    event(name, data) {
      if (!_enabled) return;
      _batchQ.push({ type:'event', name, data: data || null, ts: Date.now() - _sessionStart });
      scheduleFl();
    },

    /** Log a warning (always recorded when enabled). */
    warn(name, message, data) {
      if (!_enabled) return;
      ringPush(_events, { type:'warn', name, message, data, ts: Date.now() - _sessionStart }, RING_CAP);
    },

    // ── Cache metrics ──────────────────────────────────────────────────────

    /** Record a cache hit or miss. */
    cacheResult(system, hit) {
      if (!_enabled) return;
      T.count(`${system}.cache.${hit ? 'hit' : 'miss'}`);
    },

    // ── Reports ────────────────────────────────────────────────────────────

    /**
     * Get performance report for all measured spans.
     * @returns {object[]} Sorted by average duration descending.
     */
    report() {
      flush();
      return Object.entries(_metrics)
        .map(([key, m]) => ({
          name:   key,
          count:  m.count,
          avg:    m.count ? parseFloat((m.sum / m.count).toFixed(3)) : 0,
          min:    m.min === Infinity ? 0 : parseFloat(m.min.toFixed(3)),
          max:    m.max === -Infinity ? 0 : parseFloat(m.max.toFixed(3)),
          p50:    _percentile(m.samples, 50),
          p95:    _percentile(m.samples, 95),
          p99:    _percentile(m.samples, 99),
        }))
        .sort((a, b) => b.avg - a.avg);
    },

    /** Get recent trace events. */
    events(limit) {
      flush();
      return _events.slice(-(limit || 50));
    },

    /** Get all counters. */
    counters() { return { ..._counters }; },

    /** Get cache hit-rate summary. */
    cacheStats() {
      const stats = {};
      for (const [key, val] of Object.entries(_counters)) {
        const m = key.match(/^(.+)\.cache\.(hit|miss)$/);
        if (!m) continue;
        if (!stats[m[1]]) stats[m[1]] = { hits:0, misses:0 };
        if (m[2] === 'hit') stats[m[1]].hits   += val;
        else                stats[m[1]].misses  += val;
      }
      // Compute hit rate
      for (const s of Object.values(stats)) {
        const total = s.hits + s.misses;
        s.hitRate = total ? parseFloat((s.hits / total).toFixed(3)) : 0;
        s.total   = total;
      }
      return stats;
    },

    /**
     * Full diagnostics snapshot — for devtools panel.
     * Returns JSON-serializable object.
     */
    snapshot() {
      return {
        enabled:     _enabled,
        sessionAge:  Date.now() - _sessionStart,
        spans:       T.report(),
        counters:    T.counters(),
        cacheStats:  T.cacheStats(),
        recentEvents: T.events(20),
      };
    },

    /** Reset all metrics (call between benchmark runs). */
    reset() {
      _events   = [];
      _metrics  = {};
      _counters = {};
      _batchQ   = [];
    },
  };

  function noop() {}

  function _percentile(sorted_samples, p) {
    if (!sorted_samples || sorted_samples.length === 0) return 0;
    const arr = sorted_samples.slice().sort((a,b) => a-b);
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return parseFloat(arr[Math.max(0, idx)].toFixed(3));
  }

  // ── Export ────────────────────────────────────────────────────────────────
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
  root.DensifyTelemetry = T;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
