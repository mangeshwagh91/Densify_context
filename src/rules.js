// ─────────────────────────────────────────────────────────
//  rules.js — Rule dictionaries for prompt compression
// ─────────────────────────────────────────────────────────
//  Every rule is deterministic and reversible in concept:
//  we only swap phrases that preserve the original intent.
// ─────────────────────────────────────────────────────────

/**
 * Verbose phrase → concise replacement.
 * Sorted roughly by frequency of occurrence in real prompts.
 * All keys are lowercase for case-insensitive matching.
 */
export const PHRASE_REPLACEMENTS = new Map([
  // ── Causation & Purpose ───────────────────────────
  ['in order to', 'to'],
  ['for the purpose of', 'to'],
  ['with the aim of', 'to'],
  ['so as to', 'to'],
  ['with the intention of', 'to'],
  ['with the goal of', 'to'],
  ['with the objective of', 'to'],

  // ── Reason & Cause ────────────────────────────────
  ['due to the fact that', 'because'],
  ['owing to the fact that', 'because'],
  ['on account of the fact that', 'because'],
  ['for the reason that', 'because'],
  ['by virtue of the fact that', 'because'],
  ['in light of the fact that', 'since'],
  ['given the fact that', 'since'],
  ['considering the fact that', 'since'],

  // ── Conditionals ──────────────────────────────────
  ['in the event that', 'if'],
  ['on the condition that', 'if'],
  ['in the case that', 'if'],
  ['provided that', 'if'],
  ['assuming that', 'if'],
  ['in a situation where', 'when'],

  // ── Time ──────────────────────────────────────────
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

  // ── Relation & Topic ──────────────────────────────
  ['with regard to', 'about'],
  ['with respect to', 'about'],
  ['in relation to', 'about'],
  ['pertaining to', 'about'],
  ['in reference to', 'about'],
  ['on the subject of', 'about'],
  ['in terms of', 'regarding'],
  ['as it relates to', 'regarding'],

  // ── Quantity ───────────────────────────────────────
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

  // ── Ability & Possibility ─────────────────────────
  ['is able to', 'can'],
  ['has the ability to', 'can'],
  ['has the capacity to', 'can'],
  ['it is possible to', 'can'],
  ['it is possible that', 'may'],
  ['there is a possibility that', 'may'],
  ['are able to', 'can'],
  ['was able to', 'could'],
  ['were able to', 'could'],

  // ── Emphasis / Hedging ────────────────────────────
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

  // ── Polite Filler (prompt-specific) ───────────────
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

  // ── Transition / Connector bloat ──────────────────
  ['in addition to this', 'also'],
  ['in addition to that', 'also'],
  ['on top of that', 'also'],
  ['furthermore', 'also'],
  ['moreover', 'also'],
  ['as well as', 'and'],
  ['in conjunction with', 'with'],
  ['together with', 'with'],
  ['along with', 'with'],

  // ── Comparison ────────────────────────────────────
  ['in comparison to', 'compared to'],
  ['in contrast to', 'unlike'],
  ['as opposed to', 'unlike'],
  ['on the other hand', 'conversely'],

  // ── Conclusion / Result ───────────────────────────
  ['as a result of', 'from'],
  ['as a consequence of', 'from'],
  ['for this reason', 'so'],
  ['because of this', 'so'],
  ['as a result', 'so'],
  ['in conclusion', 'finally'],
  ['to summarize', 'in short'],
  ['in summary', 'in short'],
  ['all things considered', 'overall'],

  // ── Approximation / Qualification ─────────────────
  ['in the process of', 'while'],
  ['in the midst of', 'during'],
  ['on a daily basis', 'daily'],
  ['on a regular basis', 'regularly'],
  ['at all times', 'always'],
  ['in most cases', 'usually'],
  ['in some cases', 'sometimes'],

  // ── Miscellaneous ─────────────────────────────────
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

/**
 * Filler words that can be safely removed when they appear
 * as standalone modifiers (not part of a larger meaning unit).
 * We only remove them when surrounded by word boundaries.
 */
export const FILLER_WORDS = new Set([
  'basically',
  'actually',
  'really',
  'very',
  'just',
  'quite',
  'rather',
  'simply',
  'literally',
  'definitely',
  'certainly',
  'absolutely',
  'obviously',
  'clearly',
  'honestly',
  'frankly',
  'personally',
  'essentially',
  'practically',
  'virtually',
  'somewhat',
  'extremely',
  'incredibly',
  'remarkably',
  'particularly',
  'specifically',
  'especially',
  'notably',
]);

/**
 * Redundant modifier pairs — the adjective adds no information.
 * E.g.  "completely unique" → "unique"
 */
export const REDUNDANT_MODIFIERS = new Map([
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

/**
 * Prompt-specific prefix patterns that are pure ceremony.
 * Matched as RegExp objects (case-insensitive).
 */
export const PROMPT_CEREMONY_PATTERNS = [
  // Greetings
  { pattern: /^(hi|hello|hey|greetings|good morning|good afternoon|good evening|dear assistant)[,!.\s]*/i, replacement: '', label: 'greeting' },

  // Closings / politeness trailers
  { pattern: /\s*(thank you( very much| so much| in advance)?|thanks( a lot| so much| in advance)?|please and thank you|i appreciate (it|your help|any help))[.!]*\s*$/i, replacement: '', label: 'closing politeness' },

  // Meta-commentary
  { pattern: /\b(please|kindly)\s+/gi, replacement: '', label: 'politeness filler' },

  // Instruction framing
  { pattern: /^(I have a question[.:]\s*)/i, replacement: '', label: 'instruction framing' },
  { pattern: /^(I('d| would) like (to ask|to know|you to tell me)\s*)/i, replacement: '', label: 'instruction framing' },
  { pattern: /^(My question is[.:]\s*)/i, replacement: '', label: 'instruction framing' },
];

/**
 * Whitespace normalization rules (always applied last).
 */
export const WHITESPACE_RULES = [
  { pattern: /[ \t]+/g, replacement: ' ' },           // collapse horizontal whitespace
  { pattern: /\n{3,}/g, replacement: '\n\n' },         // max 2 consecutive newlines
  { pattern: /^\s+|\s+$/gm, replacement: '' },         // trim each line
  { pattern: /\s+([.,;:!?])/g, replacement: '$1' },    // no space before punctuation
  { pattern: /([.,;:!?])(?=[A-Za-z])/g, replacement: '$1 ' }, // space after punctuation
];
