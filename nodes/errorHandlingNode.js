export async function errorHandlingNode(context) {
  context.log('Error Handling Node: Handling error:', context.error);
  context.retryCount = (context.retryCount || 0) + 1;
  if (context.retryCount < 3) {
    context.log('Retrying last action...');
    return { ...context, nextNode: context.lastNode || 'takeActionNode' };
  } else {
    context.log('Max retries reached. Ending with error.');
    context.finalResult = 'Error: ' + context.error;
    return { ...context, nextNode: 'endNode' };
  }
}
