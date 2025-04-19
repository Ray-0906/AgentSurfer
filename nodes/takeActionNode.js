export async function takeActionNode(context) {
  context.log('Take Action Node: Executing action:', context.nextAction);
  context.log('Action arguments:', context.nextArgs);
  const page = context.page;
  const action = context.nextAction;
  const args = context.nextArgs;
  let result;
  if (action === 'navigate') {
    const currentUrl = await page.url();
    // Navigation loop protection
    context._navLoopCount = (context._navLoopCount || 0) + 1;
    if (context._navLoopCount > 3) {
      context.log('Navigation loop detected! Aborting.');
      context.error = 'Navigation loop detected: tried to navigate to the same URL too many times.';
      return { ...context, nextNode: 'errorHandlingNode' };
    }
    // Compare URLs as strings
    if (typeof args.url === 'string' && currentUrl === args.url) {
      context.log('Already on target URL, skipping navigation.');
      context.actionsTaken.push({ action, arguments: args });
      // Go directly to analyzePageNode (not extractInfoNode)
      return { ...context, nextNode: 'analyzePageNode' };
    } else {
      context._navLoopCount = 0; // Reset on real navigation
    }
  }
  try {
    let tool;
    switch (action) {
      case 'navigate':
        tool = context.tools.find(t => t.name === 'navigate_to_url');
        context.log('Tool lookup for navigate:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'navigate_to_url' not found");
        result = await tool.call({ url: args.url });
        break;
      case 'type':
        tool = context.tools.find(t => t.name === 'type_text');
        context.log('Tool lookup for type:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'type_text' not found");
        result = await tool.call(args);
        break;
      case 'click':
        tool = context.tools.find(t => t.name === 'click_element');
        context.log('Tool lookup for click:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'click_element' not found");
        result = await tool.call(args);
        break;
      case 'extract':
        tool = context.tools.find(t => t.name === 'extract_text');
        context.log('Tool lookup for extract:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'extract_text' not found");
        result = await tool.call(args);
        context.extracted = result;
        break;
      case 'finish':
        context.log('Finish action detected. Moving to checkCompletionNode.');
        return { ...context, nextNode: 'checkCompletionNode' };
      default:
        context.log('Unknown action:', action);
        throw new Error('Unknown action: ' + action);
    }
    // Track action history
    context.actionsTaken.push({ action, arguments: args });
    // After navigation, always extract info and analyze again
    if (action === 'navigate') {
      const updatedContext = await extractInfoNode(context);
      updatedContext.retryCount = 0;
      return { ...updatedContext, nextNode: 'extractInfoNode' };
    }
    context.retryCount = 0;
    return { ...context, nextNode: 'extractInfoNode' };
  } catch (e) {
    context.log('Error in takeActionNode:', e);
    context.error = e;
    return { ...context, nextNode: 'errorHandlingNode' };
  }
}
