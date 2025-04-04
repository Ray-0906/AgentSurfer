
import { PromptTemplate } from "@langchain/core/prompts";
import { MistralAI, MistralAIEmbeddings } from "@langchain/mistralai";
import { config } from "dotenv";
config();

const embModel=new MistralAIEmbeddings({
    model: "mistral-embed",
    openAIApiKey:process.env.MISTRAL_API_KEY,        
});

const llm=new MistralAI({
    model: "codestral-latest",
    temperature:0.2,
    maxTokens:1000,
    maxRetries: 2,
    openAIApiKey:process.env.MISTRAL_API_KEY,        
});

const title="Calisthenics Training";
const days=7;
const prompt = PromptTemplate.fromTemplate("Generate 3-4 quests for a mission titled '{title}', lasting {days} days. Provide structured JSON with title, description, and reward_xp");

const chain =prompt.pipe(llm);

// const ppm = await chain.invoke({title,days});
// console.log(ppm);
const res=await embModel.embedQuery("what is the capital of France?")
console.log(res);
 // const response = await llm.invoke(prompt);
//console.log(response);