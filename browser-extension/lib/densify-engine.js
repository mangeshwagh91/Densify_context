// ─────────────────────────────────────────────────────────────────
//  densify-engine.js — Self-contained, universal prompt optimizer
// ─────────────────────────────────────────────────────────────────
//  Works in: Browser (content script, popup, service worker),
//            Node.js (VS Code extension), Deno, any JS runtime.
//
//  Exposes: globalThis.DensifyEngine = { optimizePrompt, countTokens,
//           getSuggestions, applySuggestions, estimateSavings,
//           availableModels, PHRASE_REPLACEMENTS, FILLER_WORDS,
//           REDUNDANT_MODIFIERS }
// ─────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  // ═══════════════════════════════════════════════════════
  //  RULES
  // ═══════════════════════════════════════════════════════

  const PHRASE_REPLACEMENTS = new Map([
    ['in order to', 'to'],
    ['for the purpose of', 'to'],
    ['with the aim of', 'to'],
    ['so as to', 'to'],
    ['with the intention of', 'to'],
    ['with the goal of', 'to'],
    ['with the objective of', 'to'],
    ['due to the fact that', 'because'],
    ['owing to the fact that', 'because'],
    ['on account of the fact that', 'because'],
    ['for the reason that', 'because'],
    ['by virtue of the fact that', 'because'],
    ['in light of the fact that', 'since'],
    ['given the fact that', 'since'],
    ['considering the fact that', 'since'],
    ['in the event that', 'if'],
    ['on the condition that', 'if'],
    ['in the case that', 'if'],
    ['provided that', 'if'],
    ['assuming that', 'if'],
    ['in a situation where', 'when'],
    ['at this point in time', 'now'],
    ['at the present time', 'now'],
    ['at the current moment', 'now'],
    ['at this moment in time', 'now'],
    ['in the near future', 'soon'],
    ['at a later date', 'later'],
    ['prior to', 'before'],
    ['subsequent to', 'after'],
    ['in advance of', 'before'],
    ['for the duration of', 'during'],
    ['with regard to', 'about'],
    ['with respect to', 'about'],
    ['in relation to', 'about'],
    ['pertaining to', 'about'],
    ['in reference to', 'about'],
    ['on the subject of', 'about'],
    ['in terms of', 'regarding'],
    ['as it relates to', 'regarding'],
    ['a large number of', 'many'],
    ['a great number of', 'many'],
    ['a significant number of', 'many'],
    ['a considerable amount of', 'much'],
    ['a wide range of', 'various'],
    ['a variety of', 'various'],
    ['a small number of', 'few'],
    ['the vast majority of', 'most'],
    ['a majority of', 'most'],
    ['each and every', 'every'],
    ['is able to', 'can'],
    ['has the ability to', 'can'],
    ['has the capacity to', 'can'],
    ['it is possible to', 'can'],
    ['it is possible that', 'may'],
    ['there is a possibility that', 'may'],
    ['are able to', 'can'],
    ['was able to', 'could'],
    ['were able to', 'could'],
    ['it is important to note that', ''],
    ['it should be noted that', ''],
    ['it is worth mentioning that', ''],
    ['it goes without saying that', ''],
    ['needless to say', ''],
    ['as a matter of fact', ''],
    ['the thing is that', ''],
    ['what i mean is', ''],
    ['it is essential that', 'must'],
    ['it is necessary to', 'must'],
    ['it is crucial that', 'must'],
    ['i would like you to', ''],
    ['i would appreciate it if you could', ''],
    ['i was wondering if you could', ''],
    ['would you be so kind as to', ''],
    ['could you please', ''],
    ['can you please', ''],
    ['please be so kind as to', ''],
    ['i need you to', ''],
    ['i want you to', ''],
    ['would it be possible for you to', ''],
    ['in addition to this', 'also'],
    ['in addition to that', 'also'],
    ['on top of that', 'also'],
    ['furthermore', 'also'],
    ['moreover', 'also'],
    ['as well as', 'and'],
    ['in conjunction with', 'with'],
    ['together with', 'with'],
    ['along with', 'with'],
    ['in comparison to', 'compared to'],
    ['in contrast to', 'unlike'],
    ['as opposed to', 'unlike'],
    ['on the other hand', 'conversely'],
    ['as a result of', 'from'],
    ['as a consequence of', 'from'],
    ['for this reason', 'so'],
    ['because of this', 'so'],
    ['as a result', 'so'],
    ['in conclusion', 'finally'],
    ['to summarize', 'in short'],
    ['in summary', 'in short'],
    ['all things considered', 'overall'],
    ['in the process of', 'while'],
    ['in the midst of', 'during'],
    ['on a daily basis', 'daily'],
    ['on a regular basis', 'regularly'],
    ['at all times', 'always'],
    ['in most cases', 'usually'],
    ['in some cases', 'sometimes'],
    ['despite the fact that', 'although'],
    ['regardless of the fact that', 'although'],
    ['notwithstanding the fact that', 'although'],
    ['in spite of the fact that', 'although'],
    ['whether or not', 'whether'],
    ['the reason why is that', 'because'],
    ['until such time as', 'until'],
    ['in close proximity to', 'near'],
    ['a sufficient amount of', 'enough'],
    ['make a decision', 'decide'],
    ['come to the conclusion', 'conclude'],
    ['take into consideration', 'consider'],
    ['take into account', 'consider'],
    ['give an indication of', 'indicate'],
    ['have a tendency to', 'tend to'],
    ['make an attempt to', 'try to'],
    ['is indicative of', 'indicates'],
    ['has an impact on', 'affects'],
    ['is dependent on', 'depends on'],
  ]);

  const FILLER_WORDS = new Set([
    'basically', 'actually', 'really', 'very', 'just', 'quite', 'rather',
    'simply', 'literally', 'definitely', 'certainly', 'absolutely',
    'obviously', 'clearly', 'honestly', 'frankly', 'personally',
    'essentially', 'practically', 'virtually', 'somewhat', 'extremely',
    'incredibly', 'remarkably', 'particularly', 'specifically',
    'especially', 'notably',
  ]);

  const REDUNDANT_MODIFIERS = new Map([
    ['absolutely essential', 'essential'],
    ['absolutely necessary', 'necessary'],
    ['completely unique', 'unique'],
    ['completely finished', 'finished'],
    ['completely eliminate', 'eliminate'],
    ['entirely unique', 'unique'],
    ['totally unique', 'unique'],
    ['very unique', 'unique'],
    ['final outcome', 'outcome'],
    ['end result', 'result'],
    ['past history', 'history'],
    ['future plans', 'plans'],
    ['free gift', 'gift'],
    ['basic fundamentals', 'fundamentals'],
    ['true fact', 'fact'],
    ['added bonus', 'bonus'],
    ['exact same', 'same'],
    ['general consensus', 'consensus'],
    ['brief summary', 'summary'],
    ['close proximity', 'proximity'],
    ['current status', 'status'],
    ['advance warning', 'warning'],
    ['still remains', 'remains'],
    ['repeat again', 'repeat'],
    ['revert back', 'revert'],
    ['join together', 'join'],
    ['merge together', 'merge'],
    ['combine together', 'combine'],
    ['mix together', 'mix'],
  ]);

  const PROMPT_CEREMONY_PATTERNS = [
    { pattern: /^(hi|hello|hey|greetings|good morning|good afternoon|good evening|dear assistant)[,!.\s]*/i, replacement: '', label: 'greeting' },
    { pattern: /\s*(thank you( very much| so much| in advance)?|thanks( a lot| so much| in advance)?|please and thank you|i appreciate (it|your help|any help))[.!]*\s*$/i, replacement: '', label: 'closing politeness' },
    { pattern: /\b(please|kindly)\s+/gi, replacement: '', label: 'politeness filler' },
    { pattern: /^(I have a question[.:]\s*)/i, replacement: '', label: 'instruction framing' },
    { pattern: /^(I('d| would) like (to ask|to know|you to tell me)\s*)/i, replacement: '', label: 'instruction framing' },
    { pattern: /^(My question is[.:]\s*)/i, replacement: '', label: 'instruction framing' },
  ];

  const WHITESPACE_RULES = [
    { pattern: /[ \t]+/g, replacement: ' ' },
    { pattern: /\n{3,}/g, replacement: '\n\n' },
    { pattern: /^\s+|\s+$/gm, replacement: '' },
    { pattern: /\s+([.,;:!?])/g, replacement: '$1' },
    { pattern: /([.,;:!?])(?=[A-Za-z])/g, replacement: '$1 ' },
  ];

  // ═══════════════════════════════════════════════════════
  //  TOKENIZER
  // ═══════════════════════════════════════════════════════

  const MODEL_PRICING = {
    'gpt-4o':        0.0025,
    'gpt-4o-mini':   0.00015,
    'gpt-4-turbo':   0.01,
    'gpt-4':         0.03,
    'gpt-3.5-turbo': 0.0005,
    'claude-3-opus': 0.015,
    'claude-3.5-sonnet': 0.003,
    'claude-3-haiku': 0.00025,
    'claude-4-opus': 0.015,
    'claude-4-sonnet': 0.003,
    'gemini-1.5-pro': 0.00125,
    'gemini-2.5-pro': 0.00125,
  };

  function countTokens(text) {
    if (!text || text.length === 0) return 0;
    let tokens = 0;
    const newlineCount = (text.match(/\n/g) || []).length;
    tokens += newlineCount;
    const segments = text.split(/\s+/).filter(Boolean);
    for (const seg of segments) {
      if (seg.length === 0) continue;
      if (/^[^\w]+$/.test(seg)) { tokens += seg.length; continue; }
      const leading = seg.match(/^[^\w]+/);
      const trailing = seg.match(/[^\w]+$/);
      if (leading) tokens += leading[0].length;
      if (trailing) tokens += trailing[0].length;
      const word = seg.replace(/^[^\w]+/, '').replace(/[^\w]+$/, '');
      if (word.length === 0) continue;
      tokens += word.length <= 4 ? 1 : Math.ceil(word.length / 4);
    }
    return Math.max(1, tokens);
  }

  function estimateSavings(originalTokens, optimizedTokens, model) {
    model = model || 'gpt-4o';
    const saved = originalTokens - optimizedTokens;
    const percentage = originalTokens > 0 ? Math.round((saved / originalTokens) * 100) : 0;
    const pricePerK = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o'];
    const costSaved = parseFloat(((saved / 1000) * pricePerK).toFixed(6));
    return { saved: saved, percentage: percentage, costSaved: costSaved, model: model };
  }

  function availableModels() {
    return Object.keys(MODEL_PRICING);
  }

  // ═══════════════════════════════════════════════════════
  //  OPTIMIZER
  // ═══════════════════════════════════════════════════════

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function applyRedundantModifiers(text, changes) {
    for (var entry of REDUNDANT_MODIFIERS) {
      var verbose = entry[0], concise = entry[1];
      var regex = new RegExp('\\b' + escapeRegex(verbose) + '\\b', 'gi');
      if (regex.test(text)) {
        text = text.replace(regex, function (match) {
          changes.push({
            type: 'redundant', original: match, replacement: concise,
            confidence: 0.92,
            explanation: '"' + match + '" is redundant — "' + concise + '" already implies the modifier.'
          });
          return match[0] === match[0].toUpperCase() ? capitalizeFirst(concise) : concise;
        });
      }
    }
    return text;
  }

  function applyPhraseReplacements(text, changes) {
    var sorted = Array.from(PHRASE_REPLACEMENTS.entries()).sort(function (a, b) { return b[0].length - a[0].length; });
    for (var i = 0; i < sorted.length; i++) {
      var verbose = sorted[i][0], concise = sorted[i][1];
      var regex = new RegExp('\\b' + escapeRegex(verbose) + '\\b', 'gi');
      if (regex.test(text)) {
        regex.lastIndex = 0;
        text = text.replace(regex, function (match) {
          changes.push({
            type: 'phrase', original: match, replacement: concise || '(removed)',
            confidence: 0.88,
            explanation: concise
              ? '"' + match + '" → "' + concise + '" (same meaning, fewer tokens)'
              : '"' + match + '" is unnecessary filler and can be removed.'
          });
          return concise;
        });
      }
    }
    return text;
  }

  function applyPromptCeremony(text, changes) {
    for (var i = 0; i < PROMPT_CEREMONY_PATTERNS.length; i++) {
      var entry = PROMPT_CEREMONY_PATTERNS[i];
      var regex = new RegExp(entry.pattern.source, entry.pattern.flags);
      var replacement = entry.replacement;
      var label = entry.label;
      var hadMatch = false;
      var replaced = text.replace(regex, function (fullMatch) {
        if (fullMatch.trim().length > 0) {
          hadMatch = true;
          changes.push({
            type: 'ceremony', original: fullMatch.trim(),
            replacement: replacement || '(removed)', confidence: 0.78,
            explanation: 'Removed ' + label + ': "' + fullMatch.trim() + '" — LLMs don\'t need social niceties.'
          });
        }
        return replacement;
      });
      if (hadMatch) text = replaced;
    }
    return text;
  }

  function applyFillerWordRemoval(text, changes) {
    for (var filler of FILLER_WORDS) {
      var regex = new RegExp('\\b' + escapeRegex(filler) + '\\s+', 'gi');
      if (regex.test(text)) {
        regex.lastIndex = 0;
        text = text.replace(regex, function (match) {
          changes.push({
            type: 'filler', original: match.trim(), replacement: '(removed)',
            confidence: 0.65,
            explanation: '"' + match.trim() + '" is a filler word that adds no meaning.'
          });
          return '';
        });
      }
    }
    return text;
  }

  function applyWhitespaceNormalization(text, changes) {
    var before = text;
    for (var i = 0; i < WHITESPACE_RULES.length; i++) {
      text = text.replace(WHITESPACE_RULES[i].pattern, WHITESPACE_RULES[i].replacement);
    }
    text = text.trim();
    if (text !== before) {
      changes.push({
        type: 'whitespace', original: '(whitespace)', replacement: '(normalized)',
        confidence: 1.0, explanation: 'Collapsed extra whitespace and fixed punctuation spacing.'
      });
    }
    return text;
  }

  function repairCapitalization(text) {
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, function (_, prefix, char) {
      return prefix + char.toUpperCase();
    });
    if (text.length > 0 && /[a-z]/.test(text[0])) text = capitalizeFirst(text);
    return text;
  }

  function optimizePrompt(text, options) {
    options = options || {};
    var removeFiller = options.removeFiller !== false;
    var removeCeremony = options.removeCeremony !== false;
    var compressPhrases = options.compressPhrases !== false;
    var removeRedundant = options.removeRedundant !== false;
    var model = options.model || 'gpt-4o';

    if (!text || typeof text !== 'string') {
      return {
        original: text || '', optimized: text || '', changes: [],
        tokensBefore: 0, tokensAfter: 0,
        savings: { saved: 0, percentage: 0, costSaved: 0, model: model },
        confidence: 1.0
      };
    }

    var original = text;
    var changes = [];
    var tokensBefore = countTokens(original);
    var result = text;

    if (removeRedundant) result = applyRedundantModifiers(result, changes);
    if (compressPhrases) result = applyPhraseReplacements(result, changes);
    if (removeCeremony) result = applyPromptCeremony(result, changes);
    if (removeFiller) result = applyFillerWordRemoval(result, changes);

    result = applyWhitespaceNormalization(result, changes);
    result = repairCapitalization(result);

    var tokensAfter = countTokens(result);
    var savings = estimateSavings(tokensBefore, tokensAfter, model);

    var meaningfulChanges = changes.filter(function (c) { return c.type !== 'whitespace'; });
    var confidence = meaningfulChanges.length > 0
      ? parseFloat((meaningfulChanges.reduce(function (sum, c) { return sum + c.confidence; }, 0) / meaningfulChanges.length).toFixed(2))
      : 1.0;

    return {
      original: original, optimized: result, changes: changes,
      tokensBefore: tokensBefore, tokensAfter: tokensAfter,
      savings: savings, confidence: confidence
    };
  }

  // ═══════════════════════════════════════════════════════
  //  SUGGESTIONS
  // ═══════════════════════════════════════════════════════

  var suggestionCounter = 0;
  function nextId() { return 'sug_' + (++suggestionCounter); }
  function severity(conf) { return conf >= 0.85 ? 'high' : conf >= 0.65 ? 'medium' : 'low'; }

  function getSuggestions(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return [];

    var suggestions = [];
    var matchedRanges = [];

    function overlaps(start, end) {
      return matchedRanges.some(function (r) {
        return (start >= r.start && start < r.end) || (end > r.start && end <= r.end);
      });
    }
    function recordRange(start, end) { matchedRanges.push({ start: start, end: end }); }

    // Redundant modifiers
    for (var entry of REDUNDANT_MODIFIERS) {
      var verbose = entry[0], concise = entry[1];
      var regex = new RegExp('\\b' + escapeRegex(verbose) + '\\b', 'gi');
      var match;
      while ((match = regex.exec(text)) !== null) {
        var start = match.index, end = start + match[0].length;
        if (!overlaps(start, end)) {
          recordRange(start, end);
          suggestions.push({
            id: nextId(), type: 'redundant', original: match[0], replacement: concise,
            confidence: 0.92, explanation: '"' + match[0] + '" is redundant.',
            tokensSaved: countTokens(match[0]) - countTokens(concise),
            startIndex: start, endIndex: end, severity: severity(0.92)
          });
        }
      }
    }

    // Verbose phrases
    var sortedPhrases = Array.from(PHRASE_REPLACEMENTS.entries()).sort(function (a, b) { return b[0].length - a[0].length; });
    for (var i = 0; i < sortedPhrases.length; i++) {
      var verbose = sortedPhrases[i][0], concise = sortedPhrases[i][1];
      var regex = new RegExp('\\b' + escapeRegex(verbose) + '\\b', 'gi');
      var match;
      while ((match = regex.exec(text)) !== null) {
        var start = match.index, end = start + match[0].length;
        if (!overlaps(start, end)) {
          recordRange(start, end);
          var conf = concise ? 0.88 : 0.80;
          suggestions.push({
            id: nextId(), type: 'phrase', original: match[0],
            replacement: concise || '(remove)', confidence: conf,
            explanation: concise ? '"' + match[0] + '" → "' + concise + '"' : '"' + match[0] + '" can be removed.',
            tokensSaved: countTokens(match[0]) - countTokens(concise || ''),
            startIndex: start, endIndex: end, severity: severity(conf)
          });
        }
      }
    }

    // Ceremony
    for (var i = 0; i < PROMPT_CEREMONY_PATTERNS.length; i++) {
      var entry = PROMPT_CEREMONY_PATTERNS[i];
      var regex = new RegExp(entry.pattern.source, entry.pattern.flags);
      var match;
      while ((match = regex.exec(text)) !== null) {
        if (match[0].trim().length === 0) continue;
        var start = match.index, end = start + match[0].length;
        if (!overlaps(start, end)) {
          recordRange(start, end);
          suggestions.push({
            id: nextId(), type: 'ceremony', original: match[0].trim(),
            replacement: entry.replacement || '(remove)', confidence: 0.78,
            explanation: 'Remove ' + entry.label + ': LLMs don\'t need social niceties.',
            tokensSaved: countTokens(match[0]) - countTokens(entry.replacement || ''),
            startIndex: start, endIndex: end, severity: severity(0.78)
          });
        }
        if (!entry.pattern.global) break;
      }
    }

    // Filler words
    for (var filler of FILLER_WORDS) {
      var regex = new RegExp('\\b' + escapeRegex(filler) + '\\b', 'gi');
      var match;
      while ((match = regex.exec(text)) !== null) {
        var start = match.index, end = start + match[0].length;
        if (!overlaps(start, end)) {
          recordRange(start, end);
          suggestions.push({
            id: nextId(), type: 'filler', original: match[0], replacement: '(remove)',
            confidence: 0.65, explanation: '"' + match[0] + '" is a filler word.',
            tokensSaved: countTokens(match[0]),
            startIndex: start, endIndex: end, severity: severity(0.65)
          });
        }
      }
    }

    suggestions.sort(function (a, b) { return a.startIndex - b.startIndex; });
    return suggestions;
  }

  function applySuggestions(text, suggestions, acceptedIds) {
    var toApply = acceptedIds
      ? suggestions.filter(function (s) { return acceptedIds.indexOf(s.id) !== -1; })
      : suggestions;
    var sorted = toApply.slice().sort(function (a, b) { return b.startIndex - a.startIndex; });
    var result = text;
    for (var i = 0; i < sorted.length; i++) {
      var sug = sorted[i];
      var replacement = sug.replacement === '(remove)' ? '' : sug.replacement;
      result = result.slice(0, sug.startIndex) + replacement + result.slice(sug.endIndex);
    }
    return result.replace(/  +/g, ' ').trim();
  }

  // ═══════════════════════════════════════════════════════
  //  EXPORT
  // ═══════════════════════════════════════════════════════

  var api = {
    optimizePrompt: optimizePrompt,
    countTokens: countTokens,
    estimateSavings: estimateSavings,
    availableModels: availableModels,
    getSuggestions: getSuggestions,
    applySuggestions: applySuggestions,
    PHRASE_REPLACEMENTS: PHRASE_REPLACEMENTS,
    FILLER_WORDS: FILLER_WORDS,
    REDUNDANT_MODIFIERS: REDUNDANT_MODIFIERS,
  };

  // Universal module export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DensifyEngine = api;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
