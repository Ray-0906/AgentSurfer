import { ChatTogetherAI } from "@langchain/community/chat_models/togetherai";
import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { ChatMistralAI, MistralAI } from "@langchain/mistralai";
import { config } from "dotenv";
import { z } from "zod";
config();



//Tools
async function evalAndCaptureOutput(code) {
  const oldLog = console.log;
  const oldError = console.error;

  const output = [];
  let errorOutput = [];

  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => errorOutput.push(args.join(' '));

  try {
    await eval(code);
  } catch (error) {
    errorOutput.push(error.message);
  }

  console.log = oldLog;
  console.error = oldError;

  return { stdout: output.join('\n'), stderr: errorOutput.join('\n') };
}

const fetchBTCPrice = tool(
  async () => {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    const data = await response.json();
    return { price: data.bitcoin.usd };
  },
  {
    name: "fetch_btc_price",
    description: "Fetches the current price of Bitcoin in USD from a public API",
    schema: z.object({}),
  }
);

const jsExecutor = tool(async ({ code }) => {
 // console.log('Executing code:', code);
  const result = await evalAndCaptureOutput(code);

  return result;
},{
  name: 'run_javascript_code_tool',
    description: `
      Run general purpose javascript code. 
      This can be used to access Internet or do any computation that you need. 
      The output will be composed of the stdout and stderr. 
      It has the following API Keys as environment variables:
      The code should be written in a way that it can be executed with javascript eval in node environment.
   `,
    schema: z.object({
      code: z.string().describe('The code to run'),
    }),

})






//promts
const prompt = `You are a helpful assistant with access to tools for fetching real-time data. For queries about prices (e.g., cryptocurrency, stocks), use available tools to provide accurate, up-to-date information. Respond in a friendly and informative manner.`;

 
//model configs
const model = new ChatMistralAI({
  model: "codestral-latest",
  openAIApiKey: process.env.MISTRAL_API_KEY,
});

const model3 = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-pro",
  temperature: 0.7,
  maxRetries: 2,
});

//memory saver
const checkpointSaver = new MemorySaver();


export const agent = createReactAgent({
  llm: model,
  tools: [jsExecutor,],
 // prompt,
  checkpointSaver,
  //  verbose:true,
})




