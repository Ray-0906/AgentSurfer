import { ChatTogetherAI } from "@langchain/community/chat_models/togetherai";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { config } from "dotenv";
import { z } from "zod";

config();

// Define the tool
const getWeather = tool(
  async ({ query }) => {
    return `The weather in ${query} is sunny`;
  },
  {
    name: "weather",
    description: "Get the weather for a given location",
    schema: z.object({
      query: z.string().describe("The location to get the weather for"),
    }),
  }
);

// Initialize the model
const model = new ChatTogetherAI({
  model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
  apiKey: process.env.TOGETHER_AI_KEY,
});

// Create the agent
const agent = createReactAgent({
  llm: model,
  tools: [getWeather],
  verbose: true,
});

// Function to process the conversation
async function runAgent() {
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: "What is the weather in Tokyo?",
      },
    ],
  });

  // Process the result to generate a user-facing response
  const toolMessage = result.messages[1];
  console.log(toolMessage);
}

runAgent();
