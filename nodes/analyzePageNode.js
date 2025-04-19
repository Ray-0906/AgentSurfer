export async function analyzePageNode(context) {
  context.log('Analyze Page Node: Analyzing page and deciding next action...');

  // Restrict allowed actions
  let allowedActions = ["navigate", "type", "click", "extract", "finish"];
  const maxHtmlLength = 500;
  const maxActions = 2;
  const htmlSnippet = context.pageContent ? context.pageContent.slice(0, maxHtmlLength) : '';
  const recentActions = context.actionsTaken ? context.actionsTaken.slice(-maxActions) : [];

  // Get current page URL only once
  const currentUrl = await context.page.url();
  // Only allow 'navigate' if not already on the target URL
  if (context.taskTargetUrl && currentUrl === context.taskTargetUrl) {
    allowedActions = allowedActions.filter(a => a !== 'navigate');
  }

  // Define strict output schema per action using zod discriminated union
  const actionSchema = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('navigate'),
      arguments: z.object({ url: z.string() })
    }),
    z.object({
      action: z.literal('type'),
      arguments: z.object({ selector: z.string(), text: z.string() })
    }),
    z.object({
      action: z.literal('click'),
      arguments: z.object({ selector: z.string() })
    }),
    z.object({
      action: z.literal('extract'),
      arguments: z.object({ selector: z.string() })
    }),
    z.object({
      action: z.literal('finish'),
      arguments: z.object({})
    })
  ]);

  // Initialize the parser
  const parser = StructuredOutputParser.fromZodSchema(actionSchema);

  // Compose the prompt
  const analyzePrompt = `
You are an autonomous web agent. Your allowed actions are ONLY: ${allowedActions.join(", ")}.
Here is your task: ${context.task}
Current page URL: ${currentUrl}
Actions taken so far: ${JSON.stringify(recentActions, null, 2)}
Current Page HTML (first ${maxHtmlLength} chars): ${htmlSnippet}
${context.taskTargetUrl && currentUrl === context.taskTargetUrl ? '\nIMPORTANT: You are already on the target URL. Do NOT navigate again. Proceed to the next logical step.' : ''}

For each action, provide the required arguments in the correct JSON format. Here are the required fields for each action:
- navigate: { "url": "<string>" }
- type: { "selector": "<CSS selector for input>", "text": "<text to type>" }
- click: { "selector": "<CSS selector for button or element>" }
- extract: { "selector": "<CSS selector for element to extract>" }
- finish: { }

Examples:
- To type 'AI agents' into the DuckDuckGo search bar:
  { "action": "type", "arguments": { "selector": "input[name='q']", "text": "AI agents" } }
- To click the search button (or submit by pressing Enter if the button is not found):
  { "action": "click", "arguments": { "selector": "input[type='submit'], button[type='submit']" } }
- If clicking fails, try simulating pressing Enter in the search input.
- To navigate to a page:
  { "action": "navigate", "arguments": { "url": "https://duckduckgo.com" } }
- To extract the first result (try multiple selectors for robustness):
  { "action": "extract", "arguments": { "selector": ".result__title a, .react-results--main .react-results__title a, a[data-testid='result-title-a'], h2 a" } }
- To finish:
  { "action": "finish", "arguments": {} }

IMPORTANT: Output ONLY pure JSON. Do NOT use code fences, markdown, or any extra explanation—just the JSON object.
IMPORTANT: If you are already on the target URL, do NOT suggest another navigate action. Instead, proceed to the next logical step.

Based on the above, what is the next best action?
- Only use one of these actions: ${allowedActions.join(", ")}.
- Do NOT invent new actions. Do NOT use 'search'.
- If you need to perform a search, use 'type' to enter the query and 'click' to press the search button or simulate Enter.
- If you believe the task is complete, output {"action": "finish", "arguments": {}}.

Output as JSON: {action, arguments}
${parser.getFormatInstructions()}
`;

  context.log('Analyze prompt length (chars):', analyzePrompt.length);

  // Get LLM response
  const analyzeResult = await context.llm.invoke(analyzePrompt);
  context.log('Analyze Page Node: LLM decision:', analyzeResult.content);

  // Clean and parse the LLM output
  const cleanedOutput = cleanLLMJsonOutput(analyzeResult.content);
  let parsed;
  try {
    parsed = await parser.parse(cleanedOutput);
    context.log('Parsed action:', parsed.action, 'arguments:', parsed.arguments);
  } catch (parseErr) {
    context.log('Error parsing LLM output:', parseErr);
    context.log('Raw LLM output was:', cleanedOutput);
    context.error = 'Invalid LLM output: ' + cleanedOutput;
    return { ...context, nextNode: 'errorHandlingNode' };
  }

  // Strictly enforce allowedActions
  if (!allowedActions.includes(parsed.action)) {
    context.log(`LLM suggested invalid action '${parsed.action}'. Allowed actions: ${allowedActions.join(', ')}. Overriding.`);
    // Prefer 'type', then 'click', then 'extract', then 'finish', else just the first allowed
    let fallback = allowedActions.find(a => ['type', 'click', 'extract', 'finish'].includes(a)) || allowedActions[0];
    parsed = { action: fallback, arguments: {} };
    context.log(`Auto-selected fallback action: '${parsed.action}'.`);
  }

  // Special case: if action is 'navigate' and arguments is a string, coerce to { url }
  let { action, arguments: args } = parsed;
  if (action === 'navigate' && typeof args === 'string') {
    args = { url: args };
  }
  // Return the next node with the (possibly overridden) action
  context.nextAction = parsed.action;
  context.nextArgs = args;
  return { ...context, nextNode: 'takeActionNode' };
}
