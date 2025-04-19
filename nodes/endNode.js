export async function endNode(context) {
  context.log('End Node: Task finished. Result:', context.finalResult);
  // Standard output wrapper
  const output = {
    task: context.task,
    steps: context.steps || [],
    result: context.finalResult,
    metadata: {
      runTime: new Date().toISOString(),
      sources: context.sources || [],
      errors: context.error ? [context.error] : [],
    },
  };
  console.log('\n[Agent] STANDARD OUTPUT:', JSON.stringify(output, null, 2));
  return { ...context, done: true };
}
