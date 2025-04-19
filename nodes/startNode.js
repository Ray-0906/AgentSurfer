export async function startNode(context) {
  context.log('Start Node: Received task:', context.task);
  return { ...context, nextNode: 'planNode' };
}
