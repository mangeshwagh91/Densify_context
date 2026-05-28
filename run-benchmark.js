// Runner script for the Phase 3 benchmark suite
import { runBenchmark, quickTest } from './packages/benchmark-suite/index.js';

console.log('══════════════════════════════════════════════');
console.log('  Densify Phase 3 — Benchmark Suite');
console.log('══════════════════════════════════════════════\n');

// Quick single-prompt test
const sample = "Hi ChatGPT! I hope you are doing well. I would really appreciate it if you could please explain to me, in a way that is easy to understand for a complete beginner, how binary search works step by step. Due to the fact that I am new to algorithms, I would like a simple explanation. Thank you so much in advance!";
console.log('── Quick Test ───────────────────────────────');
console.log('Original:', sample.length, 'chars');
const qt = quickTest(sample);
console.log('AST encoded:', qt.astEncoded.text);
console.log('  savings:', qt.astEncoded.savings, 'tokens | sim:', qt.similarities.ast);
console.log('Filter dropped:', qt.filtered.dropped, 'sentences | sim:', qt.similarities.filter);
console.log('Summary dropped:', qt.summarized.dropped, 'sentences | sim:', qt.similarities.summ);

// Full benchmark
console.log('\n── Full Benchmark ──────────────────────────');
const { summary, corpus, results } = await runBenchmark({ verbose: false });
console.log(`Corpus: ${corpus} prompts | Results: ${results.length} | Errors: ${results.filter(r => r.error).length}`);
console.table(summary);

// Detailed per-category breakdown for AST stage
const astResults = results.filter(r => r.stage === 'AST Encode' && !r.error);
const byCategory = {};
for (const r of astResults) {
  if (!byCategory[r.category]) byCategory[r.category] = { count: 0, totalReduction: 0 };
  byCategory[r.category].count++;
  byCategory[r.category].totalReduction += parseFloat(r.reduction);
}
console.log('\n── AST Stage: Token Reduction by Category ──');
const catSummary = Object.entries(byCategory).map(([cat, v]) => ({
  category: cat,
  prompts: v.count,
  avgReduction: `${(v.totalReduction / v.count).toFixed(1)}%`,
}));
console.table(catSummary);
