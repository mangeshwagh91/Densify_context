// ─────────────────────────────────────────────────────────
//  optimizer.test.js — Comprehensive tests for Phase 1
// ─────────────────────────────────────────────────────────

import { jest } from '@jest/globals';
import { optimizePrompt } from '../src/optimizer.js';
import { countTokens, estimateSavings, availableModels } from '../src/tokenizer.js';
import { getSuggestions, applySuggestions } from '../src/suggestions.js';

// ═════════════════════════════════════════════════════════
//  optimizePrompt()
// ═════════════════════════════════════════════════════════

describe('optimizePrompt', () => {

  // ── Example 1: Verbose ChatGPT prompt ─────────────
  test('compresses a verbose ChatGPT-style prompt', () => {
    const input =
      'Hello, I would like you to please provide me with a comprehensive ' +
      'explanation of how neural networks work. It is important to note that ' +
      'I am a beginner. Thank you very much!';

    const result = optimizePrompt(input);

    expect(result.optimized.length).toBeLessThan(input.length);
    expect(result.savings.saved).toBeGreaterThan(0);
    expect(result.savings.percentage).toBeGreaterThan(0);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.optimized).not.toContain('Hello');
    expect(result.optimized).not.toContain('Thank you very much');
    expect(result.optimized).not.toContain('It is important to note that');
  });

  // ── Example 2: Wordy instruction ──────────────────
  test('replaces verbose phrases with concise alternatives', () => {
    const input =
      'In order to achieve the best results, it is necessary to ' +
      'take into consideration a large number of factors.';

    const result = optimizePrompt(input);

    expect(result.optimized).toContain('to');
    expect(result.optimized).not.toContain('In order to');
    expect(result.optimized).not.toContain('take into consideration');
    expect(result.optimized).not.toContain('a large number of');
    expect(result.savings.saved).toBeGreaterThan(5);
  });

  // ── Example 3: Filler words ───────────────────────
  test('removes filler words', () => {
    const input =
      'I basically just really need you to simply explain how databases actually work.';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toMatch(/\bbasically\b/i);
    expect(result.optimized).not.toMatch(/\bjust\b/i);
    expect(result.optimized).not.toMatch(/\breally\b/i);
    expect(result.optimized).not.toMatch(/\bsimply\b/i);
    expect(result.optimized).not.toMatch(/\bactually\b/i);
  });

  // ── Example 4: Redundant modifiers ────────────────
  test('removes redundant modifiers', () => {
    const input =
      'I need a completely unique solution that gives the end result ' +
      'and the final outcome.';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toContain('completely unique');
    expect(result.optimized).toContain('unique');
    expect(result.optimized).not.toContain('end result');
    expect(result.optimized).not.toContain('final outcome');
  });

  // ── Example 5: Prompt ceremony (greetings/closings)
  test('strips prompt ceremony', () => {
    const input =
      'Hi! Can you please help me write a Python function? Thanks in advance!';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toMatch(/^Hi/);
    expect(result.optimized).not.toContain('Thanks in advance');
    expect(result.optimized).toContain('Python function');
  });

  // ── Example 6: Conditional verbosity ──────────────
  test('compresses conditional phrases', () => {
    const input =
      'In the event that the server fails, due to the fact that ' +
      'there is a bug, you should revert back the changes.';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toContain('In the event that');
    expect(result.optimized).not.toContain('due to the fact that');
    expect(result.optimized).not.toContain('revert back');
  });

  // ── Example 7: Time-related verbosity ─────────────
  test('compresses time-related phrases', () => {
    const input =
      'At this point in time, prior to the deployment, we need ' +
      'to make a decision about the architecture.';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toContain('At this point in time');
    expect(result.optimized).not.toContain('prior to');
    expect(result.optimized).not.toContain('make a decision');
  });

  // ── Example 8: Mixed verbosity ────────────────────
  test('handles mixed verbosity types in one prompt', () => {
    const input =
      'Good morning! I was wondering if you could help me. ' +
      'In order to understand the problem, it is essential that ' +
      'we take into account the past history of the system. ' +
      'It is worth mentioning that this is absolutely essential. ' +
      'Thank you so much!';

    const result = optimizePrompt(input);

    expect(result.savings.percentage).toBeGreaterThan(20);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  // ── Example 9: Already concise prompt ─────────────
  test('leaves already-concise prompts mostly unchanged', () => {
    const input = 'Write a Python sort function.';

    const result = optimizePrompt(input);

    // Should be the same or very close
    expect(result.optimized.length).toBeLessThanOrEqual(input.length + 5);
    expect(result.savings.percentage).toBeLessThan(30);
  });

  // ── Example 10: Empty / null input ────────────────
  test('handles empty and null input gracefully', () => {
    expect(optimizePrompt('').optimized).toBe('');
    expect(optimizePrompt(null).optimized).toBe('');
    expect(optimizePrompt(undefined).optimized).toBe('');
  });

  // ── Example 11: Long prompt with multiple issues ──
  test('achieves >25% savings on a truly verbose prompt', () => {
    const input =
      'Hello, I would appreciate it if you could help me with the following. ' +
      'I have a question: I would like to know whether or not it is possible to ' +
      'create a system that is able to handle a large number of requests on a daily basis. ' +
      'Due to the fact that our current system has a tendency to fail, ' +
      'it is necessary to build something that is completely unique. ' +
      'In addition to this, the system should take into consideration ' +
      'a variety of factors. Thank you in advance!';

    const result = optimizePrompt(input);

    expect(result.savings.percentage).toBeGreaterThan(25);
    expect(result.changes.length).toBeGreaterThan(8);
  });

  // ── Example 12: Code prompt preservation ──────────
  test('does not mangle code content', () => {
    const input = 'Fix this function:\n```\nfunction add(a, b) { return a + b; }\n```';

    const result = optimizePrompt(input);

    expect(result.optimized).toContain('function add(a, b) { return a + b; }');
  });

  // ── Example 13: Options — disable filler removal ──
  test('respects options to disable specific rules', () => {
    const input = 'I basically just need a very simple answer.';

    const withFiller = optimizePrompt(input, { removeFiller: false });
    const withoutFiller = optimizePrompt(input, { removeFiller: true });

    // With filler removal disabled, "basically" etc. should remain
    expect(withFiller.optimized).toContain('basically');
    expect(withoutFiller.optimized).not.toMatch(/\bbasically\b/i);
  });

  // ── Example 14: Whitespace normalization ──────────
  test('normalizes excessive whitespace', () => {
    const input = 'Explain   how    databases   work.\n\n\n\nInclude examples.';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toMatch(/  +/); // no double spaces
    expect(result.optimized).not.toMatch(/\n{3,}/); // max 2 newlines
  });

  // ── Example 15: Ability phrases ───────────────────
  test('compresses ability phrases', () => {
    const input =
      'The model has the ability to process data and is able to ' +
      'generate responses.';

    const result = optimizePrompt(input);

    expect(result.optimized).not.toContain('has the ability to');
    expect(result.optimized).not.toContain('is able to');
    expect(result.optimized).toContain('can');
  });

  // ── Return shape ──────────────────────────────────
  test('returns all expected fields', () => {
    const result = optimizePrompt('Explain machine learning.');

    expect(result).toHaveProperty('original');
    expect(result).toHaveProperty('optimized');
    expect(result).toHaveProperty('changes');
    expect(result).toHaveProperty('tokensBefore');
    expect(result).toHaveProperty('tokensAfter');
    expect(result).toHaveProperty('savings');
    expect(result).toHaveProperty('confidence');
    expect(result.savings).toHaveProperty('saved');
    expect(result.savings).toHaveProperty('percentage');
    expect(result.savings).toHaveProperty('costSaved');
    expect(result.savings).toHaveProperty('model');
    expect(typeof result.tokensBefore).toBe('number');
    expect(typeof result.tokensAfter).toBe('number');
    expect(typeof result.confidence).toBe('number');
  });
});

// ═════════════════════════════════════════════════════════
//  countTokens()
// ═════════════════════════════════════════════════════════

describe('countTokens', () => {
  test('returns 0 for empty input', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens(undefined)).toBe(0);
  });

  test('counts single word', () => {
    expect(countTokens('hello')).toBeGreaterThan(0);
  });

  test('counts a short sentence', () => {
    const tokens = countTokens('The quick brown fox jumps over the lazy dog.');
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(15);
  });

  test('long words cost more tokens', () => {
    const short = countTokens('cat');
    const long = countTokens('internationalization');
    expect(long).toBeGreaterThan(short);
  });

  test('counts newlines as tokens', () => {
    const withoutNewlines = countTokens('hello world');
    const withNewlines = countTokens('hello\n\nworld');
    expect(withNewlines).toBeGreaterThan(withoutNewlines);
  });

  test('handles punctuation', () => {
    const tokens = countTokens('Hello, world! How are you?');
    expect(tokens).toBeGreaterThanOrEqual(5);
  });
});

// ═════════════════════════════════════════════════════════
//  estimateSavings()
// ═════════════════════════════════════════════════════════

describe('estimateSavings', () => {
  test('calculates savings correctly', () => {
    const result = estimateSavings(100, 60, 'gpt-4o');
    expect(result.saved).toBe(40);
    expect(result.percentage).toBe(40);
    expect(result.costSaved).toBeGreaterThan(0);
    expect(result.model).toBe('gpt-4o');
  });

  test('handles zero original tokens', () => {
    const result = estimateSavings(0, 0);
    expect(result.saved).toBe(0);
    expect(result.percentage).toBe(0);
  });

  test('falls back to gpt-4o pricing for unknown models', () => {
    const result = estimateSavings(100, 50, 'unknown-model');
    expect(result.model).toBe('unknown-model');
    expect(result.costSaved).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════
//  availableModels()
// ═════════════════════════════════════════════════════════

describe('availableModels', () => {
  test('returns an array of model names', () => {
    const models = availableModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('gpt-4o');
    expect(models).toContain('claude-3.5-sonnet');
  });
});

// ═════════════════════════════════════════════════════════
//  getSuggestions()
// ═════════════════════════════════════════════════════════

describe('getSuggestions', () => {
  test('returns suggestions for verbose text', () => {
    const suggestions = getSuggestions(
      'In order to fix the bug, it is necessary to take into account all factors.'
    );

    expect(suggestions.length).toBeGreaterThan(0);

    for (const sug of suggestions) {
      expect(sug).toHaveProperty('id');
      expect(sug).toHaveProperty('type');
      expect(sug).toHaveProperty('original');
      expect(sug).toHaveProperty('replacement');
      expect(sug).toHaveProperty('confidence');
      expect(sug).toHaveProperty('explanation');
      expect(sug).toHaveProperty('tokensSaved');
      expect(sug).toHaveProperty('startIndex');
      expect(sug).toHaveProperty('endIndex');
      expect(sug).toHaveProperty('severity');
    }
  });

  test('returns empty array for concise text', () => {
    const suggestions = getSuggestions('Write a sort function.');
    // Might still have some, but should be very few
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  test('returns empty array for empty input', () => {
    expect(getSuggestions('')).toEqual([]);
    expect(getSuggestions(null)).toEqual([]);
  });

  test('suggestions are sorted by position', () => {
    const suggestions = getSuggestions(
      'In order to fix this, due to the fact that it is broken, ' +
      'we need to take into consideration all factors.'
    );

    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i].startIndex).toBeGreaterThanOrEqual(
        suggestions[i - 1].startIndex
      );
    }
  });

  test('suggestions do not overlap', () => {
    const suggestions = getSuggestions(
      'In order to handle a large number of cases, it is necessary to ' +
      'take into consideration all of the completely unique situations.'
    );

    for (let i = 0; i < suggestions.length; i++) {
      for (let j = i + 1; j < suggestions.length; j++) {
        const a = suggestions[i];
        const b = suggestions[j];
        const overlaps =
          (b.startIndex >= a.startIndex && b.startIndex < a.endIndex) ||
          (a.startIndex >= b.startIndex && a.startIndex < b.endIndex);
        expect(overlaps).toBe(false);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════
//  applySuggestions()
// ═════════════════════════════════════════════════════════

describe('applySuggestions', () => {
  test('applies all suggestions', () => {
    const text = 'In order to fix this, it is necessary to try.';
    const suggestions = getSuggestions(text);
    const result = applySuggestions(text, suggestions);

    expect(result.length).toBeLessThan(text.length);
    expect(result).not.toContain('In order to');
  });

  test('applies only selected suggestions', () => {
    const text = 'In order to fix this, it is necessary to rebuild.';
    const suggestions = getSuggestions(text);

    if (suggestions.length >= 2) {
      const partial = applySuggestions(text, suggestions, [suggestions[0].id]);
      const full = applySuggestions(text, suggestions);

      // Partial application should change less
      expect(partial.length).toBeGreaterThanOrEqual(full.length);
    }
  });
});

// ═════════════════════════════════════════════════════════
//  Performance
// ═════════════════════════════════════════════════════════

describe('performance', () => {
  test('optimizes a typical prompt in under 50ms', () => {
    const input =
      'Hello! I would appreciate it if you could help me. In order to ' +
      'understand the problem, it is necessary to take into consideration ' +
      'a large number of factors. Due to the fact that the system is ' +
      'completely unique, we need a very special approach. Thank you!';

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      optimizePrompt(input);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / 100;

    console.log(`Average optimization time: ${avgMs.toFixed(2)}ms`);
    expect(avgMs).toBeLessThan(50);
  });
});
