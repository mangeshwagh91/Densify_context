// ─────────────────────────────────────────────────────────────────────────────
//  browser-extension/lib/ast-encoder.js
//  Browser IIFE bundle of the AST/DSL Encoder.
//  Exposes: globalThis.DensifyAST  { parse, encode, compress, decode }
//
//  Self-contained — no imports. Loaded as a content script before content.js.
// ─────────────────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  // ── Patterns (inlined from packages/ast-encoder/patterns.js) ─────────────

  const ACTION_PATTERNS = [
    { action: 'debug',     patterns: [/\b(debug|fix|troubleshoot|diagnose|why (is|does|isn't|doesn't))\b/i, /\b(error|exception|bug|crash|not working|failing)\b.*\b(how|why|what)\b/i] },
    { action: 'code-gen',  patterns: [/\b(write|create|implement|build|generate|make)\b.{0,40}\b(function|class|method|script|program|code|snippet|module|component)\b/i, /\b(code|implement|program)\b.{0,30}\b(in|using|with)\b.{0,20}\b(python|javascript|typescript|java|c\+\+|go|rust|swift|kotlin|ruby|php)\b/i] },
    { action: 'explain',   patterns: [/\b(explain|describe|what is|what are|how does|how do|tell me about|elaborate on|clarify|define)\b/i] },
    { action: 'summarize', patterns: [/\b(summarize|summary|sum up|condense|brief|tldr|tl;dr|shorten|compress|overview)\b/i] },
    { action: 'translate', patterns: [/\b(translate|convert|localize)\b.{0,30}\b(to|into|from)\b/i] },
    { action: 'compare',   patterns: [/\b(compare|contrast|difference between|vs\.?|versus|pros and cons|trade.?offs)\b/i] },
    { action: 'list',      patterns: [/\b(list|enumerate|give me|provide|show me).{0,30}\b(examples|steps|ways|options|alternatives|reasons|benefits|drawbacks)\b/i] },
    { action: 'rewrite',   patterns: [/\b(rewrite|rephrase|paraphrase|improve|refactor|clean up|edit|revise|polish|optimize)\b/i] },
    { action: 'qa',        patterns: [/^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|do|did)\b/i, /\?$/] },
    { action: 'instruct',  patterns: [/.*/] },
  ];

  const LANGUAGE_PATTERNS = [
    [/\b(python|py)\b/i, 'python'], [/\b(javascript|js)\b/i, 'javascript'],
    [/\b(typescript|ts)\b/i, 'typescript'], [/\b(java)\b/i, 'java'],
    [/\b(c\+\+|cpp)\b/i, 'cpp'], [/\b(go|golang)\b/i, 'go'],
    [/\b(rust)\b/i, 'rust'], [/\b(swift)\b/i, 'swift'],
    [/\b(kotlin)\b/i, 'kotlin'], [/\b(ruby|rb)\b/i, 'ruby'],
    [/\b(php)\b/i, 'php'], [/\b(sql)\b/i, 'sql'],
    [/\b(bash|shell)\b/i, 'bash'], [/\b(react|jsx)\b/i, 'react'],
  ];

  const FORMAT_PATTERNS = [
    [/\b(json)\b/i, 'json'], [/\b(markdown|md)\b/i, 'markdown'],
    [/\b(bullet[s\s]*points?|bulleted list)\b/i, 'bullets'],
    [/\b(numbered list|step.by.step)\b/i, 'numbered'],
    [/\b(table)\b/i, 'table'], [/\b(code block|code snippet)\b/i, 'code-block'],
  ];

  const LENGTH_PATTERNS = [
    [/\b(one.?liner|single line|one line)\b/i, 'one-line'],
    [/\b(brief|concise|short|succinct|terse)\b/i, 'brief'],
    [/\b(detailed?|comprehensive|thorough|in.depth)\b/i, 'detailed'],
  ];

  const PROTECTED_PATTERNS = [
    /\b(not|never|no|without|except|unless|neither|nor|don't|doesn't|won't|can't|shouldn't)\b/i,
    /\b\d[\d,._]*\b/,
    /"[^"]{1,80}"/,
    /`[^`]{1,80}`/,
  ];

  const PREAMBLE_PATTERNS = [
    /^(hi|hello|hey|good (morning|afternoon|evening))[,!.\s]*/i,
    /^(chatgpt|claude|gemini|copilot|gpt|bard)[,!.\s]*/i,
    /^(i hope (you('re| are) )?(doing well|well|okay|fine|good)[,!.\s]*)/i,
    /^(i('d| would) (like|love) (to ask|to know|you to|for you to)\s*)/i,
    /^(can you please|could you please|would you (please|mind|be so kind as to)\s*)/i,
    /^(i want to tell you (about|regarding)\s*)/i,
    /\s*(thank you( (so|very) much)?|thanks)[.!]*\s*$/i,
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function stripPreamble(text) {
    let s = text;
    for (const re of PREAMBLE_PATTERNS) s = s.replace(re, '').trim();
    return s || text;
  }

  function detectAction(text) {
    for (const { action, patterns } of ACTION_PATTERNS) {
      if (patterns.some(p => p.test(text))) return action;
    }
    return 'instruct';
  }

  function detectLanguage(text) {
    for (const [re, lang] of LANGUAGE_PATTERNS) { if (re.test(text)) return lang; }
    return null;
  }

  function detectFormat(text) {
    for (const [re, fmt] of FORMAT_PATTERNS) { if (re.test(text)) return fmt; }
    return null;
  }

  function detectLength(text) {
    for (const [re, len] of LENGTH_PATTERNS) { if (re.test(text)) return len; }
    return null;
  }

  function extractProtected(text) {
    const spans = new Set();
    for (const re of PROTECTED_PATTERNS) {
      const g = new RegExp(re.source, (re.flags || '') + (re.flags.includes('g') ? '' : 'g'));
      let m;
      while ((m = g.exec(text)) !== null) spans.add(m[0].toLowerCase().trim());
    }
    return spans;
  }

  function extractTopic(text, action) {
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
    let topic = text;
    const verbRe = ACTION_VERB_RE[action];
    if (verbRe) topic = topic.replace(verbRe, '').trim();
    topic = topic
      .replace(/[,.]\s*(with|including|provide|add|make sure|ensure|please).{0,60}$/i, '')
      .replace(/[,.]\s*(in|using|with)\s+(python|javascript|typescript|java|go|rust|swift|kotlin|ruby|php|sql|bash|html|css)[^.]*$/i, '')
      .replace(/[,.]\s*(as|in)\s+(json|markdown|bullets?|numbered list|table|code block|plain text)[^.]*$/i, '')
      .trim();
    if (topic.length > 80) {
      const shortIdx = topic.search(/[.!?]/);
      topic = (shortIdx > 20 && shortIdx < 80) ? topic.slice(0, shortIdx + 1) : topic.slice(0, 77) + '…';
    }
    return topic || text.slice(0, 60);
  }

  function extractConstraints(text) {
    const constraints = [];
    const CPATS = [
      /\bwith (error handling|type hints?|docstrings?|comments?|tests?|examples?)\b/gi,
      /\bno (comments?|docstrings?|tests?|explanations?|extra text)\b/gi,
      /\b(async|await|promise|callback|generator)\b/gi,
      /\bin under (\d+) (words?|lines?|tokens?|characters?)\b/gi,
      /\b(without|excluding|except for)\s+\w+/gi,
    ];
    for (const re of CPATS) {
      let m;
      const g = new RegExp(re.source, re.flags);
      while ((m = g.exec(text)) !== null) {
        const c = m[0].trim().toLowerCase();
        if (c && !constraints.includes(c)) constraints.push(c);
      }
    }
    return constraints;
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  function parse(text) {
    if (!text || typeof text !== 'string') {
      return { action: 'instruct', topic: '', lang: null, format: null, length: null,
               constraints: [], protected: new Set(), preambleFree: '', raw: text || '' };
    }
    const preambleFree = stripPreamble(text.trim());
    const action       = detectAction(preambleFree);
    return {
      action,
      topic:       extractTopic(preambleFree, action),
      lang:        detectLanguage(preambleFree),
      format:      detectFormat(preambleFree),
      length:      detectLength(preambleFree),
      constraints: extractConstraints(preambleFree),
      protected:   extractProtected(preambleFree),
      preambleFree,
      raw: text,
    };
  }

  function encode(ast) {
    if (!ast || !ast.action) return ast?.raw || '';
    const VERBS = { 'code-gen':'Write', 'explain':'Explain', 'summarize':'Summarize',
      'translate':'Translate', 'compare':'Compare', 'list':'List', 'rewrite':'Rewrite',
      'debug':'Debug', 'qa':'Answer:', 'instruct':'' };
    const FMT = { json:'Output JSON.', markdown:'Use Markdown.', bullets:'Use bullet points.',
      numbered:'Use numbered steps.', table:'Use a table.', 'code-block':'Include code.' };
    const LEN = { 'one-line':'One line.', brief:'Be concise.', detailed:'Be thorough.' };

    const parts = [];
    const verb = VERBS[ast.action] || '';
    if (verb) parts.push(verb);
    if (ast.lang && ['code-gen','debug','rewrite'].includes(ast.action)) parts.push(ast.lang);
    if (ast.topic) parts.push(ast.topic);
    if (ast.constraints && ast.constraints.length) parts.push(ast.constraints.join(', '));
    if (ast.format && FMT[ast.format]) parts.push(FMT[ast.format]);
    if (ast.length && LEN[ast.length]) parts.push(LEN[ast.length]);

    const encoded = parts.filter(Boolean).join(' ').trim();
    if (encoded.length >= (ast.preambleFree || ast.raw || '').length) {
      return ast.preambleFree || ast.raw;
    }
    return encoded;
  }

  function compress(text) {
    const ast        = parse(text);
    const compressed = encode(ast);
    const rawTokens  = Math.ceil((text || '').length / 4);
    const compTokens = Math.ceil(compressed.length / 4);
    const tokensSaved = Math.max(0, rawTokens - compTokens);
    const ratio       = rawTokens > 0 ? parseFloat((1 - compTokens / rawTokens).toFixed(3)) : 0;
    return { compressed, ast, tokensSaved, ratio };
  }

  function decode(ast) { return ast?.raw || encode(ast); }

  // ── Export ────────────────────────────────────────────────────────────────
  const api = { parse, encode, compress, decode, version: '1.0.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DensifyAST = api;
  console.debug('[Densify] AST Encoder v1.0.0 loaded');

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
