// ─────────────────────────────────────────────────────────────────────────────
//  densify-engine.js  —  Core Densify optimization engine  (v5, production)
//
//  Exposes: globalThis.DensifyEngine
//
//  Depends on (must be loaded before this script):
//    DensifyTokenizer  (tokenizer.js)
//    DensifyConfidence (confidence.js)
//
//  Works in: Chrome extension content/popup/service-worker, VS Code Node,
//            any modern JS runtime. Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  // ── Dependency resolution ─────────────────────────────────────────────────
  // Falls back gracefully if sub-modules aren't loaded.

  function getTokenizer() { return root.DensifyTokenizer || null; }
  function getConfidence() { return root.DensifyConfidence || null; }

  function countTok(text, model) {
    const tok = getTokenizer();
    return tok ? tok.countSync(text, model) : _heuristicFallback(text);
  }

  // Minimal inline fallback (in case tokenizer.js not loaded yet)
  function _heuristicFallback(text) {
    if (!text) return 0;
    let t = (text.match(/\n/g) || []).length;
    for (const w of text.split(/\s+/).filter(Boolean)) {
      t += /^[^\w]+$/.test(w) ? w.length : w.length <= 5 ? 1 : Math.ceil(w.length / 4.2);
    }
    return Math.max(1, t);
  }

  function applyConf(text, suggestions) {
    const conf = getConfidence();
    return conf ? conf.scoreSuggestions(text, suggestions) : suggestions;
  }

  // ── Rule Dictionaries ─────────────────────────────────────────────────────

  const PHRASE_REPLACEMENTS = new Map([
    // ── Purpose / Causation
    ['in order to','to'],['for the purpose of','to'],['with the aim of','to'],
    ['so as to','to'],['with the intention of','to'],['with the goal of','to'],
    ['with the objective of','to'],
    // ── Reason
    ['due to the fact that','because'],['owing to the fact that','because'],
    ['on account of the fact that','because'],['for the reason that','because'],
    ['by virtue of the fact that','because'],['in light of the fact that','since'],
    ['given the fact that','since'],['considering the fact that','since'],
    // ── Conditionals
    ['in the event that','if'],['on the condition that','if'],
    ['in the case that','if'],['provided that','if'],['assuming that','if'],
    ['in a situation where','when'],
    // ── Time
    ['at this point in time','now'],['at the present time','now'],
    ['at the current moment','now'],['at this moment in time','now'],
    ['in the near future','soon'],['at a later date','later'],
    ['prior to','before'],['subsequent to','after'],['in advance of','before'],
    ['for the duration of','during'],
    // ── Relation / Topic
    ['with regard to','about'],['with respect to','about'],
    ['in relation to','about'],['pertaining to','about'],
    ['in reference to','about'],['on the subject of','about'],
    ['in terms of','regarding'],['as it relates to','regarding'],
    // ── Quantity
    ['a large number of','many'],['a great number of','many'],
    ['a significant number of','many'],['a considerable amount of','much'],
    ['a wide range of','various'],['a variety of','various'],
    ['a small number of','few'],['the vast majority of','most'],
    ['a majority of','most'],['each and every','every'],
    // ── Ability / Possibility
    ['is able to','can'],['has the ability to','can'],['has the capacity to','can'],
    ['it is possible to','can'],['it is possible that','may'],
    ['there is a possibility that','may'],['are able to','can'],
    ['was able to','could'],['were able to','could'],
    // ── Emphasis / Hedging removal
    ['it is important to note that',''],['it should be noted that',''],
    ['it is worth mentioning that',''],['it goes without saying that',''],
    ['needless to say',''],['as a matter of fact',''],
    ['the thing is that',''],['what i mean is',''],
    ['it is essential that','must'],['it is necessary to','must'],
    ['it is crucial that','must'],
    // ── Prompt ceremony (polite framing)
    ['i would like you to',''],['i would appreciate it if you could',''],
    ['i was wondering if you could',''],['would you be so kind as to',''],
    ['could you please',''],['can you please',''],
    ['please be so kind as to',''],['i need you to',''],
    ['i want you to',''],['would it be possible for you to',''],
    // ── Connectors / Transitions
    ['in addition to this','also'],['in addition to that','also'],
    ['on top of that','also'],['furthermore','also'],['moreover','also'],
    ['as well as','and'],['in conjunction with','with'],
    ['together with','with'],['along with','with'],
    // ── Comparison
    ['in comparison to','compared to'],['in contrast to','unlike'],
    ['as opposed to','unlike'],['on the other hand','conversely'],
    // ── Result / Conclusion
    ['as a result of','from'],['as a consequence of','from'],
    ['for this reason','so'],['because of this','so'],['as a result','so'],
    ['in conclusion','finally'],['to summarize','in short'],
    ['in summary','in short'],['all things considered','overall'],
    // ── Process / Frequency
    ['in the process of','while'],['in the midst of','during'],
    ['on a daily basis','daily'],['on a regular basis','regularly'],
    ['at all times','always'],['in most cases','usually'],
    ['in some cases','sometimes'],
    // ── Misc concision
    ['despite the fact that','although'],['regardless of the fact that','although'],
    ['notwithstanding the fact that','although'],
    ['in spite of the fact that','although'],['whether or not','whether'],
    ['the reason why is that','because'],['until such time as','until'],
    ['in close proximity to','near'],['a sufficient amount of','enough'],
    ['make a decision','decide'],['come to the conclusion','conclude'],
    ['take into consideration','consider'],['take into account','consider'],
    ['give an indication of','indicate'],['have a tendency to','tend to'],
    ['make an attempt to','try to'],['is indicative of','indicates'],
    ['has an impact on','affects'],['is dependent on','depends on'],
  ]);

  // Sorted longest-first once at startup (avoids re-sorting on every call)
  const SORTED_PHRASES = Array.from(PHRASE_REPLACEMENTS.entries())
    .sort((a, b) => b[0].length - a[0].length);

  const FILLER_WORDS = new Set([
    'basically','actually','really','very','just','quite','rather',
    'simply','literally','definitely','certainly','absolutely',
    'obviously','clearly','honestly','frankly','personally',
    'essentially','practically','virtually','somewhat','extremely',
    'incredibly','remarkably','particularly','specifically','especially','notably',
  ]);

  const REDUNDANT_MODIFIERS = new Map([
    ['absolutely essential','essential'],['absolutely necessary','necessary'],
    ['completely unique','unique'],['completely finished','finished'],
    ['completely eliminate','eliminate'],['entirely unique','unique'],
    ['totally unique','unique'],['very unique','unique'],
    ['final outcome','outcome'],['end result','result'],
    ['past history','history'],['future plans','plans'],
    ['free gift','gift'],['basic fundamentals','fundamentals'],
    ['true fact','fact'],['added bonus','bonus'],['exact same','same'],
    ['general consensus','consensus'],['brief summary','summary'],
    ['close proximity','proximity'],['current status','status'],
    ['advance warning','warning'],['still remains','remains'],
    ['repeat again','repeat'],['revert back','revert'],
    ['join together','join'],['merge together','merge'],
    ['combine together','combine'],['mix together','mix'],
  ]);

  const SORTED_REDUNDANT = Array.from(REDUNDANT_MODIFIERS.entries())
    .sort((a, b) => b[0].length - a[0].length);

  const PROMPT_CEREMONY = [
    { re: /^(hi|hello|hey|greetings|good (morning|afternoon|evening)|dear (assistant|ai|chatgpt|claude))[,!.\s]*/i,  replacement: '', label: 'greeting' },
    { re: /\s*(thank you( very much| so much| in advance)?|thanks( a lot| so much| in advance)?|please and thank you|i appreciate (it|your help|any help))[.!]*\s*$/i, replacement: '', label: 'closing thanks' },
    { re: /\b(please|kindly)\s+/gi, replacement: '', label: 'politeness filler' },
    { re: /^(I have a question[.:]\s*)/i,  replacement: '', label: 'framing' },
    { re: /^(I('d| would) like (to ask|to know|you to tell me)\s*)/i, replacement: '', label: 'framing' },
    { re: /^(My question is[.:]\s*)/i, replacement: '', label: 'framing' },
  ];

  const WHITESPACE_RULES = [
    { re: /[ \t]+/g,                 repl: ' ' },
    { re: /\n{3,}/g,                 repl: '\n\n' },
    { re: /^\s+|\s+$/gm,             repl: '' },
    { re: /\s+([.,;:!?])/g,          repl: '$1' },
    { re: /([.,;:!?])(?=[A-Za-z])/g, repl: '$1 ' },
  ];

  // ── Utilities ─────────────────────────────────────────────────────────────

  function esc(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function capitalizeFirst(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

  function preserveCase(original, replacement) {
    if (!replacement) return replacement;
    if (original[0] === original[0].toUpperCase()) return capitalizeFirst(replacement);
    return replacement;
  }

  // ── Optimizers (one-shot mode) ────────────────────────────────────────────

  function applyRedundant(text, changes) {
    for (const [verbose, concise] of SORTED_REDUNDANT) {
      const re = new RegExp('\\b' + esc(verbose) + '\\b', 'gi');
      text = text.replace(re, (match) => {
        const rep = preserveCase(match, concise);
        changes.push({ type:'redundant', original:match, replacement:rep, confidence:0.92,
          explanation:`"${match}" is redundant — "${concise}" already implies the modifier.` });
        return rep;
      });
    }
    return text;
  }

  function applyPhrases(text, changes) {
    for (const [verbose, concise] of SORTED_PHRASES) {
      const re = new RegExp('\\b' + esc(verbose) + '\\b', 'gi');
      text = text.replace(re, (match) => {
        const rep = preserveCase(match, concise);
        changes.push({ type:'phrase', original:match, replacement:rep || '(removed)', confidence:0.88,
          explanation: concise ? `"${match}" → "${concise}"` : `"${match}" can be removed.` });
        return rep;
      });
    }
    return text;
  }

  function applyCeremony(text, changes) {
    for (const entry of PROMPT_CEREMONY) {
      const re = new RegExp(entry.re.source, entry.re.flags);
      text = text.replace(re, (match) => {
        if (!match.trim()) return match;
        changes.push({ type:'ceremony', original:match.trim(), replacement:entry.replacement||'(removed)',
          confidence:0.78, explanation:`Removed ${entry.label}: LLMs don't need social niceties.` });
        return entry.replacement;
      });
    }
    return text;
  }

  function applyFiller(text, changes) {
    for (const word of FILLER_WORDS) {
      // Match optional leading space + filler word + optional trailing whitespace
      // This catches fillers mid-sentence AND at end-of-sentence (before punctuation)
      const re = new RegExp('\\s*\\b' + esc(word) + '\\b\\s*', 'gi');
      text = text.replace(re, (match) => {
        // Only record if the match contains more than just whitespace
        const trimmed = match.trim();
        if (!trimmed) return match;
        changes.push({ type:'filler', original:trimmed, replacement:'(removed)',
          confidence:0.65, explanation:`"${trimmed}" is a filler word.` });
        // Preserve a single space if the match had text on both sides
        // (i.e., was mid-sentence, not at start/end)
        return ' ';
      });
    }
    return text;
  }

  function applyWhitespace(text, changes) {
    const before = text;
    for (const r of WHITESPACE_RULES) text = text.replace(r.re, r.repl);
    text = text.trim();
    if (text !== before) changes.push({ type:'whitespace', original:'(whitespace)',
      replacement:'(normalized)', confidence:1.0, explanation:'Collapsed extra whitespace.' });
    return text;
  }

  function repairCaps(text) {
    return text
      .replace(/(^|[.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase())
      .replace(/^([a-z])/, (_, c) => c.toUpperCase());
  }

  // ── optimizePrompt ────────────────────────────────────────────────────────

  function optimizePrompt(text, options) {
    options = options || {};
    const opts = {
      removeFiller:    options.removeFiller    !== false,
      removeCeremony:  options.removeCeremony  !== false,
      compressPhrases: options.compressPhrases !== false,
      removeRedundant: options.removeRedundant !== false,
      model:           options.model || 'gpt-4o',
    };

    if (!text || typeof text !== 'string') {
      return { original:text||'', optimized:text||'', changes:[], tokensBefore:0,
        tokensAfter:0, savings:{saved:0,percentage:0,costSaved:0,model:opts.model}, confidence:1.0 };
    }

    const original      = text;
    const tokensBefore  = countTok(original, opts.model);
    const changes       = [];
    let   result        = text;

    if (opts.removeRedundant) result = applyRedundant(result, changes);
    if (opts.compressPhrases) result = applyPhrases(result, changes);
    if (opts.removeCeremony)  result = applyCeremony(result, changes);
    if (opts.removeFiller)    result = applyFiller(result, changes);
    result = applyWhitespace(result, changes);
    result = repairCaps(result);

    const tokensAfter  = countTok(result, opts.model);
    const tok          = getTokenizer();
    const savings      = tok
      ? tok.estimateSavings(tokensBefore, tokensAfter, opts.model)
      : { saved: tokensBefore - tokensAfter, percentage: 0, costSaved: 0, model: opts.model };

    const meaningful   = changes.filter(c => c.type !== 'whitespace');
    const confidence   = meaningful.length
      ? parseFloat((meaningful.reduce((s,c) => s + c.confidence, 0) / meaningful.length).toFixed(2))
      : 1.0;

    return { original, optimized:result, changes, tokensBefore, tokensAfter, savings, confidence };
  }

  // ── getSuggestions (interactive mode) ────────────────────────────────────
  // Returns positioned suggestions for the inline UI (Grammarly-style).

  let _idCounter = 0;
  function nextId() { return 'sug_' + (++_idCounter); }
  function severity(c) { return c >= 0.85 ? 'high' : c >= 0.65 ? 'medium' : 'low'; }

  function getSuggestions(text, model) {
    if (!text || typeof text !== 'string' || !text.trim()) return [];

    const raw    = [];
    const ranges = []; // [{start, end}] — overlap guard

    function overlaps(s, e) {
      return ranges.some(r => s < r.end && e > r.start);
    }
    function record(s, e) { ranges.push({ start:s, end:e }); }

    // ── Redundant modifiers ─────────────────────────────────────────────
    for (const [verbose, concise] of SORTED_REDUNDANT) {
      const re = new RegExp('\\b' + esc(verbose) + '\\b', 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        const s = m.index, e = s + m[0].length;
        if (overlaps(s, e)) continue;
        record(s, e);
        raw.push({ id:nextId(), type:'redundant', original:m[0], replacement:concise,
          confidence:0.92, explanation:`"${m[0]}" is redundant.`,
          tokensSaved: countTok(m[0]) - countTok(concise), startIndex:s, endIndex:e });
      }
    }

    // ── Verbose phrases ─────────────────────────────────────────────────
    for (const [verbose, concise] of SORTED_PHRASES) {
      const re = new RegExp('\\b' + esc(verbose) + '\\b', 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        const s = m.index, e = s + m[0].length;
        if (overlaps(s, e)) continue;
        record(s, e);
        const conf = concise ? 0.88 : 0.80;
        raw.push({ id:nextId(), type:'phrase', original:m[0],
          replacement: concise || '(remove)', confidence:conf,
          explanation: concise ? `"${m[0]}" → "${concise}"` : `"${m[0]}" can be removed.`,
          tokensSaved: countTok(m[0]) - countTok(concise||''), startIndex:s, endIndex:e });
      }
    }

    // ── Ceremony ────────────────────────────────────────────────────────
    for (const entry of PROMPT_CEREMONY) {
      const re = new RegExp(entry.re.source, entry.re.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!m[0].trim()) continue;
        const s = m.index, e = s + m[0].length;
        if (overlaps(s, e)) continue;
        record(s, e);
        raw.push({ id:nextId(), type:'ceremony', original:m[0].trim(),
          replacement: entry.replacement || '(remove)', confidence:0.78,
          explanation: `Remove ${entry.label}: LLMs don't need social niceties.`,
          tokensSaved: countTok(m[0]) - countTok(entry.replacement||''), startIndex:s, endIndex:e });
        if (!entry.re.global) break;
      }
    }

    // ── Filler words ────────────────────────────────────────────────────
    for (const word of FILLER_WORDS) {
      const re = new RegExp('\\b' + esc(word) + '\\b', 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        const s = m.index, e = s + m[0].length;
        if (overlaps(s, e)) continue;
        record(s, e);
        raw.push({ id:nextId(), type:'filler', original:m[0], replacement:'(remove)',
          confidence:0.65, explanation:`"${m[0]}" is a filler word.`,
          tokensSaved: countTok(m[0]), startIndex:s, endIndex:e });
      }
    }

    // ── Apply context-aware confidence scoring ───────────────────────────
    const scored = applyConf(text, raw);

    // ── Sort by position + add severity ─────────────────────────────────
    return scored
      .map(s => ({ ...s, severity: severity(s.confidence) }))
      .sort((a, b) => a.startIndex - b.startIndex);
  }

  // ── applySuggestions ──────────────────────────────────────────────────────

  function applySuggestions(text, suggestions, acceptedIds) {
    const toApply = acceptedIds
      ? suggestions.filter(s => acceptedIds.includes(s.id))
      : suggestions;

    // Apply in reverse order to preserve string indices
    const sorted = toApply.slice().sort((a, b) => b.startIndex - a.startIndex);
    let result = text;
    for (const sug of sorted) {
      const rep = sug.replacement === '(remove)' ? '' : (sug.replacement || '');
      result = result.slice(0, sug.startIndex) + rep + result.slice(sug.endIndex);
    }
    return result.replace(/  +/g, ' ').trim();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  const ENGINE_VERSION = '5.0.0';

  const api = {
    optimizePrompt,
    getSuggestions,
    applySuggestions,
    countTokens:     (text, model) => countTok(text, model),
    estimateSavings: (before, after, model) => {
      const tok = getTokenizer();
      return tok ? tok.estimateSavings(before, after, model)
                 : { saved:before-after, percentage:0, costSaved:0, model:model||'gpt-4o' };
    },
    availableModels: () => {
      const tok = getTokenizer();
      return tok ? tok.availableModels() : ['gpt-4o','gpt-4o-mini','claude-3.5-sonnet'];
    },
    version: ENGINE_VERSION,
    // Expose rule dictionaries for consumers (VS Code extension, tests)
    PHRASE_REPLACEMENTS,
    FILLER_WORDS,
    REDUNDANT_MODIFIERS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DensifyEngine = api;

  console.debug(`[Densify] Engine v${ENGINE_VERSION} loaded`);

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
