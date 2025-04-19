// Multi-Agent Orchestrator for General-Purpose Web Extraction
// Uses Puppeteer + LLM (LangChain/Mistral) + Modular Agents
// Main entry: orchestrateExtraction(query)

console.log('[TOP-LEVEL] STARTING orchestrator module...');

import puppeteer from 'puppeteer';
import { callLLM } from '../utils/llm.js';
import { z } from 'zod';

// 1. Search Agent: DuckDuckGo search
async function searchDuckDuckGo(query, browser, maxPages = 3) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
  await page.goto('https://duckduckgo.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.type('input[name="q"]', query);
  await Promise.all([
    page.keyboard.press('Enter'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
  ]);

  let allResults = [];
  let currentPage = 1;
  let hasNext = true;

  while (hasNext && currentPage <= maxPages) {
    await new Promise(res => setTimeout(res, 3000)); // Wait for results to load visually
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log(`[DEBUG] [SearchAgent] Visible page text sent to LLM (page ${currentPage}):`, pageText.slice(0, 2000));

    // Split into blocks by URLs (very basic: look for lines containing http(s)://)
    const lines = pageText.split('\n');
    const blocks = [];
    let current = [];
    for (const line of lines) {
      if (/https?:\/\//.test(line) && current.length) {
        blocks.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) blocks.push(current.join('\n'));

    // Only keep blocks that look like a search result (contain a plausible URL)
    const resultBlocks = blocks.filter(b => /https?:\/\//.test(b)).slice(0, 7); // take a few extra in case of noise

    // For each block, prompt LLM to extract a single result
    for (const block of resultBlocks) {
      const prompt = `Given the following search result text from DuckDuckGo, extract the title, url, and snippet as a JSON object. Respond ONLY with a JSON object, no explanations, no markdown, no code blocks.\n\nSEARCH RESULT TEXT:\n${block}`;
      let raw;
      try {
        raw = await callLLM(prompt, 'mistral');
        let obj;
        try { obj = JSON.parse(raw); } catch (e) {
          // Try to extract JSON object from text
          const match = raw.match(/\{[\s\S]*?\}/);
          if (match) {
            try { obj = JSON.parse(match[0]); } catch {}
          }
        }
        if (obj && typeof obj.url === 'string' && obj.url.startsWith('http')) {
          allResults.push(obj);
        }
      } catch (e) {
        console.warn('[SearchAgent] LLM extraction failed for block:', e);
      }
    }

    // Try to find and click the 'Next' button if it exists
    hasNext = await page.evaluate(() => {
      const nextBtn = Array.from(document.querySelectorAll('a,button')).find(
        el => el.textContent && /next/i.test(el.textContent)
      );
      if (nextBtn) {
        nextBtn.scrollIntoView();
        return true;
      }
      return false;
    });
    if (hasNext) {
      try {
        await Promise.all([
          page.evaluate(() => {
            const nextBtn = Array.from(document.querySelectorAll('a,button')).find(
              el => el.textContent && /next/i.test(el.textContent)
            );
            if (nextBtn) nextBtn.click();
          }),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
        ]);
        currentPage++;
      } catch (e) {
        console.warn('[SearchAgent] Failed to navigate to next page:', e);
        hasNext = false;
      }
    }
  }
  await page.close();
  return allResults.slice(0, 15); // Aggregate up to 15 results from multiple pages
}

// 2. Extraction Agent: For each result, visit and LLM-extract
import { extractPageContentWithLangChain } from '../utils/extractPageContentWithLangChain.js';

async function extractBreakthroughFromPage({ url, title, snippet }, browser, llm) {
  console.log(`[DEBUG] [ExtractionAgent] Visiting: ${url}`);
  let pageContent = '';
  try {
    // Use LangChain CheerioWebBaseLoader for robust extraction
    pageContent = await extractPageContentWithLangChain(url);
    console.log(`[DEBUG] [ExtractionAgent] Extracted page content length:`, pageContent.length);
  } catch (e) {
    console.warn(`[ExtractionAgent] LangChain loader failed for ${url}:`, e.message);
    // Fallback: try Puppeteer extraction if loader fails
    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      pageContent = await page.$eval('body', el => el.innerText.slice(0, 4000));
      await page.close();
    } catch (err) {
      console.warn(`[ExtractionAgent] Puppeteer fallback failed for ${url}:`, err.message);
      pageContent = snippet || '';
    }
  }
  // LLM prompt
  const prompt = `Extract the following fields from the article below. If information is not available, return 'N/A'.\n\nFields:\n- Description\n- Main Contributors/Organizations\n- Year\n- Source URL\n- Notable Applications/Impact\n\nArticle Title: ${title}\nSnippet: ${snippet}\nURL: ${url}\nContent: ${pageContent.slice(0, 4000)}\n\nReturn as JSON.`;
  console.log(`[DEBUG] [ExtractionAgent] Calling LLM for: ${url}`);
  const raw = await callLLM(prompt, llm);
  console.log(`[DEBUG] [ExtractionAgent] LLM response for ${url}:`, raw);
  // Validate using Zod
  const schema = z.object({
    Description: z.string(),
    "Main Contributors/Organizations": z.string(),
    Year: z.string(),
    "Source URL": z.string(),
    "Notable Applications/Impact": z.string()
  });
  let structured;
  try {
    structured = schema.parse(JSON.parse(raw));
  } catch (e) {
    structured = {
      Description: snippet || '',
      "Main Contributors/Organizations": 'N/A',
      Year: 'N/A',
      "Source URL": url,
      "Notable Applications/Impact": 'N/A'
    };
  }
  return structured;
}


// 3. Trends Agent: LLM summarization
async function analyzeTrends(breakthroughs, llm) {
  console.log('[DEBUG] [TrendsAgent] Analyzing trends from breakthroughs...');
  const prompt = `Given the following breakthroughs, summarize the main trends in 3-5 bullet points.\n\n${JSON.stringify(breakthroughs, null, 2)}`;
  return callLLM(prompt, llm);
}

// 4. Report Agent: Compile markdown table
function compileReport(breakthroughs, trendsSummary) {
  console.log('[DEBUG] [ReportAgent] Compiling final report...');
  let table = `| Breakthrough | Description | Main Contributors/Organizations | Year | Source URL | Notable Applications/Impact |\n|--------------|-------------|-------------------------------|------|-----------|----------------------------|\n`;
  for (const b of breakthroughs) {
    table += `| ${b.Description.slice(0,40).replace(/\|/g,' ')} | ${b.Description.slice(0,40).replace(/\|/g,' ')} | ${b["Main Contributors/Organizations"]} | ${b.Year} | ${b["Source URL"]} | ${b["Notable Applications/Impact"]} |\n`;
  }
  return { markdown: table + `\n\n### Trends Summary\n${trendsSummary}` };
}

// === Orchestrator ===
async function orchestrateExtraction(query, llm) {
  console.log(`[DEBUG] [Orchestrator] Starting orchestrateExtraction for query: ${query}`);
  const browser = await puppeteer.launch({ headless: false });
  try {
    // 1. Search
    const results = await searchDuckDuckGo(query, browser);
    console.log(`[DEBUG] [Orchestrator] Search results:`, results);
    if (!results || results.length === 0) {
      console.error('[Orchestrator] No search results extracted! Check LLM output and HTML sent.');
      // For debugging: re-run extraction and log LLM output
      const page = await browser.newPage();
      await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded' });
      await page.type('input[name="q"]', query);
      await page.keyboard.press('Enter');
      await new Promise(res => setTimeout(res, 3000));
      const pageContent = await page.content();
      const prompt = `You are an expert web agent. Given the HTML of a DuckDuckGo search results page, extract the top 5 organic search results. For each, return an object with: title, url, snippet. Ignore ads, news, and non-organic results. Return a JSON array.`;
      const raw = await callLLM(`${prompt}\n\nHTML:\n${pageContent.slice(0, 12000)}`);
      console.error('[Orchestrator] LLM raw output:', raw);
      console.error('[Orchestrator] HTML snippet sent to LLM:', pageContent.slice(0, 1200));
      await page.close();
      throw new Error('No search results extracted by LLM.');
    } else {
      results.forEach((r, i) => console.log(`[DEBUG] [Orchestrator] Will extract from result #${i+1}:`, r.url));
    }
    // 2. Extraction (parallel)
    const breakthroughs = await Promise.all(
      results.map(result => extractBreakthroughFromPage(result, browser, llm))
    );
    console.log(`[DEBUG] [Orchestrator] Breakthroughs extracted:`, breakthroughs);
    // 3. Trends
    const trendsSummary = await analyzeTrends(breakthroughs, llm);
    console.log(`[DEBUG] [Orchestrator] Trends summary:`, trendsSummary);
    // 4. Report
    const report = compileReport(breakthroughs, trendsSummary);
    console.log('[DEBUG] [Orchestrator] Final report compiled.');
    return report;
  } finally {
    await browser.close();
  }
}

export { orchestrateExtraction };

// CLI test runner: node ./nodes/multiAgentOrchestrator.js "Your query here"
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('[TOP-LEVEL] CLI runner invoked.');
  const query = process.argv[2] || "AI breakthroughs 2023";
  (async () => {
    try {
      const result = await orchestrateExtraction(query, 'mistral');
      console.log(result.markdown);
    } catch (err) {
      console.error('[TOP-LEVEL ERROR]', err);
    }
  })();
}

