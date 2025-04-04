import puppeteer from 'puppeteer';
import { ChatMistralAI } from '@langchain/mistralai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { createTools } from './tools.js';
import 'dotenv/config';

(async () => {
  // Launch browser and create a page
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Create tools with the shared page instance
  const tools = createTools(page);

  // Set up the LLM (MistralAI with codestral-latest)
  const llm = new ChatMistralAI({
    model: 'codestral-latest',
    apiKey: process.env.MISTRAL_API_KEY,
  });

  // Enhanced prompt for DuckDuckGo and codestral-latest
  const customPrompt = `
  You are an AI agent that can navigate the internet using a web browser to complete tasks.
  Use these tools:
  - navigate_to_url: Go to a webpage by providing the URL (e.g., "https://duckduckgo.com").
  - type_text: Type text into an input field using its CSS selector (e.g., "input#search_form_input_homepage" for DuckDuckGo's search bar).
  - click_element: Click an element using its CSS selector (e.g., "button#search_button_homepage" for DuckDuckGo's search button).
  - extract_text: Extract text from an element using its CSS selector (e.g., "h2.result__title" for search result titles).

  For each task, follow these exact steps in order:
  1. Navigate to the required webpage using navigate_to_url.
  2. Type the search query into the input field using type_text.
  3. Click the search button using click_element.
  4. Extract the requested information using extract_text.
  5. Return the final result in this format: [FINAL ANSWER: your_result_here].

  Example task: "Go to duckduckgo.com, search for 'cats', and extract the first result title."
  Steps:
  - navigate_to_url: "https://duckduckgo.com"
  - type_text: { selector: "input#search_form_input_homepage", text: "cats" }
  - click_element: "button#search_button_homepage"
  - extract_text: "h2.result__title"
  Response: [FINAL ANSWER: "Cat - Wikipedia"]

  Reason step-by-step. After each tool call, the result will be provided as a user message. Use it to confirm the step completed and proceed to the next step. Do not stop, repeat steps unnecessarily, or output invalid HTML. If a step fails, report it clearly and stop. Continue until you output [FINAL ANSWER: ...]. Use only the selectors provided in this prompt.
  `;

  // Create the ReAct agent with verbose mode
  const agent = createReactAgent({
    llm,
    tools,
    prompt: customPrompt,
    verbose: true,
  });

  // Function to execute the agent until completion
  async function runAgent(task) {
    let messages = [{ role: 'user', content: task }];
    let finalAnswer = null;
    let maxIterations = 10;
    let iteration = 0;
    const executedSteps = new Set(); // Track executed steps to avoid repetition

    while (!finalAnswer && iteration < maxIterations) {
      const result = await agent.invoke({ messages });
      const lastMessage = result.messages.at(-1).content;

      console.log('Intermediate Result:', lastMessage);

      if (lastMessage.includes('[FINAL ANSWER:')) {
        finalAnswer = lastMessage;
        break;
      }

      // Handle tool calls
      try {
        const toolCalls = JSON.parse(lastMessage);
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const toolCall = toolCalls[0];
          const stepKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
          if (executedSteps.has(stepKey)) {
            messages.push({ role: 'user', content: 'Step already executed. Proceed to the next step.' });
          } else {
            const tool = tools.find((t) => t.name === toolCall.name);
            if (tool) {
              const toolResult = await tool.call(toolCall.arguments);
              executedSteps.add(stepKey);
              messages.push({
                role: 'user',
                content: `Step completed: ${toolCall.name} with arguments ${JSON.stringify(toolCall.arguments)}\nResult: ${toolResult}`,
              });
            }
          }
        }
      } catch (e) {
        // Handle invalid responses (e.g., HTML fragments)
        if (lastMessage.includes('</div>')) {
          messages.push({ role: 'user', content: 'Invalid response detected. Please provide a valid tool call or final answer.' });
        } else {
          messages.push({ role: 'assistant', content: lastMessage });
          messages.push({ role: 'user', content: 'Please continue to the next step.' });
        }
      }

      iteration++;
    }

    if (!finalAnswer) {
      throw new Error('Agent failed to complete task within max iterations');
    }

    return finalAnswer;
  }

  // Task for DuckDuckGo
  const task = "Go to duckduckgo.com, search for 'AI agents', and extract the first result title.";
  try {
    const finalResult = await runAgent(task);
    console.log('Final Result:', finalResult);
  } catch (error) {
    console.error('Error running agent:', error);
  }

  // Clean up
  await browser.close();
})();