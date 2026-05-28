// ─────────────────────────────────────────────────────────────────────────────
//  packages/ast-encoder/patterns.js
//  Regex-based intent classifiers and constraint extractors.
//  Zero external dependencies — pure JS, runs on main thread or in Worker.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Action / intent matchers ──────────────────────────────────────────────────
// Each entry: { action, patterns[] }
// First match wins (ordered by specificity).

export const ACTION_PATTERNS = [
  {
    action: 'debug',
    patterns: [
      /\b(debug|fix|troubleshoot|diagnose|why (is|does|isn't|doesn't))\b/i,
      /\b(error|exception|bug|crash|not working|failing)\b.*\b(how|why|what)\b/i,
    ],
  },
  {
    action: 'code-gen',
    patterns: [
      /\b(write|create|implement|build|generate|make)\b.{0,40}\b(function|class|method|script|program|code|snippet|module|component)\b/i,
      /\b(code|implement|program)\b.{0,30}\b(in|using|with)\b.{0,20}\b(python|javascript|typescript|java|c\+\+|go|rust|swift|kotlin|ruby|php)\b/i,
    ],
  },
  {
    action: 'explain',
    patterns: [
      /\b(explain|describe|what is|what are|how does|how do|tell me about|elaborate on|clarify|define)\b/i,
      /\b(can you explain|could you explain|please explain)\b/i,
    ],
  },
  {
    action: 'summarize',
    patterns: [
      /\b(summarize|summary|sum up|condense|brief|tldr|tl;dr|shorten|compress|overview)\b/i,
      /\b(give me (a|the) (key|main|brief|short))\b/i,
    ],
  },
  {
    action: 'translate',
    patterns: [
      /\b(translate|convert|localize)\b.{0,30}\b(to|into|from)\b.{0,30}\b([a-z]{3,15})\b/i,
    ],
  },
  {
    action: 'compare',
    patterns: [
      /\b(compare|contrast|difference between|vs\.?|versus|pros and cons|trade.?offs)\b/i,
    ],
  },
  {
    action: 'list',
    patterns: [
      /\b(list|enumerate|give me|provide|show me).{0,30}\b(examples|steps|ways|options|alternatives|reasons|benefits|drawbacks)\b/i,
      /\b(what are (the|some)|name (some|the))\b/i,
    ],
  },
  {
    action: 'rewrite',
    patterns: [
      /\b(rewrite|rephrase|paraphrase|improve|refactor|clean up|edit|revise|polish|optimize)\b/i,
    ],
  },
  {
    action: 'qa',
    patterns: [
      /^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|do|did)\b/i,
      /\?$/,
    ],
  },
  {
    action: 'instruct',
    patterns: [/.*/], // catch-all
  },
];

// ── Language detector ─────────────────────────────────────────────────────────

export const LANGUAGE_PATTERNS = [
  [/\b(python|py)\b/i, 'python'],
  [/\b(javascript|js)\b/i, 'javascript'],
  [/\b(typescript|ts)\b/i, 'typescript'],
  [/\b(java)\b/i, 'java'],
  [/\b(c\+\+|cpp|c plus plus)\b/i, 'cpp'],
  [/\b(c#|csharp|c sharp)\b/i, 'csharp'],
  [/\b(go|golang)\b/i, 'go'],
  [/\b(rust)\b/i, 'rust'],
  [/\b(swift)\b/i, 'swift'],
  [/\b(kotlin)\b/i, 'kotlin'],
  [/\b(ruby|rb)\b/i, 'ruby'],
  [/\b(php)\b/i, 'php'],
  [/\b(sql)\b/i, 'sql'],
  [/\b(bash|shell|sh)\b/i, 'bash'],
  [/\b(html)\b/i, 'html'],
  [/\b(css)\b/i, 'css'],
  [/\b(react|jsx)\b/i, 'react'],
];

// ── Format constraints ────────────────────────────────────────────────────────

export const FORMAT_PATTERNS = [
  [/\b(json)\b/i, 'json'],
  [/\b(markdown|md)\b/i, 'markdown'],
  [/\b(bullet[s\s]*points?|bulleted list)\b/i, 'bullets'],
  [/\b(numbered list|step.by.step)\b/i, 'numbered'],
  [/\b(table)\b/i, 'table'],
  [/\b(code block|code snippet)\b/i, 'code-block'],
  [/\b(plain text|no formatting)\b/i, 'plain'],
];

// ── Length / verbosity constraints ────────────────────────────────────────────

export const LENGTH_PATTERNS = [
  [/\b(one.?liner|single line|one line)\b/i, 'one-line'],
  [/\b(brief|concise|short|succinct|terse)\b/i, 'brief'],
  [/\b(detailed?|comprehensive|thorough|in.depth|exhaustive)\b/i, 'detailed'],
  [/\b(in (\d+) (words?|sentences?|paragraphs?|lines?))\b/i, 'custom'],
];

// ── Named entity / protected token detector ───────────────────────────────────
// These must NEVER be dropped by compression.

export const PROTECTED_PATTERNS = [
  /\b(not|never|no|without|except|unless|neither|nor|don't|doesn't|won't|can't|shouldn't)\b/i, // negations
  /\b\d[\d,._]*\b/,              // numbers
  /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/, // proper nouns (Title Case sequences)
  /"[^"]{1,80}"/,                // quoted strings
  /`[^`]{1,80}`/,                // backtick code
];

// ── Ceremony / preamble stripper ──────────────────────────────────────────────
// Phrases that are pure overhead before the real instruction.

export const PREAMBLE_PATTERNS = [
  /^(hi|hello|hey|good (morning|afternoon|evening))[,!.\s]*/i,
  /^(chatgpt|claude|gemini|copilot|gpt|bard)[,!.\s]*/i,
  /^(i hope (you('re| are) )?(doing well|well|okay|fine|good)[,!.\s]*)/i,
  /^(i('d| would) (like|love) (to ask|to know|you to|for you to)\s*)/i,
  /^(can you please|could you please|would you (please|mind|be so kind as to)\s*)/i,
  /^(i('m| am) (going to|gonna)\s*(ask|tell|show|share|explain)\s*(you\s*)?)/i,
  /^(i want to tell you (about|regarding)\s*)/i,
  /\s*(thank you( (so|very) much)?|thanks)[.!]*\s*$/i,
];
