export async function planNode(context) {
  context.log('Plan Node: Creating high-level plan and refining search query...');
  const planPrompt = `Task: ${context.task}\n\n1. Generate a detailed, step-by-step plan to accomplish this web task. Be explicit about navigation, search query refinement, typing, clicking, extraction, validation, and reporting.\n2. Extract the single best search query to use for web search.\n\nReturn your answer as a JSON object with two fields:\n- plan: a numbered, detailed step-by-step plan\n- refined_query: a single search query string, as would be typed into a search engine.`;
  const planResult = await context.llm.invoke(planPrompt);
  let planObj;
  try {
    planObj = JSON.parse(planResult.content);
  } catch (e) {
    context.log('Plan Node: Failed to parse plan JSON, returning raw content.');
    planObj = { plan: planResult.content, refined_query: context.task };
  }
  context.log('Plan Node: Plan generated:', planObj.plan);
  context.log('Plan Node: Refined search query:', planObj.refined_query);
  context.plan = planObj.plan;
  context.refined_query = planObj.refined_query;
  return { ...context, plan: planObj.plan, refined_query: planObj.refined_query, nextNode: 'extractInfoNode' };
}
