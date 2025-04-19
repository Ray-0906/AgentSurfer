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
  // Remove code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?|```$/g, '').trim();
  }
  // Find the first { or [ and last } or ]
  const firstBrace = Math.min(
    ...['{', '['].map(c => cleaned.indexOf(c)).filter(i => i !== -1)
  );
  const lastBrace = Math.max(
    ...['}', ']'].map(c => cleaned.lastIndexOf(c))
  );
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

// ---- NODE DEFINITIONS ---- //
// Each node is a modular async function. The workflow controller manages transitions.

import { startNode } from './nodes/startNode.js';
import { planNode } from './nodes/planNode.js';
import { extractQueryFromTask } from './nodes/extractQueryFromTask.js';
import { extractIndexFromTask } from './nodes/extractIndexFromTask.js';
import { extractInfoNode } from './nodes/extractInfoNode.js';
import { extractWithSelectorNode } from './nodes/extractWithSelectorNode.js';
import { analyzePageNode } from './nodes/analyzePageNode.js';
import { takeActionNode } from './nodes/takeActionNode.js';
import { errorHandlingNode } from './nodes/errorHandlingNode.js';
import { checkCompletionNode } from './nodes/checkCompletionNode.js';
import { endNode } from './nodes/endNode.js';

// (Node function implementations have been moved to their own files in nodes/)



// 7. Check Completion Node

// 8. End Node

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
  while (currentNode) {
    context.lastNode = currentNode;
    const nodeFn = nodeMap[currentNode];
    if (!nodeFn) {
      console.log('[Agent] Workflow complete or unknown node:', currentNode);
      break;
    }
    const result = await nodeFn(context);
    Object.assign(context, result); // Update context with new state
    // If the node signals finish, stop gracefully
    if (!('nextNode' in context) || context.nextNode === null || context.nextNode === undefined) {
      console.log('\n[Agent] Final Result:', context.finalResult || context);
      break;
    }
    if (context.steps && context.steps.some(s => s.action === 'finish')) {
      console.log('\n[Agent] Final Result:', context.finalResult || context);
      break;
    }
    currentNode = context.nextNode;
  }

  await browser.close();
})();