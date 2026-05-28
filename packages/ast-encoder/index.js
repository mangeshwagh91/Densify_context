// ─────────────────────────────────────────────────────────────────────────────
//  packages/ast-encoder/index.js
//  AST/DSL Encoder — parses verbose prompts into compact PromptAST structures
//  and re-serializes them as dense natural language.
//
//  Pipeline:
//    parse(text)  → PromptAST (structured intent object)
//    encode(ast)  → compact prompt string (natural language, fewer tokens)
//    compress(text) → shortcut: parse + encode in one call
//
//  Design principles:
//    - Zero dependencies — pure JS
//    - Named entities, negations, numbers are NEVER dropped
//    - Falls back gracefully: if no intent detected, returns text unchanged
//    - All transforms are reversible via ast.raw
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

import {
  ACTION_PATTERNS,
  LANGUAGE_PATTERNS,
  FORMAT_PATTERNS,
  LENGTH_PATTERNS,
  PROTECTED_PATTERNS,
  PREAMBLE_PATTERNS,
} from './patterns.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract all spans protected from dropping (negations, numbers, proper nouns, quotes). */
function extractProtected(text) {
  const spans = new Set();
  for (const re of PROTECTED_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text)) !== null) {
      spans.add(m[0].toLowerCase().trim());
    }
  }
  return spans;
}

/** Strip common preamble ceremony from the start/end of text. */
function stripPreamble(text) {
  let stripped = text;
  for (const re of PREAMBLE_PATTERNS) {
    stripped = stripped.replace(re, '').trim();
  }
  return stripped || text; // never return empty
}

/** Detect the primary action/intent. */
function detectAction(text) {
  for (const { action, patterns } of ACTION_PATTERNS) {
    if (patterns.some(p => p.test(text))) return action;
  }
  return 'instruct';
}

/** Detect programming language if mentioned. */
function detectLanguage(text) {
  for (const [re, lang] of LANGUAGE_PATTERNS) {
    if (re.test(text)) return lang;
  }
  return null;
}

/** Detect desired output format. */
function detectFormat(text) {
  for (const [re, fmt] of FORMAT_PATTERNS) {
    if (re.test(text)) return fmt;
  }
  return null;
}

/** Detect verbosity/length constraint. */
function detectLength(text) {
  for (const [re, len] of LENGTH_PATTERNS) {
    if (re.test(text)) return len;
  }
  return null;
}

/** Extract the core topic/subject: what is the prompt actually about? */
function extractTopic(text, action) {
  let topic = text;

  // Remove common action verbs at the start to isolate the object
  const ACTION_VERB_RE = {
    'code-gen':  /^(write|create|implement|build|generate|make)\s+(a\s+)?/i,
    'explain':   /^(explain|describe|what is|what are|how does|how do|tell me about|elaborate on|clarify|define)\s+/i,
    'summarize': /^(summarize|sum up|condense|give me (a\s+)?(brief|short|quick)\s+(summary of)?|tldr:?)\s*/i,
    'translate': /^(translate|convert)\s+(this\s+)?/i,
    'compare':   /^(compare|contrast)\s+/i,
    'list':      /^(list|enumerate|give me|provide|show me)\s+(some\s+|the\s+)?/i,
    'rewrite':   /^(rewrite|rephrase|paraphrase|improve|refactor|clean up|edit|revise|polish|optimize)\s+(this\s+)?/i,
    'debug':     /^(debug|fix|troubleshoot|diagnose)\s+(this\s+)?/i,
    'qa':        /^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|do|did)\s+/i,
  };

  const verbRe = ACTION_VERB_RE[action];
  if (verbRe) {
    topic = topic.replace(verbRe, '').trim();
  }

  // Remove trailing format/length instructions
  topic = topic
    .replace(/[,.]\s*(with|including|provide|add|make sure|ensure|please).{0,60}$/i, '')
    .replace(/[,.]\s*(in|using|with)\s+(python|javascript|typescript|java|go|rust|swift|kotlin|ruby|php|sql|bash|html|css)[^.]*$/i, '')
    .replace(/[,.]\s*(as|in)\s+(json|markdown|bullets?|numbered list|table|code block|plain text)[^.]*$/i, '')
    .trim();

  // Truncate to ~60 chars max (keep it dense)
  if (topic.length > 80) {
    // Try to cut at a sentence boundary
    const shortIdx = topic.search(/[.!?]/);
    if (shortIdx > 20 && shortIdx < 80) {
      topic = topic.slice(0, shortIdx + 1);
    } else {
      topic = topic.slice(0, 77) + '…';
    }
  }

  return topic || text.slice(0, 60);
}

/** Pull explicit constraints mentioned in text (e.g. "with error handling", "no comments"). */
function extractConstraints(text) {
  const constraints = [];
  const CONSTRAINT_PATTERNS = [
    [/\bwith (error handling|type hints?|docstrings?|comments?|tests?|examples?)\b/gi, m => m],
    [/\bno (comments?|docstrings?|tests?|explanations?|extra text)\b/gi, m => m],
    [/\b(async|await|promise|callback|generator)\b/gi, m => m.toLowerCase()],
    [/\bin under (\d+) (words?|lines?|tokens?|characters?)\b/gi, m => m.toLowerCase()],
    [/\b(without|excluding|except for)\s+\w+/gi, m => m.toLowerCase()],
  ];

  for (const [re, transform] of CONSTRAINT_PATTERNS) {
    let m;
    const g = new RegExp(re.source, re.flags);
    while ((m = g.exec(text)) !== null) {
      const c = transform(m[0]).trim();
      if (c && !constraints.includes(c)) constraints.push(c);
    }
  }
  return constraints;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a verbose natural-language prompt into a PromptAST.
 *
 * @param {string} text
 * @returns {PromptAST}
 *
 * @typedef {Object} PromptAST
 * @property {string}   action       - Detected intent: 'code-gen'|'explain'|'summarize'|...
 * @property {string}   topic        - Core subject of the prompt
 * @property {string|null} lang      - Programming language if detected
 * @property {string|null} format    - Desired output format if detected
 * @property {string|null} length    - Verbosity constraint if detected
 * @property {string[]}  constraints - Extracted explicit constraints
 * @property {Set<string>} protected - Protected tokens (must not be dropped)
 * @property {string}   preambleFree - Text after stripping ceremony preamble
 * @property {string}   raw          - Original text (for fallback/decode)
 */
export function parse(text) {
  if (!text || typeof text !== 'string') {
    return { action: 'instruct', topic: '', lang: null, format: null, length: null,
             constraints: [], protected: new Set(), preambleFree: '', raw: text || '' };
  }

  const preambleFree = stripPreamble(text.trim());
  const action       = detectAction(preambleFree);
  const lang         = detectLanguage(preambleFree);
  const format       = detectFormat(preambleFree);
  const length       = detectLength(preambleFree);
  const constraints  = extractConstraints(preambleFree);
  const topic        = extractTopic(preambleFree, action);
  const protectedSet = extractProtected(preambleFree);

  return { action, topic, lang, format, length, constraints, protected: protectedSet, preambleFree, raw: text };
}

/**
 * Encode a PromptAST back into a compact natural-language prompt.
 * The output is valid English — not JSON — so all LLMs handle it naturally.
 *
 * @param {PromptAST} ast
 * @returns {string}
 */
export function encode(ast) {
  if (!ast || !ast.action) return ast?.raw || '';

  const ACTION_VERBS = {
    'code-gen':  'Write',
    'explain':   'Explain',
    'summarize': 'Summarize',
    'translate': 'Translate',
    'compare':   'Compare',
    'list':      'List',
    'rewrite':   'Rewrite',
    'debug':     'Debug',
    'qa':        'Answer:',
    'instruct':  '',
  };

  const parts = [];

  // 1. Action verb
  const verb = ACTION_VERBS[ast.action] || '';
  if (verb) parts.push(verb);

  // 2. Language qualifier (for code actions)
  if (ast.lang && ['code-gen', 'debug', 'rewrite'].includes(ast.action)) {
    parts.push(ast.lang);
  }

  // 3. Core topic
  if (ast.topic) parts.push(ast.topic);

  // 4. Constraints
  if (ast.constraints.length > 0) {
    parts.push(ast.constraints.join(', '));
  }

  // 5. Format
  if (ast.format) {
    const FMT_LABELS = {
      json: 'Output JSON.',
      markdown: 'Use Markdown.',
      bullets: 'Use bullet points.',
      numbered: 'Use numbered steps.',
      table: 'Use a table.',
      'code-block': 'Include code.',
      plain: 'Plain text only.',
    };
    parts.push(FMT_LABELS[ast.format] || '');
  }

  // 6. Length
  if (ast.length) {
    const LEN_LABELS = {
      'one-line': 'One line.',
      brief: 'Be concise.',
      detailed: 'Be thorough.',
      custom: '',
    };
    const label = LEN_LABELS[ast.length];
    if (label) parts.push(label);
  }

  const encoded = parts.filter(Boolean).join(' ').trim();

  // Safety: if encoding is longer than original (rare), return preamble-stripped original
  if (encoded.length >= (ast.preambleFree || ast.raw).length) {
    return ast.preambleFree || ast.raw;
  }

  return encoded;
}

/**
 * One-shot convenience: parse + encode.
 * Returns the compact prompt and metadata.
 *
 * @param {string} text
 * @returns {{ compressed: string, ast: PromptAST, tokensSaved: number, ratio: number }}
 */
export function compress(text) {
  const ast      = parse(text);
  const compressed = encode(ast);

  // Rough token estimate: ~1 token per 4 chars
  const rawTokens  = Math.ceil(text.length / 4);
  const compTokens = Math.ceil(compressed.length / 4);
  const tokensSaved = Math.max(0, rawTokens - compTokens);
  const ratio       = rawTokens > 0 ? parseFloat((1 - compTokens / rawTokens).toFixed(3)) : 0;

  return { compressed, ast, tokensSaved, ratio };
}

/**
 * Decode: reconstruct a human-readable description from the AST.
 * Not a lossless reverse — use ast.raw for the original.
 *
 * @param {PromptAST} ast
 * @returns {string}
 */
export function decode(ast) {
  return ast?.raw || encode(ast);
}

export default { parse, encode, compress, decode };
