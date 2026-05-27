// ─────────────────────────────────────────────────────────────────────────────
//  lib/rules-registry.js  —  Declarative Rule DSL + Registry  (Phase 2.5)
//
//  Replaces hardcoded arrays in densify-engine.js with a structured,
//  versioned, pluggable rule system.
//
//  Rule schema:
//  {
//    id:          string        — unique identifier (e.g. "phrase.in_order_to")
//    category:    string        — 'phrase'|'filler'|'redundant'|'ceremony'|'lint'
//    match:       string|RegExp — what to find (string = word-boundary wrapped)
//    replace:     string        — '' means remove; undefined = no autofix
//    severity:    'error'|'warning'|'info'
//    confidence:  number        — 0–1 static baseline
//    tokenAware:  boolean       — if true, only suggest when tokensSaved >= 1
//    description: string        — human-readable explanation
//    autofix:     boolean       — whether replace is safe to auto-apply
//    tags:        string[]      — searchable tags
//    since:       string        — version this rule was added
//  }
//
//  Performance: rules are compiled to RegExp at registry-load time and cached.
//  A single JSON/object rule definition adds ~0.01ms overhead at startup.
// ─────────────────────────────────────────────────────────────────────────────
;(function (root) {
  'use strict';

  // ── Rule DSL schema validator ─────────────────────────────────────────────

  const REQUIRED_FIELDS  = ['id', 'category', 'match', 'severity', 'description'];
  const VALID_CATEGORIES = new Set(['phrase','filler','redundant','ceremony','lint','structural']);
  const VALID_SEVERITIES = new Set(['error','warning','info','hint']);

  function validateRule(rule) {
    for (const f of REQUIRED_FIELDS) {
      if (rule[f] === undefined || rule[f] === null)
        throw new Error(`[RulesRegistry] Rule "${rule.id || '?'}" missing required field: ${f}`);
    }
    if (!VALID_CATEGORIES.has(rule.category))
      throw new Error(`[RulesRegistry] Rule "${rule.id}" has invalid category: ${rule.category}`);
    if (!VALID_SEVERITIES.has(rule.severity))
      throw new Error(`[RulesRegistry] Rule "${rule.id}" has invalid severity: ${rule.severity}`);
    return true;
  }

  // ── Compile a rule's match into a cached RegExp ───────────────────────────

  const _compiled = new Map(); // id → RegExp

  function compileRule(rule) {
    if (_compiled.has(rule.id)) return _compiled.get(rule.id);
    let re;
    if (rule.match instanceof RegExp) {
      re = new RegExp(rule.match.source, rule.match.flags.includes('i') ? 'gi' : 'gi');
    } else {
      // String → word-boundary wrapped, case-insensitive, global
      const esc = String(rule.match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp('\\b' + esc + '\\b', 'gi');
    }
    _compiled.set(rule.id, re);
    return re;
  }

  // ── Built-in rule definitions ─────────────────────────────────────────────
  // Single source of truth. All rules from densify-engine.js now live here.

  const BUILTIN_RULES = [

    // ── PHRASES ─────────────────────────────────────────────────────────────

    { id:'phrase.in_order_to',      category:'phrase', match:'in order to',         replace:'to',        severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"in order to" → "to"',                since:'1.0.0', tags:['verbose','concision'] },
    { id:'phrase.for_the_purpose',  category:'phrase', match:'for the purpose of',  replace:'to',        severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"for the purpose of" → "to"',          since:'1.0.0', tags:['verbose'] },
    { id:'phrase.with_the_aim',     category:'phrase', match:'with the aim of',     replace:'to',        severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"with the aim of" → "to"',             since:'1.0.0', tags:['verbose'] },
    { id:'phrase.so_as_to',         category:'phrase', match:'so as to',            replace:'to',        severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"so as to" → "to"',                    since:'1.0.0', tags:['verbose'] },
    { id:'phrase.with_the_intention',category:'phrase',match:'with the intention of',replace:'to',       severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"with the intention of" → "to"',       since:'1.0.0', tags:['verbose'] },
    { id:'phrase.due_to_fact',      category:'phrase', match:'due to the fact that', replace:'because',  severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"due to the fact that" → "because"',   since:'1.0.0', tags:['verbose','causation'] },
    { id:'phrase.owing_to_fact',    category:'phrase', match:'owing to the fact that',replace:'because', severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"owing to the fact that" → "because"', since:'1.0.0', tags:['verbose'] },
    { id:'phrase.on_account_fact',  category:'phrase', match:'on account of the fact that',replace:'because',severity:'info',confidence:0.88,autofix:true,tokenAware:true,  description:'Verbose causation phrase',              since:'1.0.0', tags:['verbose'] },
    { id:'phrase.in_event_that',    category:'phrase', match:'in the event that',   replace:'if',        severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"in the event that" → "if"',           since:'1.0.0', tags:['verbose','conditional'] },
    { id:'phrase.at_this_point',    category:'phrase', match:'at this point in time',replace:'now',      severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"at this point in time" → "now"',      since:'1.0.0', tags:['verbose','time'] },
    { id:'phrase.at_present_time',  category:'phrase', match:'at the present time', replace:'now',       severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"at the present time" → "now"',        since:'1.0.0', tags:['verbose','time'] },
    { id:'phrase.in_near_future',   category:'phrase', match:'in the near future',  replace:'soon',      severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"in the near future" → "soon"',        since:'1.0.0', tags:['verbose','time'] },
    { id:'phrase.prior_to',         category:'phrase', match:'prior to',            replace:'before',    severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"prior to" → "before"',                since:'1.0.0', tags:['verbose','time'] },
    { id:'phrase.subsequent_to',    category:'phrase', match:'subsequent to',       replace:'after',     severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"subsequent to" → "after"',            since:'1.0.0', tags:['verbose','time'] },
    { id:'phrase.with_regard_to',   category:'phrase', match:'with regard to',      replace:'about',     severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"with regard to" → "about"',           since:'1.0.0', tags:['verbose','relation'] },
    { id:'phrase.with_respect_to',  category:'phrase', match:'with respect to',     replace:'about',     severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"with respect to" → "about"',          since:'1.0.0', tags:['verbose','relation'] },
    { id:'phrase.a_large_number',   category:'phrase', match:'a large number of',   replace:'many',      severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"a large number of" → "many"',         since:'1.0.0', tags:['verbose','quantity'] },
    { id:'phrase.vast_majority',    category:'phrase', match:'the vast majority of', replace:'most',     severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"the vast majority of" → "most"',      since:'1.0.0', tags:['verbose','quantity'] },
    { id:'phrase.is_able_to',       category:'phrase', match:'is able to',          replace:'can',       severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"is able to" → "can"',                 since:'1.0.0', tags:['verbose','ability'] },
    { id:'phrase.has_ability_to',   category:'phrase', match:'has the ability to',  replace:'can',       severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"has the ability to" → "can"',         since:'1.0.0', tags:['verbose','ability'] },
    { id:'phrase.it_is_possible',   category:'phrase', match:'it is possible to',   replace:'can',       severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"it is possible to" → "can"',          since:'1.0.0', tags:['verbose'] },
    { id:'phrase.important_to_note',category:'phrase', match:'it is important to note that', replace:'',severity:'info', confidence:0.88, autofix:true,  tokenAware:false, description:'Meta-commentary filler, can be removed', since:'1.0.0', tags:['ceremony','filler'] },
    { id:'phrase.should_be_noted',  category:'phrase', match:'it should be noted that', replace:'',     severity:'info', confidence:0.88, autofix:true,  tokenAware:false, description:'Meta-commentary filler',                since:'1.0.0', tags:['ceremony'] },
    { id:'phrase.goes_without_saying',category:'phrase',match:'it goes without saying that',replace:'', severity:'info', confidence:0.88, autofix:true,  tokenAware:false, description:'Filler phrase — state the fact directly', since:'1.0.0', tags:['ceremony','filler'] },
    { id:'phrase.would_like_you',   category:'phrase', match:'i would like you to', replace:'',         severity:'info', confidence:0.80, autofix:true,  tokenAware:false, description:'Polite framing — not needed for LLMs',   since:'1.0.0', tags:['ceremony','politeness'] },
    { id:'phrase.could_you_please', category:'phrase', match:'could you please',    replace:'',         severity:'info', confidence:0.80, autofix:true,  tokenAware:false, description:'Polite framing — not needed for LLMs',   since:'1.0.0', tags:['ceremony','politeness'] },
    { id:'phrase.furthermore',      category:'phrase', match:'furthermore',         replace:'also',      severity:'hint', confidence:0.75, autofix:true,  tokenAware:true,  description:'"furthermore" → "also"',                since:'1.0.0', tags:['connector'] },
    { id:'phrase.moreover',         category:'phrase', match:'moreover',            replace:'also',      severity:'hint', confidence:0.75, autofix:true,  tokenAware:true,  description:'"moreover" → "also"',                   since:'1.0.0', tags:['connector'] },
    { id:'phrase.in_conclusion',    category:'phrase', match:'in conclusion',       replace:'finally',   severity:'hint', confidence:0.75, autofix:true,  tokenAware:true,  description:'"in conclusion" → "finally"',           since:'1.0.0', tags:['connector'] },
    { id:'phrase.to_summarize',     category:'phrase', match:'to summarize',        replace:'in short',  severity:'hint', confidence:0.75, autofix:true,  tokenAware:true,  description:'"to summarize" → "in short"',           since:'1.0.0', tags:['connector'] },
    { id:'phrase.despite_fact',     category:'phrase', match:'despite the fact that',replace:'although', severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"despite the fact that" → "although"',  since:'1.0.0', tags:['verbose'] },
    { id:'phrase.make_decision',    category:'phrase', match:'make a decision',     replace:'decide',    severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"make a decision" → "decide"',          since:'1.0.0', tags:['verbose','nominalization'] },
    { id:'phrase.make_attempt',     category:'phrase', match:'make an attempt to',  replace:'try to',    severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"make an attempt to" → "try to"',      since:'1.0.0', tags:['verbose','nominalization'] },
    { id:'phrase.take_into_consideration',category:'phrase',match:'take into consideration',replace:'consider',severity:'info',confidence:0.88,autofix:true,tokenAware:true,description:'"take into consideration" → "consider"',since:'1.0.0',tags:['verbose','nominalization'] },
    { id:'phrase.has_impact_on',    category:'phrase', match:'has an impact on',    replace:'affects',   severity:'info', confidence:0.88, autofix:true,  tokenAware:true,  description:'"has an impact on" → "affects"',        since:'1.0.0', tags:['verbose','nominalization'] },

    // ── REDUNDANT MODIFIERS ──────────────────────────────────────────────────

    { id:'redundant.absolutely_essential',category:'redundant',match:'absolutely essential',replace:'essential',severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"absolutely essential" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.completely_unique',   category:'redundant',match:'completely unique',   replace:'unique',   severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"completely unique" is redundant — unique is absolute',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.end_result',          category:'redundant',match:'end result',          replace:'result',   severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"end result" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.final_outcome',       category:'redundant',match:'final outcome',       replace:'outcome',  severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"final outcome" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.past_history',        category:'redundant',match:'past history',        replace:'history',  severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"past history" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.future_plans',        category:'redundant',match:'future plans',        replace:'plans',    severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"future plans" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.advance_warning',     category:'redundant',match:'advance warning',     replace:'warning',  severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"advance warning" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.still_remains',       category:'redundant',match:'still remains',       replace:'remains',  severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"still remains" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.repeat_again',        category:'redundant',match:'repeat again',        replace:'repeat',   severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"repeat again" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.revert_back',         category:'redundant',match:'revert back',         replace:'revert',   severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"revert back" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.join_together',       category:'redundant',match:'join together',       replace:'join',     severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"join together" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.general_consensus',   category:'redundant',match:'general consensus',   replace:'consensus',severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"general consensus" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.brief_summary',       category:'redundant',match:'brief summary',       replace:'summary',  severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"brief summary" is redundant',since:'1.0.0',tags:['redundant'] },
    { id:'redundant.close_proximity',     category:'redundant',match:'close proximity',     replace:'proximity',severity:'info',confidence:0.92,autofix:true,tokenAware:true,description:'"close proximity" is redundant',since:'1.0.0',tags:['redundant'] },

    // ── FILLER WORDS ─────────────────────────────────────────────────────────

    { id:'filler.basically', category:'filler', match:'basically',    replace:'',severity:'hint',confidence:0.65,autofix:true, tokenAware:false,description:'"basically" is a filler word', since:'1.0.0',tags:['filler'] },
    { id:'filler.actually',  category:'filler', match:'actually',     replace:'',severity:'hint',confidence:0.65,autofix:true, tokenAware:false,description:'"actually" is a filler word',  since:'1.0.0',tags:['filler'] },
    { id:'filler.really',    category:'filler', match:'really',       replace:'',severity:'hint',confidence:0.65,autofix:true, tokenAware:false,description:'"really" is a filler word',    since:'1.0.0',tags:['filler'] },
    { id:'filler.very',      category:'filler', match:'very',         replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"very" is a filler word',      since:'1.0.0',tags:['filler'] },
    { id:'filler.just',      category:'filler', match:'just',         replace:'',severity:'hint',confidence:0.55,autofix:true, tokenAware:false,description:'"just" is a filler word',      since:'1.0.0',tags:['filler'] },
    { id:'filler.quite',     category:'filler', match:'quite',        replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"quite" is a filler word',     since:'1.0.0',tags:['filler'] },
    { id:'filler.simply',    category:'filler', match:'simply',       replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"simply" is a filler word',    since:'1.0.0',tags:['filler'] },
    { id:'filler.literally', category:'filler', match:'literally',    replace:'',severity:'hint',confidence:0.70,autofix:true, tokenAware:false,description:'"literally" is a filler word', since:'1.0.0',tags:['filler'] },
    { id:'filler.definitely',category:'filler', match:'definitely',   replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"definitely" is a filler word',since:'1.0.0',tags:['filler'] },
    { id:'filler.certainly', category:'filler', match:'certainly',    replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"certainly" is a filler word', since:'1.0.0',tags:['filler'] },
    { id:'filler.obviously', category:'filler', match:'obviously',    replace:'',severity:'hint',confidence:0.70,autofix:true, tokenAware:false,description:'"obviously" is a filler word', since:'1.0.0',tags:['filler'] },
    { id:'filler.essentially',category:'filler',match:'essentially',  replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"essentially" is a filler word',since:'1.0.0',tags:['filler'] },
    { id:'filler.extremely', category:'filler', match:'extremely',    replace:'',severity:'hint',confidence:0.55,autofix:true, tokenAware:false,description:'"extremely" is a filler word', since:'1.0.0',tags:['filler'] },
    { id:'filler.particularly',category:'filler',match:'particularly',replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"particularly" is a filler word',since:'1.0.0',tags:['filler'] },
    { id:'filler.specifically',category:'filler',match:'specifically',replace:'',severity:'hint',confidence:0.60,autofix:true, tokenAware:false,description:'"specifically" is a filler word',since:'1.0.0',tags:['filler'] },

    // ── CEREMONY (Prompt-specific) ────────────────────────────────────────────

    { id:'ceremony.greeting',       category:'ceremony', match:/^(hi|hello|hey|greetings|good (morning|afternoon|evening)|dear (assistant|ai|chatgpt|claude))[,!.\s]*/i, replace:'',severity:'warning',confidence:0.85,autofix:true,tokenAware:false,description:'LLMs do not need social greetings',since:'1.0.0',tags:['ceremony','greeting'] },
    { id:'ceremony.closing_thanks', category:'ceremony', match:/\s*(thank you( very much| so much| in advance)?|thanks( a lot| so much)?|i appreciate (it|your help))[.!]*\s*$/i, replace:'',severity:'warning',confidence:0.82,autofix:true,tokenAware:false,description:'LLMs do not need closing politeness',since:'1.0.0',tags:['ceremony','politeness'] },
    { id:'ceremony.please_kindly',  category:'ceremony', match:/\b(please|kindly)\s+/gi, replace:'',severity:'info',confidence:0.78,autofix:true,tokenAware:false,description:'"please/kindly" adds no semantic content to LLM prompts',since:'1.0.0',tags:['ceremony','politeness'] },
    { id:'ceremony.have_question',  category:'ceremony', match:/^(I have a question[.:]\s*)/i, replace:'',severity:'info',confidence:0.85,autofix:true,tokenAware:false,description:'Instruction framing is unnecessary',since:'1.0.0',tags:['ceremony','framing'] },
    { id:'ceremony.my_question',    category:'ceremony', match:/^(My question is[.:]\s*)/i,    replace:'',severity:'info',confidence:0.85,autofix:true,tokenAware:false,description:'Instruction framing is unnecessary',since:'1.0.0',tags:['ceremony','framing'] },

    // ── LINT RULES (semantic quality) ────────────────────────────────────────

    { id:'lint.ambiguous_pronoun',  category:'lint', match:/\b(it|they|them|this|that)\b(?!\s+(?:is|are|was|were|has|have|will|would|can|could|should|may|might|must))/gi, replace:undefined,severity:'warning',confidence:0.55,autofix:false,tokenAware:false,description:'Ambiguous pronoun — specify the referent for clarity',since:'1.0.0',tags:['clarity','ambiguity'] },
    { id:'lint.hallucination_hedge',category:'lint', match:/\b(I think|I believe|I guess|I'm not sure|I suppose|as far as I know)\b/i, replace:undefined,severity:'warning',confidence:0.82,autofix:false,tokenAware:false,description:'Hedging increases model uncertainty — state facts directly',since:'1.0.0',tags:['hallucination','quality'] },
    { id:'lint.vague_number',       category:'lint', match:/\b(a?round|approximately|about|roughly)\s+\d+\b/i, replace:undefined,severity:'info',confidence:0.70,autofix:false,tokenAware:false,description:'Vague numbers increase hallucination risk — use exact values',since:'1.0.0',tags:['precision','hallucination'] },
    { id:'lint.weak_instruction',   category:'lint', match:/\b(try to|attempt to|see if you can|if possible)\b/i, replace:undefined,severity:'info',confidence:0.65,autofix:false,tokenAware:false,description:'Weak instruction — use imperative form for clarity',since:'1.0.0',tags:['instruction','quality'] },
    { id:'lint.conflicting_tone',   category:'lint', match:/\b(briefly|concisely|in detail|comprehensively|thoroughly|extensively)\b.*\b(briefly|concisely|in detail|comprehensively|thoroughly|extensively)\b/i, replace:undefined,severity:'error',confidence:0.88,autofix:false,tokenAware:false,description:'Conflicting length/detail instructions detected',since:'1.0.0',tags:['conflict','quality'] },
    { id:'lint.excessive_examples', category:'lint', match:/(for example|e\.g\.|such as|like)[^.!?]{0,200}(for example|e\.g\.|such as)/i, replace:undefined,severity:'info',confidence:0.72,autofix:false,tokenAware:false,description:'Multiple example markers — consider consolidating',since:'1.0.0',tags:['context','efficiency'] },
    { id:'lint.passive_instruction',category:'lint', match:/\b(can be|should be|must be|will be|may be)\s+\w+ed\b/i, replace:undefined,severity:'hint',confidence:0.50,autofix:false,tokenAware:false,description:'Passive voice in instructions — consider active form',since:'1.0.0',tags:['clarity','instruction'] },
  ];

  // ── Rule Registry ─────────────────────────────────────────────────────────

  class RulesRegistry {
    constructor() {
      this._rules      = new Map();   // id → rule
      this._byCategory = new Map();   // category → rule[]
      this._disabled   = new Set();   // disabled rule IDs

      // Load built-in rules
      for (const rule of BUILTIN_RULES) this.register(rule);
    }

    /**
     * Register a rule. Validates schema, compiles regex, indexes by category.
     * @param {object} rule
     */
    register(rule) {
      validateRule(rule);
      this._rules.set(rule.id, rule);
      // Compile regex immediately
      compileRule(rule);
      // Index by category
      if (!this._byCategory.has(rule.category)) this._byCategory.set(rule.category, []);
      this._byCategory.get(rule.category).push(rule);
    }

    /**
     * Register multiple rules at once.
     * @param {object[]} rules
     */
    registerAll(rules) {
      for (const r of rules) this.register(r);
    }

    /** Disable a rule by ID (user preference, .densifyrc). */
    disable(id) { this._disabled.add(id); }

    /** Re-enable a previously disabled rule. */
    enable(id)  { this._disabled.delete(id); }

    /** Get a single rule by ID. */
    get(id) { return this._rules.get(id); }

    /** Get all enabled rules, optionally filtered by category. */
    getActive(category) {
      let rules = category
        ? (this._byCategory.get(category) || [])
        : Array.from(this._rules.values());
      return rules.filter(r => !this._disabled.has(r.id));
    }

    /** Get compiled RegExp for a rule. */
    getRegex(rule) { return compileRule(rule); }

    /**
     * Apply user configuration (from .densifyrc or popup settings).
     * config: { disable: string[], enable: string[], severity?: {id: level} }
     */
    applyConfig(config) {
      if (!config) return;
      if (config.disable) config.disable.forEach(id => this.disable(id));
      if (config.enable)  config.enable.forEach(id => this.enable(id));
      if (config.severity) {
        for (const [id, level] of Object.entries(config.severity)) {
          const rule = this._rules.get(id);
          if (rule && VALID_SEVERITIES.has(level)) rule.severity = level;
        }
      }
    }

    /** Serialize all rules to JSON (for devtools / export). */
    toJSON() {
      return Array.from(this._rules.values()).map(r => ({
        ...r,
        match: r.match instanceof RegExp ? r.match.toString() : r.match,
        active: !this._disabled.has(r.id),
      }));
    }

    /** Statistics for observability. */
    stats() {
      const categories = {};
      for (const [cat, rules] of this._byCategory) {
        categories[cat] = { total: rules.length, active: rules.filter(r => !this._disabled.has(r.id)).length };
      }
      return { total: this._rules.size, disabled: this._disabled.size, categories };
    }
  }

  // ── Singleton instance ────────────────────────────────────────────────────
  const registry = new RulesRegistry();

  // ── Export ────────────────────────────────────────────────────────────────
  const RulesDSL = { RulesRegistry, registry, BUILTIN_RULES, validateRule };

  if (typeof module !== 'undefined' && module.exports) module.exports = RulesDSL;
  root.DensifyRules = RulesDSL;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
