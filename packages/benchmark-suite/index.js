// ─────────────────────────────────────────────────────────────────────────────
//  packages/benchmark-suite/index.js
//  Automated benchmark harness for all Densify compression stages.
//
//  Metrics per stage:
//    - Token reduction %
//    - Semantic similarity (TF-IDF cosine, 0–1)
//    - Latency (ms)
//
//  Usage:
//    import { runBenchmark } from './packages/benchmark-suite/index.js';
//    const report = await runBenchmark();
//    console.table(report.summary);
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

import { compress as astCompress }               from '../ast-encoder/index.js';
import { filterSentences, semanticSimilarity }   from '../embedding-filter/index.js';
import { summarize, stripOutputPreamble }         from '../output-optimizer/index.js';

// ── Built-in prompt corpus ────────────────────────────────────────────────────
// 50 diverse prompts covering code-gen, QA, summarize, explain, translate, compare.

const CORPUS = [
  // Code-gen
  { id:'c01', category:'code-gen', text:"Please write a JavaScript function that given an array of integers returns the sum of all elements. Please provide a code example and include error handling." },
  { id:'c02', category:'code-gen', text:"Could you please implement a Python class called BinaryTree that supports insert, search, and delete operations? Make sure to include docstrings and type hints." },
  { id:'c03', category:'code-gen', text:"I would really appreciate it if you could write a TypeScript function that validates an email address using regex. It would be great if you could also add unit tests." },
  { id:'c04', category:'code-gen', text:"Please create a React component that displays a paginated list of items fetched from an API. Make sure to handle loading and error states." },
  { id:'c05', category:'code-gen', text:"Write me a SQL query to find the top 10 customers by total order value from the orders table, joining with the customers table." },
  // Explain
  { id:'e01', category:'explain', text:"Hi ChatGPT! I hope you are doing well today. Could you please explain to me how a binary search algorithm works? I am a beginner and would really appreciate a simple step-by-step explanation." },
  { id:'e02', category:'explain', text:"Hello there! I was wondering if you could tell me about how neural networks learn. I want to understand backpropagation but I'm not very experienced with math." },
  { id:'e03', category:'explain', text:"Can you please explain the difference between TCP and UDP protocols? I would like to understand when to use each one." },
  { id:'e04', category:'explain', text:"I want to know more about how React's virtual DOM works and why it makes applications faster. Could you please give me a detailed explanation?" },
  { id:'e05', category:'explain', text:"Please explain what a REST API is and how it differs from GraphQL. Include some examples if possible." },
  // QA
  { id:'q01', category:'qa', text:"What is the time complexity of quicksort in the average case and why?" },
  { id:'q02', category:'qa', text:"What are the main differences between supervised and unsupervised machine learning?" },
  { id:'q03', category:'qa', text:"How does garbage collection work in the JVM?" },
  { id:'q04', category:'qa', text:"What is the CAP theorem and why does it matter for distributed systems?" },
  { id:'q05', category:'qa', text:"When should I use a NoSQL database instead of a relational database?" },
  // Summarize
  { id:'s01', category:'summarize', text:"I have a very long document about the history of artificial intelligence that I need to summarize. Could you please provide me with a brief summary of the key points and milestones?" },
  { id:'s02', category:'summarize', text:"Please summarize the following research paper about transformer architectures in simple terms that a non-expert can understand: [paper content here]" },
  { id:'s03', category:'summarize', text:"Can you give me a quick overview of the main points from the book 'Clean Code' by Robert Martin?" },
  // Translate
  { id:'t01', category:'translate', text:"Could you please translate the following text from English to French? I need it to be accurate and maintain the formal tone: 'The quarterly financial report shows significant growth.'" },
  { id:'t02', category:'translate', text:"I need help translating this Python code to TypeScript. Please make sure to use proper TypeScript types and interfaces." },
  // Compare
  { id:'cp01', category:'compare', text:"Can you compare and contrast the pros and cons of using MongoDB versus PostgreSQL for a high-traffic web application?" },
  { id:'cp02', category:'compare', text:"What are the differences between React, Vue, and Angular? When should I use each one?" },
  // Rewrite
  { id:'r01', category:'rewrite', text:"I would like you to help me improve and refactor the following code to make it more readable and maintainable: [code here]" },
  { id:'r02', category:'rewrite', text:"Please clean up and optimize this SQL query to make it more efficient: SELECT * FROM users WHERE active = 1 AND created_at > '2024-01-01'" },
  // Ceremony-heavy (should show high savings)
  { id:'cer01', category:'ceremony', text:"Hi! I hope you're doing well! I was wondering if you could help me understand what Docker is and how containers work. I'm new to DevOps and would really appreciate a beginner-friendly explanation. Thank you so much in advance!" },
  { id:'cer02', category:'ceremony', text:"Good morning! I really appreciate all the help you give me. I have a question about React hooks. Could you please explain the difference between useEffect and useLayoutEffect? Thank you!" },
  { id:'cer03', category:'ceremony', text:"Hello ChatGPT! I hope you're having a wonderful day. I would absolutely love it if you could write me a function in JavaScript that sorts an array of objects by a given key. Thanks a million!" },
  { id:'cer04', category:'ceremony', text:"chatgpt i hope you are doing well and i want to tell you about my genuine condition in my academics with my family for you opinion and the main reason of telling this to compare our thinking" },
  // Verbose / redundant
  { id:'v01', category:'verbose', text:"Due to the fact that I am currently in the process of learning how to code, I would like you to provide me with a comprehensive explanation of object-oriented programming concepts in a way that is easy to understand for someone who is a complete beginner." },
  { id:'v02', category:'verbose', text:"At this point in time, I am wondering whether or not it would be possible for you to assist me in understanding how to make a decision about which programming language I should choose for the purpose of building a web application." },
  { id:'v03', category:'verbose', text:"I would appreciate it if you could help me take into consideration all the different factors that have an impact on the performance of a web application, and give an indication of which ones are the most important ones to focus on." },
  // Multi-sentence (filter test)
  { id:'f01', category:'filter', text:"Explain recursion in programming. I am learning Python. I also want to know about databases. Please tell me about recursion specifically. How does the call stack work with recursive functions?" },
  { id:'f02', category:'filter', text:"What is machine learning? I want to understand neural networks. Also, how does Python handle memory management? Focus on machine learning for now. Can you explain gradient descent?" },
  // Output summarization test (long outputs)
  { id:'o01', category:'output', text:"Certainly! I'd be happy to help you understand binary search. Binary search is a searching algorithm that finds the position of a target value within a sorted array. It works by repeatedly dividing the search interval in half. If the value of the target is less than the item in the middle of the interval, the algorithm narrows the interval to the lower half. Otherwise, it narrows it to the upper half. This process repeats until the target value is found or the interval is empty. The time complexity of binary search is O(log n), which makes it much faster than linear search O(n) for large datasets. Here is how it works step by step: First, find the middle element. Second, compare the target with the middle. Third, if they match, return the index. Fourth, if target is smaller, search the left half. Fifth, if target is larger, search the right half. Repeat until found or not found." },
];

// ── Token counter (heuristic: ~1 token per 4 chars) ──────────────────────────

function countTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ── Run a single stage with timing ───────────────────────────────────────────

function timed(fn) {
  const start = performance.now ? performance.now() : Date.now();
  const result = fn();
  const ms = ((performance.now ? performance.now() : Date.now()) - start).toFixed(2);
  return { result, ms: parseFloat(ms) };
}

// ── Stage runners ─────────────────────────────────────────────────────────────

function runASTStage(prompt) {
  const { result, ms } = timed(() => astCompress(prompt.text));
  const origTokens = countTokens(prompt.text);
  const compTokens = countTokens(result.compressed);
  const reduction  = parseFloat(((1 - compTokens / origTokens) * 100).toFixed(1));
  const similarity = semanticSimilarity(prompt.text, result.compressed);
  return {
    stage: 'AST Encode',
    id: prompt.id,
    category: prompt.category,
    original: origTokens,
    compressed: compTokens,
    reduction: `${reduction}%`,
    similarity,
    latencyMs: ms,
    output: result.compressed,
  };
}

function runFilterStage(prompt) {
  // Use first sentence as the "query" (what the user actually wants)
  const query = prompt.text.split(/[.!?]/)[0] || prompt.text;
  const { result, ms } = timed(() => filterSentences(prompt.text, query, 0.08));
  const origTokens = countTokens(prompt.text);
  const filtTokens = countTokens(result.filtered);
  const reduction  = parseFloat(((1 - filtTokens / origTokens) * 100).toFixed(1));
  const similarity = semanticSimilarity(prompt.text, result.filtered);
  return {
    stage: 'Embed Filter',
    id: prompt.id,
    category: prompt.category,
    original: origTokens,
    compressed: filtTokens,
    reduction: `${reduction}%`,
    similarity,
    latencyMs: ms,
    dropped: result.dropped,
    output: result.filtered,
  };
}

function runOutputStage(prompt) {
  const clean = stripOutputPreamble(prompt.text);
  const { result, ms } = timed(() => summarize(clean, { ratio: 0.6, minSentences: 2 }));
  const origTokens = countTokens(prompt.text);
  const summTokens = countTokens(result.summary);
  const reduction  = parseFloat(((1 - summTokens / origTokens) * 100).toFixed(1));
  const similarity = semanticSimilarity(prompt.text, result.summary);
  return {
    stage: 'Summarize',
    id: prompt.id,
    category: prompt.category,
    original: origTokens,
    compressed: summTokens,
    reduction: `${reduction}%`,
    similarity,
    latencyMs: ms,
    dropped: result.dropped,
    output: result.summary,
  };
}

// ── Main benchmark runner ─────────────────────────────────────────────────────

/**
 * Run the full benchmark suite across all corpus prompts and all stages.
 *
 * @param {object} opts
 * @param {boolean} [opts.verbose=false] - Print each result row
 * @returns {{ results: object[], summary: object }}
 */
export async function runBenchmark(opts = {}) {
  const { verbose = false } = opts;
  const results = [];

  for (const prompt of CORPUS) {
    // Stage 1: AST Encode
    try {
      results.push(runASTStage(prompt));
    } catch (e) {
      results.push({ stage: 'AST Encode', id: prompt.id, error: e.message });
    }

    // Stage 2: Embedding Filter (only multi-sentence prompts)
    const sentCount = prompt.text.split(/[.!?]/).length;
    if (sentCount >= 3) {
      try {
        results.push(runFilterStage(prompt));
      } catch (e) {
        results.push({ stage: 'Embed Filter', id: prompt.id, error: e.message });
      }
    }

    // Stage 3: Output summarize (for long texts or 'output' category)
    if (prompt.text.length > 200 || prompt.category === 'output') {
      try {
        results.push(runOutputStage(prompt));
      } catch (e) {
        results.push({ stage: 'Summarize', id: prompt.id, error: e.message });
      }
    }
  }

  // ── Aggregate by stage ────────────────────────────────────────────────────
  const byStage = {};
  for (const r of results) {
    if (r.error) continue;
    if (!byStage[r.stage]) byStage[r.stage] = { count: 0, totalReduction: 0, totalSim: 0, totalMs: 0 };
    const s = byStage[r.stage];
    s.count++;
    s.totalReduction += parseFloat(r.reduction);
    s.totalSim       += r.similarity || 0;
    s.totalMs        += r.latencyMs || 0;
  }

  const summary = Object.entries(byStage).map(([stage, s]) => ({
    stage,
    prompts:         s.count,
    avgReduction:    `${(s.totalReduction / s.count).toFixed(1)}%`,
    avgSimilarity:   parseFloat((s.totalSim / s.count).toFixed(3)),
    avgLatencyMs:    parseFloat((s.totalMs / s.count).toFixed(2)),
  }));

  if (verbose) {
    console.log('\n══ Densify Phase 3 Benchmark ══');
    console.table(summary);
    console.log(`\nTotal results: ${results.length} | Errors: ${results.filter(r => r.error).length}`);
  }

  return { results, summary, corpus: CORPUS.length };
}

/**
 * Run a quick smoke test on a single prompt through all stages.
 *
 * @param {string} text
 * @returns {object}
 */
export function quickTest(text) {
  const ast    = astCompress(text);
  const filter = filterSentences(text, text.split(/[.!?]/)[0], 0.08);
  const summ   = summarize(text, { ratio: 0.6 });
  return {
    original:     { text, tokens: countTokens(text) },
    astEncoded:   { text: ast.compressed,    tokens: countTokens(ast.compressed),    savings: ast.tokensSaved },
    filtered:     { text: filter.filtered,   tokens: countTokens(filter.filtered),   dropped: filter.dropped },
    summarized:   { text: summ.summary,      tokens: countTokens(summ.summary),      dropped: summ.dropped },
    similarities: {
      ast:    semanticSimilarity(text, ast.compressed),
      filter: semanticSimilarity(text, filter.filtered),
      summ:   semanticSimilarity(text, summ.summary),
    },
  };
}

export default { runBenchmark, quickTest };
