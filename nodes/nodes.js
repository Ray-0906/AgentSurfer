// Each node is a modular async function. The workflow controller manages transitions.

// 1. Start Node
// 1. Start Node
export { startNode } from './startNode.js';

// 2. Plan Node
export { planNode } from './planNode.js';
  context.log('Plan Node: Creating high-level plan...');
  // Use LLM to generate a step-by-step plan
  const planPrompt = `Task: ${context.task}\nGenerate a step-by-step plan to accomplish this web task. Be explicit about navigation, typing, clicking, and extraction.`;
  const planResult = await context.llm.invoke(planPrompt);

// Extract Query From Task
export { extractQueryFromTask } from './extractQueryFromTask.js';

export { extractIndexFromTask } from './extractIndexFromTask.js';
  const matchWord = task.match(/extract the (\w+) result/i);
  if (matchWord) {
    const idx = words.indexOf(matchWord[1].toLowerCase());
    if (idx !== -1) return idx;
  }
  return 0;
}

export { extractInfoNode } from './extractInfoNode.js';
export { extractDuckDuckGoInfoNode } from './extractDuckDuckGoInfoNode.js';

// (see extractInfoNode.js for implementation)

  const { page, log, llm, tools, steps = [], stepCount = 0 } = context;
  log('ExtractInfoNode: General-purpose extraction node starting.');
  log(`Current stepCount: ${stepCount}`);

  // Step limit to prevent infinite loops
  if (stepCount >= 20) {
    log('Step limit exceeded. Exiting to prevent infinite loop.');
    return { ...context, error: 'Step limit exceeded. Possible infinite loop.', nextNode: 'errorHandlingNode' };
  }

  // Step 1: Get the current page content
  const pageContent = await page.content();

  // Step 2: Use the LLM to decide what to do next (plan, selectors, extraction, etc.)
  const llmPrompt = `You are a general-purpose web agent. Given the following user task and page content, decide what action to take next. \nUser Task: ${context.task}\nCurrent Page Content (truncated):\n${pageContent.slice(0, 1500)}\nIMPORTANT: If you have completed the task or extracted all required information, respond with {\n  \"action\": \"finish\", \"args\": {}, ...} and do not repeat any previous actions. Only use 'finish' when you are certain the task is complete.\nRespond in strict JSON with the following format:\n{\n  \"action\": \"<navigate|type|click|extract|finish>\",\n  \"args\": { ... },\n  \"outputFormat\": \"<table|list|summary|custom>\",\n  \"outputSchema\": { ...description of expected output structure... }\n}`;

  const llmResponse = await llm.invoke(llmPrompt);
  log('Raw LLM response:', llmResponse.content);
  let parsed;
  try {
    parsed = JSON.parse(cleanLLMJsonOutput(llmResponse.content));
  } catch (e) {
    log('LLM output could not be parsed as JSON. Output was:', llmResponse.content);
    return { ...context, error: 'LLM output not JSON', nextNode: 'errorHandlingNode' };
  }

  const { action, args, outputFormat, outputSchema } = parsed || {};
  log('Parsed action:', action, 'args:', args, 'outputFormat:', outputFormat);

  // Fallback if action is missing or invalid
  if (!action || !['navigate', 'type', 'click', 'extract', 'finish'].includes(action)) {
    log('LLM returned invalid or missing action:', action);
    return { ...context, error: `LLM returned invalid or missing action: ${action}`, nextNode: 'errorHandlingNode' };
  }

  // Step 3: Execute the decided tool/action
  let toolResult = null;
  try {
    const toolNameMap = {
      'type': 'type_text',
      'navigate': 'navigate_to_url',
      'click': 'click_element',
      'extract': 'extract_text',
    };
    const mappedToolName = toolNameMap[action] || action;
    const availableToolNames = tools.map(t => t.name);
    log('Available tools:', availableToolNames);
    log('Looking for tool with name:', mappedToolName);
    let tool = tools.find(t => t.name === mappedToolName || t.name.includes(action));
    log('Selected tool:', tool ? tool.name : 'none');

    // --- FORCED TYPE FALLBACK: If on DuckDuckGo and haven't typed yet, always type the query ---
    const currentUrl = await page.url();
    const duckUrls = [
      'https://duckduckgo.com',
      'https://www.duckduckgo.com',
      'http://duckduckgo.com',
      'http://www.duckduckgo.com'
    ];
    const isDuck = duckUrls.some(u => currentUrl.startsWith(u));
    const hasTyped = steps.some(s => s.action === 'type');
    const hasClicked = steps.some(s => s.action === 'click');
    // Step 1: Force typing if not yet done
    if (isDuck && !hasTyped && action !== 'type') {
      log('[FORCE TYPE] On DuckDuckGo and have not typed the query yet. Forcing type_text action.');
      const query = extractQueryFromTask(context.task);
      if (!query || typeof query !== 'string' || !query.trim()) {
        log('[FORCE TYPE ERROR] Could not extract a valid search query from the task:', context.task);
        return { ...context, error: 'No valid search query found in task', nextNode: 'errorHandlingNode' };
      }
      const selector = "input[name='q']";
      if (!selector || typeof selector !== 'string' || !selector.trim()) {
        log('[FORCE TYPE ERROR] No valid selector for DuckDuckGo search input.');
        return { ...context, error: 'No valid selector for DuckDuckGo search input', nextNode: 'errorHandlingNode' };
      }
      const forceArgs = { selector, text: query };
      tool = tools.find(t => t.name === 'type_text');
      if (tool) {
        toolResult = await tool.call(forceArgs);
        const newSteps = [...steps, { tool: tool.name, action: 'type', args: forceArgs, result: toolResult }];
        context.pageContent = await page.content();
        return { ...context, steps: newSteps, outputFormat, outputSchema, nextNode: 'extractInfoNode', stepCount: stepCount + 1 };
      } else {
        log('[FORCE TYPE] type_text tool not found!');
        return { ...context, error: 'type_text tool not found', nextNode: 'errorHandlingNode' };
      }
    }
    // Step 2: After typing, force click/submit if not yet done
    if (isDuck && hasTyped && !hasClicked && action !== 'click') {
      log('[FORCE CLICK] On DuckDuckGo after typing, but have not submitted search yet. Forcing click_element action.');
      const clickSelectors = "input[type='submit'], button[type='submit'], form input[type='submit'], form button[type='submit']";
      tool = tools.find(t => t.name === 'click_element');
      if (tool) {
        const forceClickArgs = { selector: clickSelectors };
        try {
          toolResult = await tool.call(forceClickArgs);
        } catch (err) {
          log('[FORCE CLICK] Click failed, trying Enter key fallback in input[name=\'q\']');
          try {
            await page.focus("input[name='q']");
            await page.keyboard.press('Enter');
            toolResult = await page.content();
          } catch (e2) {
            log('[FORCE CLICK] Both click and Enter fallback failed:', e2);
            return { ...context, error: 'Search submit failed after typing', nextNode: 'errorHandlingNode' };
          }
        }
        const newSteps = [...steps, { tool: tool.name, action: 'click', args: forceClickArgs, result: toolResult }];
        context.pageContent = await page.content();
        return { ...context, steps: newSteps, outputFormat, outputSchema, nextNode: 'extractInfoNode', stepCount: stepCount + 1 };
      } else {
        log('[FORCE CLICK] click_element tool not found!');
        return { ...context, error: 'click_element tool not found', nextNode: 'errorHandlingNode' };
      }
    }

    // Fallback for 'type' if not found
    if (!tool && action === 'type') {
      tool = tools.find(t => t.name === 'type_text');
      if (tool) {
        const query = extractQueryFromTask(context.task);
        const args = { selector: "input[name='q']", text: query };
        log('Fallback: Using type_text tool with args:', args);
        toolResult = await tool.call(args);
        const newSteps = [...steps, { tool: tool.name, action, args, result: toolResult }];
        context.pageContent = await page.content();
        return { ...context, steps: newSteps, outputFormat, outputSchema, nextNode: 'extractInfoNode', stepCount: stepCount + 1 };
      }
    }

    if (action === 'finish') {
      // Let the agent know to finish and format output
      return { ...context, outputFormat, outputSchema, nextNode: 'checkCompletionNode', steps: [...steps, { action, args, result: null }] };
    }
    if (!tool) {
      log('No tool found for action:', action);
      return { ...context, error: 'No tool found for action: ' + action, nextNode: 'errorHandlingNode' };
    }
    toolResult = await tool.call(args);
    // Log the step
    const newSteps = [...steps, { tool: tool.name, action, args, result: toolResult }];
    // Save page content if changed
    context.pageContent = await page.content();
    return { ...context, steps: newSteps, outputFormat, outputSchema, nextNode: 'extractInfoNode', stepCount: stepCount + 1 };
  } catch (err) {
    log('Error executing tool:', err);
    return { ...context, error: err.message, nextNode: 'errorHandlingNode' };
  }
}

export { extractWithSelectorNode } from './extractWithSelectorNode.js';

// (see extractWithSelectorNode.js for implementation)

  const { page, log, extractionSelector, extractionIndex, candidateSelectors } = context;
  log('Extract With Selector Node: Attempting extraction with selector:', extractionSelector, 'index:', extractionIndex);
  let lastError = null;
  const tried = new Set();

  // Try the LLM-chosen selector and index first
  try {
    await page.waitForSelector(extractionSelector, { timeout: 4000 });
    const elements = await page.$$(extractionSelector);
    if (elements.length > extractionIndex) {
      const el = elements[extractionIndex];
      const text = await page.evaluate(el => el.textContent.trim(), el);
      if (text && text.length > 0) {
        log('Extracted text (LLM-chosen):', text);
        return { ...context, finalResult: text, nextNode: 'endNode' };
      }
    }
    log('LLM-chosen selector found, but no element at index or empty text.');
  } catch (err) {
    log('Extraction failed for LLM-chosen selector', extractionSelector, `[${extractionIndex}]:`, err.message);
    lastError = err;
  }

  // Fallback: Try candidateSelectors by index (robust for arbitrary sites)
  log('LLM-chosen selector failed or empty. Attempting fallback with candidateSelectors...');
  log('candidateSelectors.length:', candidateSelectors.length);
  if (candidateSelectors && candidateSelectors.length > 0) {
    let mainTried = false;
    // Try the extractionIndex-th candidate first (if in range)
    if (typeof extractionIndex === 'number' && extractionIndex >= 0 && extractionIndex < candidateSelectors.length) {
      const fallback = candidateSelectors[extractionIndex];
      if (!tried.has(fallback.selector + fallback.index)) {
        tried.add(fallback.selector + fallback.index);
        try {
          await page.waitForSelector(fallback.selector, { timeout: 2000 });
          const elements = await page.$$(fallback.selector);
          if (elements.length > fallback.index) {
            const el = elements[fallback.index];
            const text = await page.evaluate(el => el.textContent.trim(), el);
            if (text && text.length > 0) {
              log(`Extracted text (candidateSelectors fallback, extractionIndex): [${fallback.selector}][${fallback.index}]`, text);
              return { ...context, finalResult: text, nextNode: 'endNode' };
            }
          }
        } catch (err) {
          log('Fallback extraction failed for extractionIndex candidate', fallback.selector, `[${fallback.index}]:`, err.message);
          lastError = err;
        }
        mainTried = true;
      }
    }
    // Try all other candidates (except the one already tried)
    for (let i = 0; i < candidateSelectors.length; ++i) {
      if (mainTried && i === extractionIndex) continue;
      const fallback = candidateSelectors[i];
      if (tried.has(fallback.selector + fallback.index)) continue;
      tried.add(fallback.selector + fallback.index);
      try {
        await page.waitForSelector(fallback.selector, { timeout: 2000 });
        const elements = await page.$$(fallback.selector);
        if (elements.length > fallback.index) {
          const el = elements[fallback.index];
          const text = await page.evaluate(el => el.textContent.trim(), el);
          if (text && text.length > 0) {
            log(`Extracted text (candidateSelectors fallback): [${fallback.selector}][${fallback.index}]`, text);
            return { ...context, finalResult: text, nextNode: 'endNode' };
          }
        }
      } catch (err) {
        log('Fallback extraction failed for', fallback.selector, `[${fallback.index}]:`, err.message);
        lastError = err;
      }
    }
  }
  // If all else fails
  return { ...context, finalResult: `Extraction failed: ${lastError ? lastError.message : 'No candidates matched.'}`, nextNode: 'endNode' };
}

export { analyzePageNode } from './analyzePageNode.js';

// (see analyzePageNode.js for implementation)

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

export { takeActionNode } from './takeActionNode.js';

// (see takeActionNode.js for implementation)

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

export { errorHandlingNode } from './errorHandlingNode.js';

// (see errorHandlingNode.js for implementation)

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

export { checkCompletionNode } from './checkCompletionNode.js';

// (see checkCompletionNode.js for implementation)

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

export { endNode } from './endNode.js';

// (see endNode.js for implementation)

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
