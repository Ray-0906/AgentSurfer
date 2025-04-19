// utils/llm.js
// Utility to call your LLM (Mistral, OpenAI, etc.)
// Implement this using LangChain, OpenAI SDK, or your LLM provider
import 'dotenv/config';
import fetch from 'node-fetch';

async function callLLM(prompt, llm = 'mistral') {
  // Example: Mistral API
  const apiKey = process.env.MISTRAL_API_KEY;
  const url = 'https://api.mistral.ai/v1/chat/completions';
  const body = {
    model: 'mistral-medium',
    messages: [
      { role: 'system', content: 'You are a helpful assistant that extracts structured information as JSON.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 512
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  // Example: OpenAI/Mistral response shape
  // { choices: [ { message: { content: '...' } } ] }
  if (
    data &&
    Array.isArray(data.choices) &&
    data.choices[0] &&
    data.choices[0].message &&
    typeof data.choices[0].message.content === 'string'
  ) {
    return data.choices[0].message.content.trim();
  } else {
    console.error('[LLM] Unexpected response format:', JSON.stringify(data, null, 2));
    throw new Error('LLM response missing expected content (choices[0].message.content)');
  }
}

export { callLLM };
