import puppeteer from 'puppeteer';
import { ChatMistralAI } from '@langchain/mistralai';
import { createTools } from './tools.js';
//import 'dotenv/config';
import { config } from 'dotenv';
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
config();
// LangGraph-inspired Autonomous Web Agent

// ---- NODE DEFINITIONS ---- //
// Each node is a modular async function. The workflow controller manages transitions.

// 1. Start Node
async function startNode(context) {
  context.log('Start Node: Received task:', context.task);
  return { ...context, nextNode: 'planNode' };
}

// 2. Plan Node
async function planNode(context) {
  context.log('Plan Node: Creating high-level plan...');
  // Use LLM to generate a step-by-step plan
  const planPrompt = `Task: ${context.task}\nGenerate a step-by-step plan to accomplish this web task. Be explicit about navigation, typing, clicking, and extraction.`;
  const planResult = await context.llm.invoke(planPrompt);
  context.log('Plan Node: Plan generated:', planResult.content);
  context.plan = planResult.content;
  return { ...context, nextNode: 'extractInfoNode' };
}

// 3. Extract Information Node


async function extractInfoNode(context) {
  context.log('Extract Information Node: Fetching page content...');
  try {
    let url = await context.page.url();
    // If on about:blank, navigate to the target site first if possible
    if (url === 'about:blank' && context.nextArgs?.url) {
      context.log('Navigating to:', context.nextArgs.url);
      await context.page.goto(context.nextArgs.url, { waitUntil: 'domcontentloaded' });
      url = await context.page.url();
    }
    if (url.startsWith('http')) {
      const loader = new CheerioWebBaseLoader(url);
      const docs = await loader.load();
      context.pageContent = docs[0]?.pageContent || '';
      context.pageMetadata = docs[0]?.metadata || {};
    } else {
      // fallback: extract visible text with Puppeteer
      context.pageContent = await context.page.evaluate(() => document.body.innerText || '');
      context.pageMetadata = {};
    }
    context.screenshot = await context.page.screenshot({ encoding: 'base64' });
    return { ...context, nextNode: 'analyzePageNode' };
  } catch (e) {
    context.error = e;
    return { ...context, nextNode: 'errorHandlingNode' };
  }
}


// 4. Analyze Page Node
import { StructuredOutputParser } from "langchain/output_parsers";
import { z } from "zod";
async function analyzePageNode(context) {
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
  const parser = StructuredOutputParser.fromZodSchema(actionSchema);

  // Utility to clean LLM output (strip code fences, whitespace)
  function cleanLLMJsonOutput(output) {
    return output
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim();
  }

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
  let parsed = await parser.parse(cleanedOutput);
  context.log('Parsed action:', parsed.action, 'arguments:', parsed.arguments);

  // Strictly enforce allowedActions
  if (!allowedActions.includes(parsed.action)) {
    context.log(`LLM suggested invalid action '${parsed.action}'. Allowed actions: ${allowedActions.join(', ')}. Overriding.`);
    // Prefer 'type', then 'click', then 'extract', then 'finish', else just the first allowed
    let fallback = allowedActions.find(a => ['type','click','extract','finish'].includes(a)) || allowedActions[0];
    parsed.action = fallback;
    parsed.arguments = {};
    context.log(`Auto-selected fallback action: '${parsed.action}'.`);
  }

  // Special case: if action is 'navigate' and arguments is a string, coerce to { url }
  try {
    let { action, arguments: args } = parsed;
    if (action === 'navigate' && typeof args === 'string') {
      args = { url: args };
      return { ...context, nextNode: 'takeActionNode' };
    }
    // Return the next node with the (possibly overridden) action
    context.nextAction = parsed.action;
    context.nextArgs = parsed.arguments;
    return { ...context, nextNode: 'takeActionNode' };
  } catch (parseErr) {
    context.log('Error parsing LLM output:', parseErr);
    context.log('Raw LLM output was:', cleanedOutput);
    context.error = 'Invalid LLM output: ' + cleanedOutput;
    return { ...context, nextNode: 'errorHandlingNode' };
  }
}

// 5. Take Action Node
async function takeActionNode(context) {
  context.log('Take Action Node: Executing action:', context.nextAction);
  context.log('Action arguments:', context.nextArgs);
  const page = context.page;
  const action = context.nextAction;
  const args = context.nextArgs;
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
    let result;
    let tool;
    switch (context.nextAction) {
      case 'navigate':
        tool = context.tools.find(t => t.name === 'navigate_to_url');
        context.log('Tool lookup for navigate:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'navigate_to_url' not found");
        result = await tool.call({ url: context.nextArgs.url });
        break;
      case 'type':
        tool = context.tools.find(t => t.name === 'type_text');
        context.log('Tool lookup for type:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'type_text' not found");
        result = await tool.call(context.nextArgs);
        break;
      case 'click':
        tool = context.tools.find(t => t.name === 'click_element');
        context.log('Tool lookup for click:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'click_element' not found");
        result = await tool.call(context.nextArgs);
        break;
      case 'extract':
        tool = context.tools.find(t => t.name === 'extract_text');
        context.log('Tool lookup for extract:', tool ? 'FOUND' : 'NOT FOUND');
        if (!tool) throw new Error("Tool 'extract_text' not found");
        result = await tool.call(context.nextArgs);
        context.extracted = result;
        break;
      case 'finish':
        context.log('Finish action detected. Moving to checkCompletionNode.');
        return { ...context, nextNode: 'checkCompletionNode' };
      default:
        context.log('Unknown action:', context.nextAction);
        throw new Error('Unknown action: ' + context.nextAction);
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

// 6. Error Handling Node
async function errorHandlingNode(context) {
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

// 7. Check Completion Node
async function checkCompletionNode(context) {
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

// 8. End Node
async function endNode(context) {
  context.log('End Node: Task finished. Result:', context.finalResult);
  return { ...context, done: true };
}

// ---- WORKFLOW CONTROLLER ---- //
const nodeMap = {
  startNode,
  planNode,
  extractInfoNode,
  analyzePageNode,
  takeActionNode,
  errorHandlingNode,
  checkCompletionNode,
  endNode,
};

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const tools = createTools(page);
  const llm = new ChatMistralAI({
    model: 'codestral-latest',
    apiKey: process.env.MISTRAL_API_KEY,
  });

  // Central context object
  const context = {
    task: "Go to duckduckgo.com, search for 'AI agents', and extract the second result title.",
    page,
    actionsTaken: [],
    tools,
    llm,
    taskTargetUrl: 'https://duckduckgo.com', // Track the navigation goal

    log: (...args) => console.log('[Agent]', ...args),
    retryCount: 0,
    lastNode: null,
    done: false,
    actionsTaken: [], // Track actions and results
  };

  let currentNode = 'startNode';
  while (!context.done) {
    context.lastNode = currentNode;
    const nodeFn = nodeMap[currentNode];
    if (!nodeFn) throw new Error('Unknown node: ' + currentNode);
    const result = await nodeFn(context);
    Object.assign(context, result); // Update context with new state
    currentNode = context.nextNode;
  }

  console.log('\n[Agent] Final Result:', context.finalResult);
  await browser.close();
})();