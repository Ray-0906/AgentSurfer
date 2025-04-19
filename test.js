import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
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

// 6. Extract Info Node
function extractQueryFromTask(task) {
  // Extract what's inside single/double quotes after 'search for', or fallback
  const match = task.match(/search for ['"](.+?)['"]/i) || task.match(/search for ([^,]+)/i);
  return match ? match[1] : 'AI agents';
}

function extractIndexFromTask(task) {
  // Match e.g. '8th', '3rd', '2nd', '10th', etc.
  const match = task.match(/extract the (\d+)(?:st|nd|rd|th)? result/i);
  if (match) return parseInt(match[1], 10) - 1;
  // Match e.g. 'first', 'second', ...
  const words = ["first","second","third","fourth","fifth","sixth","seventh","eighth","ninth","tenth"];
  const matchWord = task.match(/extract the (\w+) result/i);
  if (matchWord) {
    const idx = words.indexOf(matchWord[1].toLowerCase());
    if (idx !== -1) return idx;
  }
  return 0;
}

async function extractInfoNode(context) {
  const { page, log, actionsTaken, llm } = context;
  try {
    log('Extract Information Node: Fetching page content...');
    // Always use Puppeteer to get the page content
    const content = await page.content();

    // --- Explicitly automate the search process ---
    log('Navigating to DuckDuckGo homepage...');
    await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded' });
    log('Waiting for search bar...');
    await page.waitForSelector('input[name="q"]', { timeout: 8000 });
    const query = extractQueryFromTask(context.task);
    log('Typing query:', query);
    await page.type('input[name="q"]', query, { delay: 100 });
    log('Submitting search (pressing Enter)...');
    await page.keyboard.press('Enter');
    // Wait for results container after search
    const resultsSelectors = ['.results', '.react-results--main', '[data-testid="result-title-a"]'];
    let foundContainer = false;
    for (const sel of resultsSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        foundContainer = true;
        log('Results container found:', sel);
        break;
      } catch (e) {
        // Not found, try next
      }
    }
    if (!foundContainer) {
      log('No results container found after search. Saving screenshot and HTML for debugging.');
      await page.screenshot({ path: 'debug_no_results.png', fullPage: true });
      const html = await page.content();
      const fs = await import('fs');
      fs.writeFileSync('debug_no_results.html', html);
      return { ...context, finalResult: 'Extraction failed: No results container found after search. See debug_no_results.png and debug_no_results.html.', nextNode: 'endNode' };
    }

    // Collect candidate selectors for first/second result title
    let candidateSelectors = await page.evaluate(() => {
      // Try common DuckDuckGo result title selectors
      const selectors = [
        '.result__title a',
        '.react-results--main .react-results__title a',
        "a[data-testid='result-title-a']",
        'h2 a',
      ];
      const candidates = [];
      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        els.forEach((el, idx) => {
          candidates.push({ selector: sel, index: idx, outerHTML: el.outerHTML, text: el.textContent.trim() });
        });
      }
      // Also try all <a> in main results area
      const anchors = Array.from(document.querySelectorAll('.react-results--main a, .results a, a[data-testid]'));
      anchors.forEach((a, idx) => {
        if (a && a.textContent && a.textContent.trim().length > 0) {
          candidates.push({ selector: a.getAttribute('data-testid') ? `a[data-testid='${a.getAttribute('data-testid')}']` : 'a', index: idx, outerHTML: a.outerHTML, text: a.textContent.trim() });
        }
      });
      return candidates.slice(0, 12); // limit for prompt size
    });

    // If no candidates found, wait and try again (handle dynamic content)
    if (candidateSelectors.length === 0) {
      log('No candidate selectors found, waiting for results to load (2s)...');
      await new Promise(res => setTimeout(res, 2000));
      candidateSelectors = await page.evaluate(() => {
        const selectors = [
          '.result__title a',
          '.react-results--main .react-results__title a',
          "a[data-testid='result-title-a']",
          'h2 a',
        ];
        const candidates = [];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          els.forEach((el, idx) => {
            candidates.push({ selector: sel, index: idx, outerHTML: el.outerHTML, text: el.textContent.trim() });
          });
        }
        const anchors = Array.from(document.querySelectorAll('.react-results--main a, .results a, a[data-testid]'));
        anchors.forEach((a, idx) => {
          if (a && a.textContent && a.textContent.trim().length > 0) {
            candidates.push({ selector: a.getAttribute('data-testid') ? `a[data-testid='${a.getAttribute('data-testid')}']` : 'a', index: idx, outerHTML: a.outerHTML, text: a.textContent.trim() });
          }
        });
        return candidates.slice(0, 12);
      });
    }
    // If still empty, wait longer and try one last time
    if (candidateSelectors.length === 0) {
      log('Still no candidate selectors found, waiting for results to load (3s, last attempt)...');
      await new Promise(res => setTimeout(res, 3000));
      candidateSelectors = await page.evaluate(() => {
        const selectors = [
          '.result__title a',
          '.react-results--main .react-results__title a',
          "a[data-testid='result-title-a']",
          'h2 a',
        ];
        const candidates = [];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          els.forEach((el, idx) => {
            candidates.push({ selector: sel, index: idx, outerHTML: el.outerHTML, text: el.textContent.trim() });
          });
        }
        const anchors = Array.from(document.querySelectorAll('.react-results--main a, .results a, a[data-testid]'));
        anchors.forEach((a, idx) => {
          if (a && a.textContent && a.textContent.trim().length > 0) {
            candidates.push({ selector: a.getAttribute('data-testid') ? `a[data-testid='${a.getAttribute('data-testid')}']` : 'a', index: idx, outerHTML: a.outerHTML, text: a.textContent.trim() });
          }
        });
        return candidates.slice(0, 12);
      });
    }
    // Last resort: if still empty, extract all visible <a> elements with text
    if (candidateSelectors.length === 0) {
      log('All attempts failed. Falling back to all visible <a> elements with text.');
      candidateSelectors = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors
          .filter(a => a.offsetParent !== null && a.textContent && a.textContent.trim().length > 0)
          .map((a, idx) => ({ selector: 'a', index: idx, outerHTML: a.outerHTML, text: a.textContent.trim() }))
          .slice(0, 15);
      });
    }
    // If still empty, abort with clear error
    if (candidateSelectors.length === 0) {
      log('Extraction failed: No visible <a> elements with text found.');
      return { ...context, finalResult: 'Extraction failed: No visible <a> elements with text found.', nextNode: 'endNode' };
    }

    log('Candidate selectors for extraction:', candidateSelectors);

    // Parse extraction index from task
    const extractionIndex = extractIndexFromTask(context.task);
    log('Extraction index parsed from task:', extractionIndex);

    // Ask LLM to pick the best selector for the Nth result (second, if requested)
    const whichResult = /second/i.test(context.task) ? 'second' : 'first';
    const llmPrompt = `You are a web agent. Here are candidate elements for the ${whichResult} search result title on DuckDuckGo:\n\n${candidateSelectors.map((c, i) => `#${i+1}\nSelector: ${c.selector} [index ${c.index}]\nText: ${c.text}\nHTML: ${c.outerHTML.slice(0, 120)}...`).join('\n\n')}\n\nWhich selector and index best matches the ${whichResult} result title? Reply with the selector string and index, e.g. ".result__title a", 1`;

    const llmResponse = await llm.invoke([{ role: 'user', content: llmPrompt }]);
    let bestSelector = (llmResponse.content || '').trim().split('\n')[0];
    let selectorMatch = bestSelector.match(/([\s\S]+?),\s*(\d+)/);
    let selector = '.result__title a', index = whichResult === 'second' ? 1 : 0;
    if (selectorMatch) {
      selector = selectorMatch[1].trim();
      index = parseInt(selectorMatch[2], 10);
    }
    log('LLM-chosen selector for extraction:', selector, 'index:', index);

    return { ...context, pageContent: content, extractionSelector: selector, extractionIndex: extractionIndex, candidateSelectors, nextNode: 'extractWithSelectorNode' };

  } catch (e) {
    context.error = e;
    return { ...context, nextNode: 'errorHandlingNode' };
  }
}

// 6b. Extract With Selector Node
async function extractWithSelectorNode(context) {
  const { page, extractionSelector, extractionIndex, candidateSelectors = [], log } = context;
  log('Extracting text using selector:', extractionSelector, 'index:', extractionIndex);
  let tried = new Set();
  let lastError = null;

  // 1. Try the LLM-chosen selector and index first
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

  // 2. Fallback: Try candidateSelectors by index (robust for arbitrary sites)
  log('LLM-chosen selector failed or empty. Attempting fallback with candidateSelectors...');
  log('candidateSelectors.length:', candidateSelectors.length);
  if (candidateSelectors && candidateSelectors.length > 0) {
    let mainTried = false;
    // 1. Try the extractionIndex-th candidate first (if in range)
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
    // 2. Try all other candidates (except the one already tried)
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
  // 3. If all else fails
  return { ...context, finalResult: `Extraction failed: ${lastError ? lastError.message : 'No candidates matched.'}`, nextNode: 'endNode' };
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
  extractWithSelectorNode, // Register the new node
  analyzePageNode,
  takeActionNode,
  errorHandlingNode,
  checkCompletionNode,
  endNode,
};

(async () => {
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  // Set a realistic user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  const tools = createTools(page);
  const llm = new ChatMistralAI({
    model: 'codestral-latest',
    apiKey: process.env.MISTRAL_API_KEY,
  });

  // Central context object
  const context = {
    task: "Go to duckduckgo.com, search for 'Heavenly Demon', and extract the 5th result title.",
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