export async function checkCompletionNode(context) {
  context.log('Check Completion Node: Verifying if task is complete...');
  // Use LLM to check if the goal is achieved
  const checkPrompt = `Task: ${context.task}\nExtracted: ${context.extracted}\nIs the task complete? (yes/no). If yes, output the final answer.`;
  const checkResult = await context.llm.invoke(checkPrompt);
  if (/yes/i.test(checkResult.content)) {
    context.finalResult = checkResult.content;
    return { ...context, nextNode: 'endNode' };
  } else {
    return { ...context, nextNode: 'extractInfoNode' };
  }
}
