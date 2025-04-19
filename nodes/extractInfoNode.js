import { cleanLLMJsonOutput } from './cleanLLMJsonOutput.js';
import { ensureSelectorForTypeAction } from './ensureSelectorForTypeAction.js';
import { validateActionArgs } from './validateActionArgs.js';
import { extractQueryFromTask } from './extractQueryFromTask.js';

export async function extractInfoNode(context) {
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
  const cleanedOutput = cleanLLMJsonOutput(llmResponse.content);
  log('Cleaned LLM output:', cleanedOutput);
  try {
    parsed = JSON.parse(cleanedOutput);
  } catch (e) {
    log('LLM output could not be parsed as JSON. Raw output was:', llmResponse.content);
    log('Cleaned output was:', cleanedOutput);
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
    const hasClicked = steps.some(s => s.action === 'click' || s.action === 'click_enter');
    const hasExtracted = steps.some(s => s.action === 'extract');
    // Step 1: Force typing if not yet done
    if (isDuck && !hasTyped) {
      log('[FORCE TYPE] On DuckDuckGo and have not typed the query yet. Setting headers and clearing cookies.');
      // Set user-agent and Accept-Language
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
      // Clear cookies and storage
      try {
        const cookies = await page.cookies();
        if (cookies.length > 0) await page.deleteCookie(...cookies);
      } catch {}
      await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch(e){} });
      // Go to DuckDuckGo homepage (force reload)
      await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded' });

      const query = extractQueryFromTask(context.task);
      if (!query || typeof query !== 'string' || !query.trim()) {
        log('[FORCE TYPE] No valid query extracted from task.');
        return { ...context, error: 'No valid query for typing', nextNode: 'errorHandlingNode' };
      }
      const typeArgs = { selector: "input[name='q']", text: query };
      const typeTool = tools.find(t => t.name === 'type_text');
      if (!typeTool) {
        log('[FORCE TYPE] type_text tool not found!');
        return { ...context, error: 'type_text tool not found', nextNode: 'errorHandlingNode' };
      }
      await typeTool.call(typeArgs);
      const forcedSteps = [...steps, { tool: typeTool.name, action: 'type', args: typeArgs, result: null }];
      context.pageContent = await page.content();

      log('[FORCE CLICK] Immediately after type, forcing click (submit) on DuckDuckGo.');
      const clickSelectors = "input[type='submit'], button[type='submit'], form input[type='submit'], form button[type='submit']";
      const clickTool = tools.find(t => t.name === 'click_element');
      let clickResult = null;
      let clickAction = 'click';
      if (!clickTool) {
        log('[FORCE CLICK] click_element tool not found!');
        return { ...context, error: 'click_element tool not found', nextNode: 'errorHandlingNode' };
      }
      try {
        await page.waitForSelector(clickSelectors, { timeout: 2000 }).catch(() => {});
        clickResult = await clickTool.call({ selector: clickSelectors });
      } catch (err) {
        log('[FORCE CLICK] Click failed after type:', err);
        // Try Enter key fallback
        try {
          await page.focus("input[name='q']");
          await page.keyboard.press('Enter');
          clickAction = 'click_enter';
          clickResult = 'Pressed Enter as fallback';
        } catch (e2) {
          log('[FORCE CLICK] Both click and Enter fallback failed:', e2);
          return { ...context, error: 'Search submit failed after typing', nextNode: 'errorHandlingNode' };
        }
      }
      const clickedSteps = [...forcedSteps, { tool: clickTool.name, action: clickAction, args: { selector: clickSelectors }, result: clickResult }];
      context.pageContent = await page.content();

      log('[FORCE EXTRACT] Waiting for DuckDuckGo results to load...');
      let resultsSelector = '#links .result, .results--main .result';
      let foundResults = false;
      try {
        await page.waitForSelector(resultsSelector, { timeout: 10000 });
        foundResults = true;
      } catch (e) {
        log('[FORCE EXTRACT] Results selector not found, trying non-JS DuckDuckGo.');
        // Fallback: Use non-JS version
        await page.goto('https://html.duckduckgo.com/html/', { waitUntil: 'domcontentloaded' });
        await page.type('input[name="q"]', query);
        await page.keyboard.press('Enter');
        resultsSelector = '.result';
        try {
          await page.waitForSelector(resultsSelector, { timeout: 10000 });
          foundResults = true;
        } catch (e2) {
          log('[FORCE EXTRACT] Still no results found on non-JS version.');
          return { ...context, error: 'No search results found on DuckDuckGo', nextNode: 'errorHandlingNode' };
        }
      }
      const extractTool = tools.find(t => t.name === 'extract_text');
      if (!extractTool) {
        log('[FORCE EXTRACT] extract_text tool not found!');
        return { ...context, error: 'extract_text tool not found', nextNode: 'errorHandlingNode' };
      }
      let extractResult;
      try {
        extractResult = await extractTool.call({ selector: resultsSelector });
      } catch (err) {
        log('[FORCE EXTRACT] Extraction failed:', err);
        return { ...context, error: 'Extraction failed after type/click', nextNode: 'errorHandlingNode' };
      }
      const extractSteps = [...clickedSteps, { tool: extractTool.name, action: 'extract', args: { selector: resultsSelector }, result: extractResult }];
      context.pageContent = await page.content();
      return { ...context, steps: extractSteps, outputFormat, outputSchema, nextNode: 'extractInfoNode', stepCount: stepCount + 1 };
    }
    // If LLM keeps suggesting 'type' after type+click+extract, parse and extract DuckDuckGo results, visit top 5, and structure output
    if (isDuck && hasTyped && hasClicked && hasExtracted && action === 'type') {
      log('[FORCE FINISH+EXTRACT] DuckDuckGo: Already typed, clicked, and extracted. Parsing results and visiting top links.');
      // Parse top 5 organic results
      const results = await page.$$eval('#links .result, .results--main .result', nodes => nodes.map(node => ({
        title: node.querySelector('h2, .result__title')?.innerText?.trim(),
        url: node.querySelector('a')?.href,
        snippet: node.querySelector('.result__snippet, .result__desc')?.innerText?.trim()
      })).filter(r => r.url && r.title));
      log(`[PARSE] Found ${results.length} search results.`);
      const breakthroughs = [];
      for (let i = 0; i < Math.min(results.length, 5); i++) {
        const { url, title, snippet } = results[i];
        log(`[VISIT] Navigating to result #${i+1}: ${url}`);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          // Extract main content from page (simple text extraction)
          const pageTitle = await page.title();
          const pageContent = await page.$eval('body', el => el.innerText.slice(0, 3000));

          // Heuristic extraction for contributors, year, applications, impact
          let contributors = '';
          let year = '';
          let notable_applications = '';
          let impact = '';

          // Contributors/orgs: look for patterns like "by <org>", "by <person>", "Authors: <...>", "Contributors: <...>", "Organization: <...>"
          const contributorsMatch = pageContent.match(/(?:By|Authors?:|Contributors?:|Organization:|Team:|Research by)\s*([A-Z][A-Za-z0-9&.,\- ]{3,100})/i);
          if (contributorsMatch) contributors = contributorsMatch[1].trim();

          // Year: look for 20xx or 202x
          const yearMatch = pageContent.match(/(20\d{2})/);
          if (yearMatch) year = yearMatch[1];

          // Notable applications/impact: look for sentences with "impact", "application", "used for", "enabled", "led to"
          const impactMatch = pageContent.match(/(?:impact|application(?:s)?|used for|enabled|led to)[^.!?]{0,100}[.!?]/i);
          if (impactMatch) impact = impactMatch[0].trim();

          // If snippet is available, use it for description, else use first 2-3 lines of page content
          const description = snippet || pageContent.split('\n').slice(0,3).join(' ');

          breakthroughs.push({
            title: pageTitle,
            description,
            contributors,
            year,
            source_url: url,
            notable_applications: notable_applications || impact,
            impact
          });
        } catch (e) {
          log(`[ERROR] Could not extract from ${url}:`, e.message);
        }
      }
      // Generate trends summary (simple keyword frequency)
      const trendsText = breakthroughs.map(b => `${b.description} ${b.impact} ${b.notable_applications}`).join(' ').toLowerCase();
      const trends = [];
      if ((trendsText.match(/language model|nlp|gpt|bert|llm/g)||[]).length > 1) trends.push('Advancements in natural language processing and large language models.');
      if ((trendsText.match(/ethic|fairness|responsib|bias/g)||[]).length > 1) trends.push('Increased focus on ethical AI and fairness.');
      if ((trendsText.match(/health|biotech|medical|diagnos/g)||[]).length > 1) trends.push('Growth in AI applications in healthcare and biotechnology.');
      if ((trendsText.match(/efficient|scalable|optimization|faster/g)||[]).length > 1) trends.push('Development of more efficient and scalable AI algorithms.');
      if ((trendsText.match(/creative|art|music|design/g)||[]).length > 1) trends.push('Expansion of AI in creative industries and digital arts.');
      const trends_summary = trends.length ? trends.map((t,i) => `- Trend ${i+1}: ${t}`).join('\n') : 'No clear trends detected.';
      const resultObj = { breakthroughs, trends_summary };
      return { ...context, outputFormat: 'custom', outputSchema: { breakthroughs, trends_summary }, nextNode: null, steps: [...steps, { action: 'finish', args: {}, result: resultObj }] };

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

    // Utility: Try to autofill missing selector for DuckDuckGo 'type' action
    if (action === 'type' && (!args || typeof args.selector !== 'string' || !args.selector.trim())) {
      const autofilled = await ensureSelectorForTypeAction({ ...context, action, args });
      if (autofilled.autoFilledSelector) {
        log(`[UTILITY] Autofilled selector for 'type' action on DuckDuckGo:`, autofilled.args.selector);
        args.selector = autofilled.args.selector;
      } else {
        log(`[DEFENSIVE] Action 'type' missing valid selector and autofill failed. Args:`, args);
        return { ...context, error: `Action 'type' missing required selector`, nextNode: 'errorHandlingNode' };
      }
    }
    // Validate arguments for all actions
    if (!validateActionArgs(action, args)) {
      log(`[DEFENSIVE] Action '${action}' has invalid or missing arguments. Args:`, args);
      return { ...context, error: `Action '${action}' has invalid or missing arguments`, nextNode: 'errorHandlingNode' };
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
