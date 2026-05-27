#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  benchmarks/bench.js  —  Densify Benchmark Suite  (Phase 2.5)
//
//  Usage:
//    node benchmarks/bench.js              — full suite
//    node benchmarks/bench.js --suite fast — fast subset only
//    node benchmarks/bench.js --json       — machine-readable output
//    node benchmarks/bench.js --watch      — re-run on file change
//
//  Metrics captured per scenario:
//    latency.rule_engine   ms  (optimize + getSuggestions)
//    latency.tokenizer     ms  (countSync)
//    latency.lint          ms  (lint full)
//    token.reduction_pct   %   (tokens saved)
//    token.false_positive  %   (suggestions that are idioms)
//    quality.changes       n   (number of changes applied)
//    quality.confidence    avg (average confidence of suggestions)
//    memory.heap_delta     KB  (heap used before/after)
//
//  Targets (fail-fast if exceeded):
//    rule_engine  < 2ms
//    tokenizer    < 10ms
//    lint         < 25ms
// ─────────────────────────────────────────────────────────────────────────────

// Node CJS compatibility shim for our browser-IIFE modules
const { createRequire } = require('module');
const path = require('path');
const fs   = require('fs');

// ── Load engine modules via IIFE pattern ──────────────────────────────────
const globalObj = global;

function loadLib(name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'lib', name), 'utf8');
  // Execute in global scope (IIFE sets globalObj properties)
  const fn = new Function('globalThis', src);
  fn(globalObj);
}

loadLib('tokenizer.js');
loadLib('confidence.js');
loadLib('rules-registry.js');
loadLib('lint-engine.js');
loadLib('densify-engine.js');

const Engine   = globalObj.DensifyEngine;
const Tok      = globalObj.DensifyTokenizer;
const Lint     = globalObj.DensifyLint;

// ── CLI args ──────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const jsonOut = args.includes('--json');
const suite   = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : 'full';
const ITERS   = args.includes('--fast') ? 50 : 200;

// ── Performance targets (ms) ──────────────────────────────────────────────
const TARGETS = {
  rule_engine: 2,
  tokenizer:   10,
  lint:        25,
};

// ── ANSI helpers ──────────────────────────────────────────────────────────
const C = jsonOut ? {
  red:'', green:'', yellow:'', cyan:'', bold:'', reset:''
} : {
  red:    '\x1b[31m', green: '\x1b[32m', yellow:'\x1b[33m',
  cyan:   '\x1b[36m', bold:  '\x1b[1m',  reset: '\x1b[0m',
};

function pass(s) { return `${C.green}✓${C.reset} ${s}`; }
function fail(s) { return `${C.red}✗${C.reset} ${s}`; }
function warn(s) { return `${C.yellow}⚠${C.reset} ${s}`; }
function bold(s) { return `${C.bold}${s}${C.reset}`; }
function head(s) { return `\n${C.cyan}${C.bold}${s}${C.reset}`; }

// ── Benchmark datasets ────────────────────────────────────────────────────

const DATASETS = {

  // ── Verbose prompts (lots of ceremony + filler)
  verbose: [
    `Hello there! I hope you are doing well. I would like you to please help me understand, if it is at all possible, the process by which machine learning models are trained. I was wondering if you could kindly explain this in detail. I really appreciate any help you can provide. Thank you so much in advance!`,
    `Good morning! I have a question that I would like you to answer. Could you please explain, due to the fact that I am quite confused, how neural networks actually work? It is important to note that I am a complete beginner. I would really appreciate it if you could keep things simple. Thanks a lot!`,
    `Hey there! I would love it if you could help me with something that is basically really quite important to me. I need you to help me write a professional email. I think it should be formal but also friendly. Could you please take into consideration my specific needs? I definitely need this done soon. Thanks!`,
    `Hi! My question is: could you please provide me with an explanation of what blockchain technology is and how it fundamentally actually works? I believe it is really quite complex, but I was wondering if you could perhaps simplify it somewhat. Please and thank you!`,
    `Good afternoon. I would be so grateful if you could assist me with understanding, in the event that you have the time, how to write clean code. It should be noted that I have a tendency to write code that is not particularly well organized. I would like you to take into consideration best practices. I definitely, absolutely need practical examples.`,
  ],

  // ── Coding prompts
  coding: [
    `Write a function in Python that takes a list of integers and returns the list sorted in ascending order, but with all the even numbers appearing before the odd numbers. Please include type hints and a docstring.`,
    `Implement a TypeScript class called TokenBucket that can be used for rate limiting. The class should have methods to check if a token is available and to consume tokens. Include error handling.`,
    `Create a React component called DataTable that renders a paginated table with sorting and filtering capabilities. Use TypeScript and hooks. The component should accept a generic data type.`,
    `Write a SQL query to find the top 5 customers by total purchase amount, include their email address, number of orders, and the date of their most recent order. Use appropriate JOINs and window functions.`,
    `Design a REST API endpoint in FastAPI for handling file uploads. The endpoint should validate file type, size limit of 10MB, store metadata in a database, and return a presigned URL for the uploaded file.`,
  ],

  // ── Long context prompts (RAG-style)
  long_context: [
    `You are an expert data scientist. Below is a dataset description and some sample data. Your task is to analyze this data and provide insights.

Dataset: Customer Purchase History
Columns: customer_id, purchase_date, product_category, amount, payment_method, region

Sample data:
customer_id: 1001, date: 2024-01-15, category: Electronics, amount: 1200, payment: credit_card, region: West
customer_id: 1002, date: 2024-01-16, category: Clothing, amount: 89, payment: debit_card, region: East
customer_id: 1001, date: 2024-01-17, category: Electronics, amount: 450, payment: credit_card, region: West
customer_id: 1003, date: 2024-01-18, category: Food, amount: 34, payment: cash, region: Central

Please analyze this data and provide:
1. Customer segmentation insights
2. Category performance analysis
3. Regional trends
4. Payment preference patterns
5. Recommendations for the business`,

    `Context: You are a senior software architect reviewing a pull request.

The PR adds the following changes to a production codebase:
- A new caching layer using Redis
- Changes to the authentication middleware
- Database schema migrations
- Updates to the API rate limiting logic

The developer's description says: "This PR implements the new caching strategy discussed in the architecture meeting. It adds Redis caching for user sessions, products, and frequently accessed data. The auth middleware now validates JWT tokens against cached session data. Database migrations add indexes for commonly queried fields."

Please review this PR and provide:
1. Potential security concerns
2. Performance implications
3. Testing recommendations
4. Code quality feedback
5. Approval decision`,
  ],

  // ── Agent/multi-step prompts
  agent: [
    `You are an AI agent with access to the following tools: web_search, file_read, file_write, code_execute, send_email.

Your task is to: Research the top 5 programming languages in 2024 by popularity, write a comprehensive report comparing them, save it as report.md, and send it to team@company.com.

Please think step by step and use the available tools to complete this task. Make sure to verify your sources and cite them in the report.`,
    `You are an automated QA agent. You have access to: browser_control, screenshot, assertion, test_runner.

Objective: Test the checkout flow of an e-commerce website. The flow includes: browsing products, adding to cart, entering shipping information, payment, and order confirmation.

For each step: take a screenshot, verify elements exist, check for errors, and log the result. Generate a test report at the end.`,
  ],

  // ── Prompts with idioms (false-positive test set)
  idiom_guard: [
    `Just do it. Don't overthink this problem, just start building. The best way to learn is by doing.`,
    `This approach works just in time for our deadline. The optimization was just right.`,
    `Not just the code quality, but also the architecture matters. This isn't simply a performance issue.`,
    `I really need you to understand this. It's not just about the code — it's really about the design.`,
    `The system works very well under load. The response time is very fast, usually under 100ms.`,
    `Just because it works doesn't mean it's correct. Just in case, add error handling everywhere.`,
  ],

  // ── Business/professional prompts
  business: [
    `Draft a professional email to a potential enterprise client explaining the value proposition of our AI optimization platform. The client is a Fortune 500 company with 5000+ developers. Include ROI projections, case studies, and a clear call to action.`,
    `Write a product requirements document for a new feature: real-time prompt cost estimation integrated into our VS Code extension. Include user stories, technical requirements, acceptance criteria, and success metrics.`,
    `Create a go-to-market strategy for launching a developer tool in Q1 2025. Target audience: AI engineers, LLM developers, and prompt engineers. Budget: $50k for first 3 months. Expected outcome: 10,000 active users.`,
  ],
};

// ── Statistical helpers ───────────────────────────────────────────────────

function stats(samples) {
  if (!samples.length) return { avg:0, min:0, max:0, p50:0, p95:0, p99:0 };
  const s = samples.slice().sort((a,b)=>a-b);
  const pct = (p) => s[Math.min(s.length-1, Math.ceil(p/100*s.length)-1)];
  return {
    avg: parseFloat((s.reduce((a,b)=>a+b,0)/s.length).toFixed(3)),
    min: parseFloat(s[0].toFixed(3)),
    max: parseFloat(s[s.length-1].toFixed(3)),
    p50: parseFloat(pct(50).toFixed(3)),
    p95: parseFloat(pct(95).toFixed(3)),
    p99: parseFloat(pct(99).toFixed(3)),
  };
}

function heapKB() {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

// ── Individual benchmarks ─────────────────────────────────────────────────

function benchRuleEngine(prompts, iters) {
  const latencies = [];
  const reductions = [];
  const changes = [];
  const confidences = [];

  for (let i = 0; i < iters; i++) {
    const text = prompts[i % prompts.length];
    const t0 = process.hrtime.bigint();
    const result = Engine.optimizePrompt(text, { model:'gpt-4o' });
    const t1 = process.hrtime.bigint();
    latencies.push(Number(t1 - t0) / 1e6); // ns → ms

    if (result.savings.saved >= 0) {
      reductions.push(result.savings.percentage);
    }
    changes.push(result.changes.filter(c => c.type !== 'whitespace').length);
    if (result.confidence) confidences.push(result.confidence);
  }

  return {
    latency:        stats(latencies),
    avgReduction:   parseFloat((reductions.reduce((a,b)=>a+b,0)/reductions.length||0).toFixed(1)),
    avgChanges:     parseFloat((changes.reduce((a,b)=>a+b,0)/changes.length).toFixed(1)),
    avgConfidence:  parseFloat((confidences.reduce((a,b)=>a+b,0)/(confidences.length||1)).toFixed(2)),
  };
}

function benchTokenizer(prompts, iters) {
  const latencies = [];

  for (let i = 0; i < iters; i++) {
    const text = prompts[i % prompts.length];
    const t0 = process.hrtime.bigint();
    Tok.countSync(text, 'gpt-4o');
    const t1 = process.hrtime.bigint();
    latencies.push(Number(t1 - t0) / 1e6);
  }

  // Warm vs cold (first vs remaining)
  const cold = latencies[0];
  const warm = latencies.slice(10);

  return {
    latency: stats(latencies),
    coldMs:  parseFloat(cold.toFixed(3)),
    warmLatency: stats(warm),
  };
}

function benchSuggestions(prompts, iters) {
  const latencies = [];
  const counts = [];

  for (let i = 0; i < iters; i++) {
    const text = prompts[i % prompts.length];
    const t0 = process.hrtime.bigint();
    const sug = Engine.getSuggestions(text, 'gpt-4o');
    const t1 = process.hrtime.bigint();
    latencies.push(Number(t1 - t0) / 1e6);
    counts.push(sug.length);
  }

  return {
    latency:     stats(latencies),
    avgSuggestions: parseFloat((counts.reduce((a,b)=>a+b,0)/counts.length).toFixed(1)),
  };
}

function benchLint(prompts, iters) {
  const latencies = [];
  const diagCounts = [];

  for (let i = 0; i < iters; i++) {
    const text = prompts[i % prompts.length];
    const t0 = process.hrtime.bigint();
    const diags = Lint.lint(text, { model:'gpt-4o' });
    const t1 = process.hrtime.bigint();
    latencies.push(Number(t1 - t0) / 1e6);
    diagCounts.push(diags.length);
  }

  return {
    latency:      stats(latencies),
    avgDiagnostics: parseFloat((diagCounts.reduce((a,b)=>a+b,0)/diagCounts.length).toFixed(1)),
  };
}

function benchIdiomsGuard(idiomPrompts) {
  // Each test case: text that contains a known idiom + the word that SHOULD NOT be flagged
  const TEST_CASES = [
    { text: 'Just do it. Don\'t overthink this problem, just start building.',
      idiom: 'just do it', word: 'just', shouldBeFlagged: false },
    { text: 'This approach works just in time for our deadline.',
      idiom: 'just in time', word: 'just', shouldBeFlagged: false },
    { text: 'Not just the code quality, but also the architecture matters.',
      idiom: 'not just', word: 'just', shouldBeFlagged: false },
    { text: 'The system works very well under load.',
      idiom: 'very well', word: 'very', shouldBeFlagged: false },
    { text: 'This is just a test prompt that should be flagged.',
      idiom: null, word: 'just', shouldBeFlagged: true },
    { text: 'I really need to understand this problem very clearly.',
      idiom: null, word: 'really', shouldBeFlagged: true },
  ];

  let falsePositives = 0;
  let falseNegatives = 0;

  for (const tc of TEST_CASES) {
    const sug = Engine.getSuggestions(tc.text, 'gpt-4o');
    const wordFlagged = sug.some(s =>
      s.original.toLowerCase() === tc.word && s.confidence > 0.15
    );

    if (!tc.shouldBeFlagged && wordFlagged) falsePositives++;
    if (tc.shouldBeFlagged  && !wordFlagged) falseNegatives++;
  }

  return {
    idiomsTestedCount: TEST_CASES.length,
    falsePositiveCount: falsePositives,
    falseNegativeCount: falseNegatives,
    falsePositiveRate: parseFloat((falsePositives / TEST_CASES.length).toFixed(3)),
  };
}

function benchMemory(prompts) {
  const before = heapKB();
  // Run 500 optimizations
  for (let i = 0; i < 500; i++) {
    Engine.optimizePrompt(prompts[i % prompts.length]);
  }
  const after = heapKB();
  return {
    heapBefore: before,
    heapAfter:  after,
    heapDeltaKB: after - before,
  };
}

// ── Suite runner ──────────────────────────────────────────────────────────

function runSuite() {
  const allPrompts = Object.values(DATASETS).flat();
  const results = {};
  const failures = [];
  const start = Date.now();

  if (!jsonOut) console.log(head('════════════════════════════════════════'));
  if (!jsonOut) console.log(head(`  DENSIFY BENCHMARK SUITE  (n=${ITERS})`));
  if (!jsonOut) console.log(head('════════════════════════════════════════'));

  // ── Rule Engine ──────────────────────────────────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 1. Rule Engine — optimizePrompt()'));
  const re = benchRuleEngine(allPrompts, ITERS);
  results.rule_engine = re;
  if (!jsonOut) {
    const ok = re.latency.p95 < TARGETS.rule_engine;
    console.log(`  ${ok ? pass('p95 latency') : fail('p95 latency')} ${re.latency.p95}ms  (target <${TARGETS.rule_engine}ms)`);
    console.log(`  avg: ${re.latency.avg}ms  p50: ${re.latency.p50}ms  p99: ${re.latency.p99}ms`);
    console.log(`  avg reduction: ${re.avgReduction}%  avg changes: ${re.avgChanges}  avg confidence: ${re.avgConfidence}`);
    if (!ok) failures.push(`rule_engine p95=${re.latency.p95}ms > ${TARGETS.rule_engine}ms`);
  }

  // ── Tokenizer ────────────────────────────────────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 2. Tokenizer — countSync()'));
  const tok = benchTokenizer(allPrompts, ITERS);
  results.tokenizer = tok;
  if (!jsonOut) {
    const ok = tok.warmLatency.p95 < TARGETS.tokenizer;
    console.log(`  ${ok ? pass('warm p95') : fail('warm p95')} ${tok.warmLatency.p95}ms  (target <${TARGETS.tokenizer}ms)`);
    console.log(`  cold (1st call): ${tok.coldMs}ms`);
    console.log(`  warm avg: ${tok.warmLatency.avg}ms  p50: ${tok.warmLatency.p50}ms`);
    if (!ok) failures.push(`tokenizer warm p95=${tok.warmLatency.p95}ms > ${TARGETS.tokenizer}ms`);
  }

  // ── getSuggestions ───────────────────────────────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 3. Interactive — getSuggestions()'));
  const sug = benchSuggestions(allPrompts, ITERS);
  results.suggestions = sug;
  if (!jsonOut) {
    console.log(`  avg latency: ${sug.latency.avg}ms  p95: ${sug.latency.p95}ms  p99: ${sug.latency.p99}ms`);
    console.log(`  avg suggestions per prompt: ${sug.avgSuggestions}`);
  }

  // ── Lint Engine ──────────────────────────────────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 4. Lint Engine — lint()'));
  const lint = benchLint(allPrompts, ITERS);
  results.lint = lint;
  if (!jsonOut) {
    const ok = lint.latency.p95 < TARGETS.lint;
    console.log(`  ${ok ? pass('p95 latency') : fail('p95 latency')} ${lint.latency.p95}ms  (target <${TARGETS.lint}ms)`);
    console.log(`  avg: ${lint.latency.avg}ms  p50: ${lint.latency.p50}ms  p99: ${lint.latency.p99}ms`);
    console.log(`  avg diagnostics: ${lint.avgDiagnostics}`);
    if (!ok) failures.push(`lint p95=${lint.latency.p95}ms > ${TARGETS.lint}ms`);
  }

  // ── Idiom Guard (false positive detection) ───────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 5. Idiom Guard — false positive rate'));
  const idiom = benchIdiomsGuard(DATASETS.idiom_guard);
  results.idiom_guard = idiom;
  if (!jsonOut) {
    const ok = idiom.falsePositiveRate === 0;
    console.log(`  ${ok ? pass('no false positives') : warn('false positives detected')}`);
    console.log(`  tested: ${idiom.idiomsTestedCount}  false positives: ${idiom.falsePositiveCount}  rate: ${(idiom.falsePositiveRate*100).toFixed(1)}%`);
    if (!ok) failures.push(`idiom_guard falsePositiveRate=${idiom.falsePositiveRate}`);
  }

  // ── Token reduction quality ──────────────────────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 6. Token Reduction — verbose prompts'));
  const reductions = DATASETS.verbose.map(text => {
    const result = Engine.optimizePrompt(text, { model:'gpt-4o' });
    return { text, before: result.tokensBefore, after: result.tokensAfter, pct: result.savings.percentage };
  });
  results.token_reduction = reductions;
  if (!jsonOut) {
    const avgPct = parseFloat((reductions.reduce((s,r) => s+r.pct, 0)/reductions.length).toFixed(1));
    const ok = avgPct >= 15;
    console.log(`  ${ok ? pass('avg reduction') : warn('avg reduction below target')} ${avgPct}%  (target ≥15%)`);
    reductions.forEach((r,i) =>
      console.log(`  [${i+1}] ${r.before}t → ${r.after}t  (${r.pct}%)`));
    if (!ok) failures.push(`token_reduction avg=${avgPct}% < 15%`);
  }

  // ── Memory ───────────────────────────────────────────────────────────────
  if (!jsonOut) console.log(head('\n▶ 7. Memory — 500 optimizations'));
  const mem = benchMemory(allPrompts);
  results.memory = mem;
  if (!jsonOut) {
    const ok = mem.heapDeltaKB < 2048; // <2MB growth
    console.log(`  ${ok ? pass('heap stable') : warn('heap growth detected')}`);
    console.log(`  before: ${mem.heapBefore}KB  after: ${mem.heapAfter}KB  delta: ${mem.heapDeltaKB}KB`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const elapsed = Date.now() - start;
  if (!jsonOut) {
    console.log(head('\n════════════════════════════════════════'));
    console.log(bold(`SUITE COMPLETE — ${elapsed}ms`));
    if (failures.length === 0) {
      console.log(`${C.green}All performance targets met ✓${C.reset}`);
    } else {
      console.log(`${C.red}${failures.length} target(s) missed:${C.reset}`);
      failures.forEach(f => console.log(`  ${C.red}✗${C.reset} ${f}`));
    }
    console.log('');
  }

  // ── Write JSON snapshot ───────────────────────────────────────────────────
  const snapshot = {
    timestamp:  new Date().toISOString(),
    version:    Engine.version,
    iterations: ITERS,
    targets:    TARGETS,
    results,
    failures,
    elapsedMs:  elapsed,
    passed:     failures.length === 0,
  };

  const snapDir  = path.join(__dirname, 'snapshots');
  const snapFile = path.join(snapDir, `bench-${Date.now()}.json`);
  if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));
  if (!jsonOut) console.log(`Snapshot saved: ${path.relative(process.cwd(), snapFile)}`);

  if (jsonOut) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

// ── Regression detector ───────────────────────────────────────────────────

function detectRegressions() {
  const snapDir = path.join(__dirname, 'snapshots');
  if (!fs.existsSync(snapDir)) { console.log('No snapshots found.'); return; }

  const snaps = fs.readdirSync(snapDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-5) // last 5 runs
    .map(f => JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')));

  if (snaps.length < 2) { console.log('Need at least 2 snapshots for regression detection.'); return; }

  const prev = snaps[snaps.length - 2];
  const curr = snaps[snaps.length - 1];

  console.log(head('REGRESSION DETECTION'));
  const checks = [
    ['rule_engine p95', prev.results.rule_engine?.latency?.p95, curr.results.rule_engine?.latency?.p95, 1.2],
    ['tokenizer warm p95', prev.results.tokenizer?.warmLatency?.p95, curr.results.tokenizer?.warmLatency?.p95, 1.5],
    ['lint p95', prev.results.lint?.latency?.p95, curr.results.lint?.latency?.p95, 1.2],
  ];

  let regressions = 0;
  for (const [name, prev_v, curr_v, threshold] of checks) {
    if (prev_v == null || curr_v == null) continue;
    const ratio = curr_v / prev_v;
    if (ratio > threshold) {
      console.log(fail(`${name}: ${prev_v}ms → ${curr_v}ms (+${((ratio-1)*100).toFixed(0)}%) REGRESSION`));
      regressions++;
    } else {
      console.log(pass(`${name}: ${prev_v}ms → ${curr_v}ms (${((ratio-1)*100).toFixed(0)}%)`));
    }
  }

  if (regressions === 0) console.log(`\n${C.green}No regressions detected.${C.reset}`);
  else console.log(`\n${C.red}${regressions} regression(s) found.${C.reset}`);
}

// ── Entry point ───────────────────────────────────────────────────────────
if (args.includes('--regression')) {
  detectRegressions();
} else {
  runSuite();
}
