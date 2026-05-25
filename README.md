# Densify Context

> **A local, privacy-first prompt optimization engine.**
> Compresses verbose LLM prompts using rule-based transformations and heuristic analysis — no API calls, no data leaves your machine.

---

## Why?

Manual prompts are verbose → wastes tokens → wastes money → fills context windows unnecessarily.

**Densify Context** solves this in real-time:
- 🚀 **Fast** — Optimizations complete in <1ms for typical prompts
- 🔒 **Private** — Zero network calls, everything runs locally
- 💰 **Saves money** — Shows estimated token & cost savings per model
- 🎯 **Accurate** — Preserves meaning while removing bloat

## Quick Start

```bash
npm install densify-context
```

```javascript
import { optimizePrompt, countTokens, getSuggestions } from 'densify-context';

// Full optimization
const result = optimizePrompt(
  'Hello! I would appreciate it if you could help me. ' +
  'In order to understand the problem, it is necessary to ' +
  'take into consideration a large number of factors. Thank you!'
);

console.log(result.optimized);
// → "To understand the problem, must consider many factors."

console.log(result.savings);
// → { saved: 22, percentage: 55, costSaved: 0.000055, model: 'gpt-4o' }
```

## API Reference

### `optimizePrompt(text, options?)`

Applies all compression rules and returns the optimized prompt.

```javascript
const result = optimizePrompt(text, {
  removeFiller: true,      // Remove filler words (basically, actually, just…)
  removeCeremony: true,    // Remove greetings, closings, politeness
  compressPhrases: true,   // Replace verbose phrases with concise alternatives
  removeRedundant: true,   // Remove redundant modifiers (completely unique → unique)
  model: 'gpt-4o',        // Model for cost estimate
});
```

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| `original` | `string` | The input text |
| `optimized` | `string` | The compressed output |
| `changes` | `Change[]` | List of every transformation applied |
| `tokensBefore` | `number` | Estimated tokens in original |
| `tokensAfter` | `number` | Estimated tokens in output |
| `savings` | `Savings` | Token savings, percentage, and cost estimate |
| `confidence` | `number` | 0–1 aggregate confidence score |

### `countTokens(text)`

Estimates the BPE token count for a string (approximates cl100k_base ±8%).

```javascript
countTokens('Hello, world!');  // → 4
```

### `getSuggestions(text)`

Returns individual, non-overlapping suggestions the user can accept or reject.

```javascript
const suggestions = getSuggestions('In order to fix the bug, it is necessary to try.');
// [
//   { id: 'sug_1', type: 'phrase', original: 'In order to', replacement: 'to', ... },
//   { id: 'sug_2', type: 'phrase', original: 'it is necessary to', replacement: 'must', ... },
// ]
```

### `applySuggestions(text, suggestions, acceptedIds?)`

Applies a subset of suggestions to the text. If `acceptedIds` is omitted, all suggestions are applied.

```javascript
const result = applySuggestions(text, suggestions, ['sug_1']);
```

### `estimateSavings(originalTokens, optimizedTokens, model?)`

Calculates token savings and estimated cost.

### `availableModels()`

Returns the list of supported model names for pricing.

## Compression Rules

The engine applies 5 categories of rules in a deterministic pipeline:

| Category | Count | Confidence | Example |
|----------|-------|------------|---------|
| **Redundant modifiers** | 30 | 0.92 | "completely unique" → "unique" |
| **Verbose phrases** | 110+ | 0.88 | "in order to" → "to" |
| **Prompt ceremony** | 10+ | 0.78 | "Hello!", "Thank you!" → removed |
| **Filler words** | 28 | 0.65 | "basically", "actually" → removed |
| **Whitespace** | 5 | 1.00 | Collapse spaces, fix punctuation |

### Extending the Rule Set

All rule dictionaries are exported and mutable:

```javascript
import { PHRASE_REPLACEMENTS, FILLER_WORDS, REDUNDANT_MODIFIERS } from 'densify-context';

// Add a custom phrase replacement
PHRASE_REPLACEMENTS.set('in my humble opinion', 'I think');

// Add a custom filler word
FILLER_WORDS.add('perhaps');

// Add a custom redundant modifier
REDUNDANT_MODIFIERS.set('totally complete', 'complete');
```

## Supported Models (Cost Estimation)

| Model | Price/1K input tokens |
|-------|----------------------|
| gpt-4o | $0.0025 |
| gpt-4o-mini | $0.00015 |
| gpt-4-turbo | $0.01 |
| gpt-4 | $0.03 |
| gpt-3.5-turbo | $0.0005 |
| claude-3-opus | $0.015 |
| claude-3.5-sonnet | $0.003 |
| claude-3-haiku | $0.00025 |
| claude-4-opus | $0.015 |
| claude-4-sonnet | $0.003 |
| gemini-1.5-pro | $0.00125 |
| gemini-2.5-pro | $0.00125 |

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run benchmark
npm run bench
```

## Project Structure

```
densify-context/
├── src/
│   ├── index.js          # Public API exports
│   ├── optimizer.js       # Core optimization pipeline
│   ├── rules.js           # Rule dictionaries (phrases, fillers, modifiers)
│   ├── tokenizer.js       # Offline token estimator + cost calculator
│   └── suggestions.js     # Non-destructive suggestion generator
├── tests/
│   └── optimizer.test.js  # Comprehensive test suite (25+ tests)
├── benchmarks/
│   └── bench.js           # Performance benchmark
├── package.json
└── README.md
```

## Roadmap

- **Phase 1** ✅ Core optimization engine (this package)
- **Phase 2** 🔜 Chrome browser extension
- **Phase 3** 🔜 VS Code extension

## License

MIT
