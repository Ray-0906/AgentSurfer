import { orchestrateExtraction } from './nodes/multiAgentOrchestrator.js';
import { planNode } from './nodes/planNode.js';

async function multiHopAnimeSummaryTask() {
  const firstTask = 'Find the top 10 anime of 2024 with their titles.';
  console.log('\n[TOP-LEVEL] STEP 1: Finding Top 10 Anime of 2024...');
  const planCtx = {
    task: firstTask,
    llm: {
      invoke: async (prompt) => {
        const { callLLM } = await import('./utils/llm.js');
        const content = await callLLM(prompt, 'mistral');
        return { content };
      }
    },
    log: (...args) => console.log('[PLAN]', ...args)
  };
  const planResult = await planNode(planCtx);
  const refinedQuery = planResult.refined_query || firstTask;
  const result = await orchestrateExtraction(refinedQuery, 'mistral');
  let animeList = [];
  // Try to extract anime titles from markdown or JSON output
  const text = result.markdown || '';
  const match = text.match(/\d+\. ([^\n]+)/g);
  if (match && match.length >= 5) {
    animeList = match.map(x => x.replace(/^\d+\.\s*/, '').trim()).slice(0, 10);
  } else {
    // fallback: try to extract lines that look like anime titles
    animeList = text.split('\n').map(x => x.trim()).filter(x => x && !/^#|top|anime/i.test(x)).slice(0, 10);
  }
  if (animeList.length === 0) {
    throw new Error('Could not extract anime titles from search results.');
  }
  console.log('\n[TOP-LEVEL] STEP 2: Searching and summarizing each anime...');
  const summaries = [];
  for (const title of animeList) {
    const animeQuery = `${title} anime 2024 summary`;
    console.log(`\n[ANIME] Searching for: ${animeQuery}`);
    const animeResult = await orchestrateExtraction(animeQuery, 'mistral');
    // Try to extract summary and sources from markdown output
    let summary = animeResult.markdown || '';
    let sources = [];
    // Try to extract URLs from the markdown
    const urlMatches = summary.match(/https?:\/\/[^\s)\]]+/g);
    if (urlMatches) sources = urlMatches;
    summaries.push({ title, summary, sources });
  }
  // Output
  console.log('\n\n====== FINAL ANIME SUMMARIES ======\n');
  for (const { title, summary, sources } of summaries) {
    console.log(`\n## ${title}\n`);
    console.log(summary);
    if (sources.length) {
      console.log('\nSources:');
      for (const src of sources) console.log('-', src);
    }
  }
}

// Run if called directly
if (process.argv[2] === 'anime-multihop') {
  multiHopAnimeSummaryTask()
    .then(() => console.log('\n[COMPLETE]'))
    .catch(e => console.error('[ERROR]', e));
}

export { multiHopAnimeSummaryTask };
