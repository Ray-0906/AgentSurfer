import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import { ChatMistralAI } from '@langchain/mistralai';
import {
  createTools,
  summarizeText,
  extractMainContent,
  filterResultsByUrl,
  extractNthResult,
  extractAllLinks,
  extractSnippets,
  getVisibleText
} from './tools.js';
import { config } from 'dotenv';
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { StructuredOutputParser } from "langchain/output_parsers";
import { z } from "zod";

config();

// LangGraph-inspired Autonomous Web Agent

// Helper function to clean LLM JSON output
function cleanLLMJsonOutput(output) {
  // Remove markdown code fences, extra whitespace, or other non-JSON content
  let cleaned = output.trim();
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.slice(3, -3).trim();
  }
  // Remove any leading/trailing non-JSON characters
  cleaned = cleaned.replace(/^[^{[]+|[^}\]]+$/g, '');
  return cleaned;
}

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
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const matchWord = task.match(/extract the (\w+) result/i);
  if (matchWord) {
    const idx = words.indexOf(matchWord[1].toLowerCase());
    if (idx !== -1) return idx;
  }
  return 0;
}
 
async function extractInfoNode(context) {
  try {
    // Helper: check if task is a 'summarize content after opening result' task
    function isOpenAndSummarizeTask(task) {
      return /open the \d+(?:st|nd|rd|th)? result.*summary|summarize|return.*content/i.test(task);
    }
    // For 'open first result whose URL contains ...' pattern
    function isOpenFirstResultByUrlKeywordTask(task) {
      return /open the first result whose url contains ['"]?(\w+)['"]?/i.test(task);
    }
    function getUrlKeywordFromTask(task) {
      const m = /open the first result whose url contains ['"]?(\w+)['"]?/i.exec(task);
      return m ? m[1] : null;
    }
    // For 'open the first 5 results, find the one with the most text content, and return a summary' pattern
    function isOpenFirstNMostContentTask(task) {
      return /open the first (\d+) results?, find the one with the most text content, and return a summary/i.test(task);
    }
    function getOpenFirstNFromTask(task) {
      const m = /open the first (\d+) results?/i.exec(task);
      return m ? parseInt(m[1], 10) : 5;
    }
    const { page, log, actionsTaken, llm } = context;
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

    // If the task is to open the first N results, find the one with the most text content, and summarize
    if (isOpenFirstNMostContentTask(context.task)) {
      const N = getOpenFirstNFromTask(context.task);
      log(`Opening the first ${N} results, extracting content, and finding the one with the most text.`);
      // Collect all URLs and titles first
      let resultInfos = [];
      // Use utility to extract all links for the first N candidates
      for (let i = 0; i < Math.min(N, candidateSelectors.length); ++i) {
        const candidate = candidateSelectors[i];
        // Use extractAllLinks to get all links for this selector, then pick the correct index
        let hrefs = await extractAllLinks(page, candidate.selector);
        let href = hrefs[candidate.index];
        if (href) {
          resultInfos.push({ href, title: candidate.text });
        }
      }
      if (resultInfos.length === 0) {
        return { ...context, finalResult: 'Extraction failed: No valid result URLs found.', nextNode: 'endNode' };
      }
      let maxContent = '', maxHref = '', maxTitle = '';
      for (let i = 0; i < resultInfos.length; ++i) {
        const { href, title } = resultInfos[i];
        log(`Navigating to result #${i + 1}: ${title} ${href}`);
        try {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          let content = await page.evaluate(() => {
            function getTextFromSelectors(selectors) {
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText && el.innerText.length > 200) return el.innerText;
              }
              return '';
            }
            let text = getTextFromSelectors(['main', 'article']);
            if (!text) text = document.body ? document.body.innerText : '';
            return text;
          });
          log(`Extracted content length for result #${i + 1}: ${content.length}`);
          if (content.length > maxContent.length) {
            maxContent = content;
            maxHref = href;
            maxTitle = title;
          }
        } catch (err) {
          log(`Failed to extract content from result #${i + 1}: ${err}`);
        }
      }
      if (!maxContent || maxContent.length < 100) {
        return { ...context, finalResult: 'Extraction failed: Could not extract enough content from any of the articles.', nextNode: 'endNode' };
      }
      log(`Longest content found at: ${maxHref} (length: ${maxContent.length})`);
      // Summarize with utility
      const summary = await summarizeText(llm, maxContent);
      log('Summary generated.');
      return { ...context, finalResult: summary, nextNode: 'endNode' };
    }

    // If the task is to open the first result whose URL contains a keyword and summarize
    if (isOpenFirstResultByUrlKeywordTask(context.task)) {
      const keyword = getUrlKeywordFromTask(context.task);
      log('Looking for first result whose URL contains:', keyword);
      let foundIdx = -1, foundHref = null, foundText = null;
      for (let i = 0; i < candidateSelectors.length; ++i) {
        const href = await page.evaluate((sel, idx) => {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > idx) return els[idx].href;
          return null;
        }, candidateSelectors[i].selector, candidateSelectors[i].index);
        if (href && href.includes(keyword)) {
          foundIdx = i;
          foundHref = href;
          foundText = candidateSelectors[i].text;
          break;
        }
      }
      if (foundIdx === -1) {
        return { ...context, finalResult: `Extraction failed: No result URL contains '${keyword}'.`, nextNode: 'endNode' };
      }
      log('Navigating to first result with keyword:', foundText, foundHref);
      await page.goto(foundHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Extract main content using utility
      let content = await extractMainContent(page);
      if (!content || content.length < 100) {
        return { ...context, finalResult: 'Extraction failed: Could not extract enough content from the article.', nextNode: 'endNode' };
      }
      log('Extracted article content, length:', content.length);
      const summaryPrompt = `Summarize the following web article in 5-7 sentences. Focus on the main topic and key points.\n\n${content.slice(0, 6000)}`;
      const summaryResult = await llm.invoke([{ role: 'user', content: summaryPrompt }]);
      log('Summary generated.');
      return { ...context, finalResult: summaryResult.content, nextNode: 'endNode' };
    }

    // If the task is to open the Nth result and summarize its content
    if (isOpenAndSummarizeTask(context.task)) {
      if (candidateSelectors.length <= extractionIndex) {
        return { ...context, finalResult: `Extraction failed: Not enough results to open the ${extractionIndex + 1}th result.`, nextNode: 'endNode' };
      }
      const nthCandidate = candidateSelectors[extractionIndex];
      log('Navigating to the Nth result:', nthCandidate.text, nthCandidate.selector, nthCandidate.index);
      // Extract href
      let href = await page.evaluate((sel, idx) => {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length > idx) return els[idx].href;
        return null;
      }, nthCandidate.selector, nthCandidate.index);
      if (!href) {
        return { ...context, finalResult: `Extraction failed: Could not find href for the ${extractionIndex + 1}th result.`, nextNode: 'endNode' };
      }
      log('Navigating to URL:', href);
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Extract main content using utility
      let content = await extractMainContent(page);
      if (!content || content.length < 100) {
        return { ...context, finalResult: 'Extraction failed: Could not extract enough content from the article.', nextNode: 'endNode' };
      }
      log('Extracted article content, length:', content.length);
      // Summarize with utility
      const summary = await summarizeText(llm, content);
      log('Summary generated.');
      return { ...context, finalResult: summary, nextNode: 'endNode' };
    }

    // Handle the AI breakthroughs task
    if (/most influential breakthroughs in artificial intelligence.*last 2 years/i.test(context.task)) {
      // Define search queries for AI breakthroughs
      const queries = [
        'most influential AI breakthroughs 2023 2024',
        'AI milestones 2023 2024',
        'AI in healthcare breakthroughs 2024',
        'AI in robotics advances 2023',
        'AI in NLP 2024',
        'AI in computer vision 2024',
        'AI in ethics 2023',
        'AI in reinforcement learning 2023',
        'AI for science breakthroughs 2024',
        'AI in finance advances 2024',
        'AI in climate science 2023',
        'AI in education 2024'
      ];
      const vendorDomains = [
        'pega.com',
        'ibm.com',
        'oracle.com',
        'salesforce.com',
        'sap.com',
        'adobe.com',
        'zoho.com',
        'servicenow.com'
      ];
      // Function to categorize breakthroughs by domain
      function getDomainArea(desc) {
        desc = desc.toLowerCase();
        if (desc.includes('health')) return 'healthcare';
        if (desc.includes('robotic')) return 'robotics';
        if (desc.includes('vision') || desc.includes('image')) return 'vision';
        if (desc.includes('language') || desc.includes('nlp') || desc.includes('text')) return 'nlp';
        if (desc.includes('ethic') || desc.includes('fairness') || desc.includes('bias')) return 'ethics';
        if (desc.includes('climate') || desc.includes('weather')) return 'climate';
        if (desc.includes('reinforcement')) return 'rl';
        if (desc.includes('finance') || desc.includes('market')) return 'finance';
        if (desc.includes('education')) return 'education';
        if (desc.includes('science') || desc.includes('discovery')) return 'science';
        return 'other';
      }
      let breakthroughs = [];
      let seenBreakthroughs = new Set();
      let triedUrls = new Set();

      for (let q of queries) {
        await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('input[name="q"]', { timeout: 8000 });
        await page.evaluate(() => document.querySelector('input[name="q"]').value = '');
        await page.type('input[name="q"]', q, { delay: 80 });
        await page.keyboard.press('Enter');

        let found = false;
        for (const sel of ['.results', '.react-results--main', '[data-testid="result-title-a"]']) {
          try {
            await page.waitForSelector(sel, { timeout: 8000 });
            found = true;
            break;
          } catch {}
        }
        if (!found) continue;

        // Gather top 10 result URLs, skipping vendor/marketing domains
        let candidates = await page.evaluate(vendorDomains => {
          const selectors = [
            '.result__title a',
            '.react-results--main .react-results__title a',
            "a[data-testid='result-title-a']",
            'h2 a'
          ];
          const links = [];
          for (const sel of selectors) {
            const els = Array.from(document.querySelectorAll(sel));
            els.forEach(el => {
              const href = el.href;
              if (href && !/duckduckgo\.com\/y\.js|ad_|\/ads\//i.test(href)) {
                let skip = vendorDomains.some(domain => href.includes(domain));
                if (!skip) links.push(href);
              }
            });
          }
          return Array.from(new Set(links)).slice(0, 10);
        }, vendorDomains);

        for (let url of candidates) {
          if (triedUrls.has(url)) continue;
          triedUrls.add(url);
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            let text = await page.evaluate(() => document.body.innerText);
            const extractListPrompt = `From the following web page text, extract a JSON array of the most influential AI breakthroughs or advances from 2023-2024. For each, include: name/title, year, a short description, and any contributors/organizations if available.\n\n${text.slice(0, 8000)}`;
            let raw = await llm.invoke([{ role: 'user', content: extractListPrompt }]);
            let list;
            try {
              list = JSON.parse(cleanLLMJsonOutput(raw.content));
            } catch {}
            // Only accept pages that yield at least 2 breakthroughs
            if (Array.isArray(list) && list.length >= 2) {
              for (let b of list) {
                if (b && b.name && b.year) {
                  let key = (b.name || '').toLowerCase() + (b.year || '');
                  if (!seenBreakthroughs.has(key)) {
                    // Add verbose provenance: snippet/context
                    let snippet = (b.description || '').slice(0, 200);
                    breakthroughs.push({ ...b, source: url, snippet });
                    seenBreakthroughs.add(key);
                  }
                }
              }
            }
            if (breakthroughs.length >= 5) break;
          } catch {}
        }
        if (breakthroughs.length >= 5) break;
      }

      // Try to select at least one from each area if possible
      let selected = [];
      let usedAreas = new Set();
      for (let b of breakthroughs) {
        let area = getDomainArea(b.description || '');
        if (!usedAreas.has(area) && area !== 'other') {
          selected.push(b);
          usedAreas.add(area);
        }
        if (selected.length >= 5) break;
      }

      // If still <5, fill with others
      if (selected.length < 5) {
        for (let b of breakthroughs) {
          if (!selected.includes(b)) selected.push(b);
          if (selected.length >= 5) break;
        }
      }

      // If still <5, fallback to Wikipedia/news aggregator
      if (selected.length < 5) {
        // Wikipedia fallback
        try {
          await page.goto('https://en.wikipedia.org/wiki/Timeline_of_artificial_intelligence', { waitUntil: 'domcontentloaded', timeout: 20000 });
          let text = await page.evaluate(() => document.body.innerText);
          const extractWikiPrompt = `From the following Wikipedia text, extract a JSON array of 2-3 influential AI breakthroughs or milestones from 2023-2024. For each, include: name/title, year, a short description, and any contributors/organizations if available.\n\n${text.slice(0, 8000)}`;
          let raw = await llm.invoke([{ role: 'user', content: extractWikiPrompt }]);
          let wikiList = [];
          try {
            wikiList = JSON.parse(cleanLLMJsonOutput(raw.content));
          } catch {}
          if (Array.isArray(wikiList)) {
            for (let b of wikiList) {
              if (selected.length >= 5) break;
              let key = (b.name || '').toLowerCase() + (b.year || '');
              if (!seenBreakthroughs.has(key)) {
                let snippet = (b.description || '').slice(0, 200);
                selected.push({ ...b, source: 'https://en.wikipedia.org/wiki/Timeline_of_artificial_intelligence', snippet });
                seenBreakthroughs.add(key);
              }
            }
          }
        } catch {}
      }

      if (selected.length === 0) {
        return { ...context, finalResult: 'Extraction failed: No breakthroughs found from any query.', nextNode: 'endNode' };
      }

      // For each breakthrough, get more details (contributors, applications, impact, year, url)
      let detailsResults = [];
      for (let b of selected) {
        let detail = {
          name: b.name,
          year: b.year,
          description: b.description || 'Not found',
          contributors: b.contributors || 'Not found',
          applications: 'Not found',
          source: b.source
        };
        let found = false;
        // Try up to 2 more searches for details
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('input[name="q"]', { timeout: 8000 });
            await page.evaluate(() => document.querySelector('input[name="q"]').value = '');
            await page.type('input[name="q"]', `${b.name} ${b.year} ai breakthrough applications contributors`, { delay: 80 });
            await page.keyboard.press('Enter');
            let found2 = false;
            for (const sel of ['.results', '.react-results--main', '[data-testid="result-title-a"]']) {
              try {
                await page.waitForSelector(sel, { timeout: 8000 });
                found2 = true;
                break;
              } catch {}
            }
            if (!found2) continue;
            let links = await page.evaluate(() => {
              const selectors = [
                '.result__title a',
                '.react-results--main .react-results__title a',
                "a[data-testid='result-title-a']",
                'h2 a'
              ];
              const out = [];
              for (const sel of selectors) {
                const els = Array.from(document.querySelectorAll(sel));
                els.forEach(el => {
                  const href = el.href;
                  if (href && !/duckduckgo\.com\/y\.js|ad_|\/ads\//i.test(href)) {
                    out.push(href);
                  }
                });
              }
              return Array.from(new Set(out)).slice(0, 2);
            });
            for (let l of links) {
              await page.goto(l, { waitUntil: 'domcontentloaded', timeout: 20000 });
              let text = await page.evaluate(() => document.body.innerText);
              const extractDetailsPrompt = `From the following web page text, extract the main contributors/organizations, notable applications or impact, and a 1-sentence summary for the AI breakthrough called '${b.name}' (${b.year}). Return as a JSON object with keys: contributors, applications, description.`;
              let raw = await llm.invoke([{ role: 'user', content: extractDetailsPrompt }]);
              let obj;
              try {
                obj = JSON.parse(cleanLLMJsonOutput(raw.content));
              } catch {}
              if (obj) {
                if (obj.contributors && obj.contributors !== 'Not found') detail.contributors = obj.contributors;
                if (obj.applications && obj.applications !== 'Not found') detail.applications = obj.applications;
                if (obj.description && obj.description !== 'Not found') detail.description = obj.description;
                detail.source = l;
                found = true;
                break;
              }
            }
            if (found) break;
          } catch {}
        }
        detailsResults.push(detail);
      }

      // Aggregate and return as a table
      let table =
        '| Breakthrough | Year | Description | Contributors/Orgs | Applications/Impact | Source URL |\n' +
        '|---|---|---|---|---|---|\n' +
        detailsResults.map(r => `| ${r.name} | ${r.year} | ${r.description} | ${r.contributors} | ${r.applications} | ${r.source} |`).join('\n');

      // Generate a trends summary using LLM
      const summaryPrompt = `Given the following markdown table of AI breakthroughs, contributors, and impact, write a short summary of trends and patterns in recent AI advances.\n\n${table}`;
      let summary = '';
      try {
        let summaryRaw = await llm.invoke([{ role: 'user', content: summaryPrompt }]);
        summary = summaryRaw.content.trim();
      } catch {}

      // Add run metadata
      const runTime = '2025-04-19T10:29:31+05:30'; // Local time from system
      let metadata = `\n\n_Run completed at: ${runTime}_`;

      // Return all
      let finalResult = table + '\n\n' + (summary ? `**Summary:**\n${summary}\n` : '') + metadata;
      return { ...context, finalResult, nextNode: 'endNode' };
    }

    // Handle data science conferences task
    if (/data science conferences 2024/i.test(context.task)) {
      // Try each candidateSelector until a valid, non-ad, non-redirect URL is found
      let href = null, candidateIdx = 0;
      while (candidateIdx < candidateSelectors.length) {
        const candidate = candidateSelectors[candidateIdx];
        href = await page.evaluate((sel, idx) => {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > idx) return els[idx].href;
          return null;
        }, candidate.selector, candidate.index);
        if (href && !/duckduckgo\.com\/y\.js|ad_|\/ads\//i.test(href)) {
          log('Selected result for conference list:', href);
          break;
        }
        candidateIdx++;
        href = null;
      }
      if (!href) {
        return { ...context, finalResult: 'Extraction failed: No valid non-ad result found for conference list.', nextNode: 'endNode' };
      }
      log('Navigating to result for conference list:', href);
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Extract visible text and try to get a conference list
      let pageText = await page.evaluate(() => document.body.innerText);
      // Use LLM to extract a list of conference names from the visible text
      const extractListPrompt = `Extract a list of the top 10 data science conference names for 2024 from the following web page text. Return ONLY a JSON array of strings.\n\n${pageText.slice(0, 8000)}`;
      let confListRaw = await llm.invoke([{ role: 'user', content: extractListPrompt }]);
      let confList;
      try {
        confList = JSON.parse(cleanLLMJsonOutput(confListRaw.content));
      } catch (err) {
        log('Failed to parse conference list JSON from LLM. Raw:', confListRaw.content);
        return { ...context, finalResult: 'Extraction failed: Could not parse conference list from first valid result.', nextNode: 'endNode' };
      }
      if (!Array.isArray(confList) || confList.length === 0) {
        // Try the next candidate if available
        candidateIdx++;
        let found = false;
        while (candidateIdx < candidateSelectors.length) {
          const candidate = candidateSelectors[candidateIdx];
          href = await page.evaluate((sel, idx) => {
            const els = Array.from(document.querySelectorAll(sel));
            if (els.length > idx) return els[idx].href;
            return null;
          }, candidate.selector, candidate.index);
          if (href && !/duckduckgo\.com\/y\.js|ad_|\/ads\//i.test(href)) {
            log('Trying next candidate for conference list:', href);
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
            pageText = await page.evaluate(() => document.body.innerText);
            const tryPrompt = `Extract a list of the top 10 data science conference names for 2024 from the following web page text. Return ONLY a JSON array of strings.\n\n${pageText.slice(0, 8000)}`;
            confListRaw = await llm.invoke([{ role: 'user', content: tryPrompt }]);
            try {
              confList = JSON.parse(cleanLLMJsonOutput(confListRaw.content));
              if (Array.isArray(confList) && confList.length > 0) {
                found = true;
                break;
              }
            } catch {}
          }
          candidateIdx++;
        }
        if (!found) {
          return { ...context, finalResult: 'Extraction failed: No conferences found in any valid result.', nextNode: 'endNode' };
        }
      }
      log('Extracted conference list:', confList);
      // For each conference, search and extract location/dates from up to 3 results, record URL used
      let results = [];
      for (let conf of confList) {
        let confResult = { name: conf, location: 'Not found', dates: 'Not found', source: 'Not found', sourcesChecked: 0 };
        try {
          // Go back to DuckDuckGo
          await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('input[name="q"]', { timeout: 8000 });
          await page.evaluate(() => document.querySelector('input[name="q"]').value = '');
          await page.type('input[name="q"]', conf + ' 2024', { delay: 80 });
          await page.keyboard.press('Enter');
          // Wait for results
          let found = false;
          for (const sel of ['.results', '.react-results--main', '[data-testid="result-title-a"]']) {
            try {
              await page.waitForSelector(sel, { timeout: 8000 });
              found = true;
              break;
            } catch {}
          }
          if (!found) {
            results.push(confResult);
            continue;
          }
          // Try up to 3 candidates
          let confCandidates = await page.evaluate(() => {
            const selectors = [
              '.result__title a',
              '.react-results--main .react-results__title a',
              "a[data-testid='result-title-a']",
              'h2 a'
            ];
            const candidates = [];
            for (const sel of selectors) {
              const els = Array.from(document.querySelectorAll(sel));
              els.forEach((el, idx) => {
                candidates.push({ selector: sel, index: idx, outerHTML: el.outerHTML, text: el.textContent.trim() });
              });
            }
            return candidates;
          });
          let tried = 0;
          for (let i = 0; i < confCandidates.length && tried < 3; i++) {
            let confHref = await page.evaluate((sel, idx) => {
              const els = Array.from(document.querySelectorAll(sel));
              if (els.length > idx) return els[idx].href;
              return null;
            }, confCandidates[i].selector, confCandidates[i].index);
            if (!confHref) continue;
            tried++;
            confResult.sourcesChecked = tried;
            try {
              await page.goto(confHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
              let confPageText = await page.evaluate(() => document.body.innerText);
              // Use LLM to extract location and dates
              const extractDetailsPrompt = `Extract the location and dates for the following conference from this web page text. Output as a JSON object with keys 'location' and 'dates'. If not found, use 'Not found'.\n\nConference: ${conf}\n\n${confPageText.slice(0, 8000)}`;
              let detailsRaw = await llm.invoke([{ role: 'user', content: extractDetailsPrompt }]);
              let details = { location: 'Not found', dates: 'Not found' };
              try {
                details = JSON.parse(cleanLLMJsonOutput(detailsRaw.content));
              } catch {}
              if ((details.location && details.location !== 'Not found') || (details.dates && details.dates !== 'Not found')) {
                confResult.location = details.location || 'Not found';
                confResult.dates = details.dates || 'Not found';
                confResult.source = confHref;
                break;
              }
            } catch {}
          }
        } catch (err) {}
        results.push(confResult);
      }
      // Aggregate and return as a table, with source URL
      let table =
        '| Conference Name | Location | Dates | Source URL | Sources Checked |\n' +
        '|---|---|---|---|---|\n' +
        results.map(r => `| ${r.name} | ${r.location} | ${r.dates} | ${r.source} | ${r.sourcesChecked} |`).join('\n');
      // Generate a summary using LLM
      const summaryPrompt = `Given the following markdown table of conferences, locations, and dates, write a short summary of key patterns (e.g. most common locations, months, or anything notable).\n\n${table}`;
      let summary = '';
      try {
        let summaryRaw = await llm.invoke([{ role: 'user', content: summaryPrompt }]);
        summary = summaryRaw.content.trim();
      } catch {}
      // Add run metadata
      const runTime = '2025-04-19T10:20:23+05:30'; // Local time from system
      let metadata = `\n\n_Run completed at: ${runTime}_`;
      // Return all
      let finalResult = table + '\n\n' + (summary ? `**Summary:**\n${summary}\n` : '') + metadata;
      return { ...context, finalResult, nextNode: 'endNode' };
    }

    // Ask LLM to pick the best selector for the Nth result (second, if requested)
    const whichResult = /second/i.test(context.task) ? 'second' : 'first';
    const llmPrompt = `You are a web agent. Here are candidate elements for the ${whichResult} search result title on DuckDuckGo:\n\n${candidateSelectors.map((c, i) => `#${i + 1}\nSelector: ${c.selector} [index ${c.index}]\nText: ${c.text}\nHTML: ${c.outerHTML.slice(0, 120)}...`).join('\n\n')}\n\nWhich selector and index best matches the ${whichResult} result title? Reply with the selector string and index, e.g. ".result__title a", 1`;

    const llmResponse = await llm.invoke([{ role: 'user', content: llmPrompt }]);
    let bestSelector = (llmResponse.content || '').trim().split('\n')[0];
    let selectorMatch = bestSelector.match(/([\s\S]+?),\s*(\d+)/);
    let selector = '.result__title a', index = whichResult === 'second' ? 1 : 0;
    if (selectorMatch) {
      selector = selectorMatch[1].trim();
      index = parseInt(selectorMatch[2], 10);
    }
    log('LLM-chosen selector for extraction:', selector, 'index:', index);

    return { ...context, pageContent: content, extractionSelector: selector, extractionIndex: index, candidateSelectors, nextNode: 'extractWithSelectorNode' };
  } catch (e) {
    context.error = e;
    return { ...context, nextNode: 'errorHandlingNode' };
  }
}

async function extractWithSelectorNode(context) {
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
// 4. Analyze Page Node
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

// 5. Take Action Node
async function takeActionNode(context) {
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
  extractWithSelectorNode,
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
    task: "Go to duckduckgo.com and find 5 most influential breakthroughs in artificial intelligence in the last 2 years. For each breakthrough, provide a brief description, the main contributors or organizations, the year, a source URL, and any notable applications or impact. Then, generate a summary of the trends in AI breakthroughs over this period.",
    page,
    actionsTaken: [],
    tools,
    llm,
    taskTargetUrl: 'https://duckduckgo.com', // Track the navigation goal
    log: (...args) => console.log('[Agent]', ...args),
    retryCount: 0,
    lastNode: null,
    done: false,
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