import { orchestrateExtraction } from './nodes/multiAgentOrchestrator.js';
import { planNode } from './nodes/planNode.js';

const task = process.argv[2] || 'Find recent AI breakthroughs and extract details';

(async () => {
  try {
    console.log('[MAIN] Planning for task:', task);
    // Plan step
    const context = {
      task,
      llm: {
        invoke: async (prompt) => {
          const { callLLM } = await import('./utils/llm.js');
          const content = await callLLM(prompt, 'mistral');
          return { content };
        }
      },
      log: (...args) => console.log('[PLAN]', ...args)
    };
    const planResult = await planNode(context);
    if (planResult.plan && typeof planResult.plan.then === 'function') {
      // If plan is a promise, await it
      planResult.plan = await planResult.plan;
    }
    console.log('[MAIN] Plan generated:\n', planResult.plan);
    // Extraction step
    const refinedQuery = planResult.refined_query || task;
    console.log('[MAIN] Using refined search query:', refinedQuery);
    const result = await orchestrateExtraction(refinedQuery, 'mistral');
    console.log(result.markdown);
  } catch (err) {
    console.error('[MAIN ERROR]', err);
  }
})();