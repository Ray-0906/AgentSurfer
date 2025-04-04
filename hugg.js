import { HuggingFaceInference } from "@langchain/community/llms/hf";
import { config } from "dotenv";
config();
const model =new HuggingFaceInference({
    model:"gpt-2",
    maxNewTokens:1000,
    temperature:0.2,
      maxRetries: 2,       
})

const res=await model.invoke("what is the capital of France?")
console.log(res);