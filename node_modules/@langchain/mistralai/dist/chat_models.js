import { v4 as uuidv4 } from "uuid";
import { Mistral as MistralClient } from "@mistralai/mistralai";
import { HTTPClient as MistralAIHTTPClient, } from "@mistralai/mistralai/lib/http.js";
import { AIMessage, HumanMessage, HumanMessageChunk, AIMessageChunk, ToolMessageChunk, ChatMessageChunk, FunctionMessageChunk, isAIMessage, } from "@langchain/core/messages";
import { BaseChatModel, } from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, } from "@langchain/core/outputs";
import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { JsonOutputParser, StructuredOutputParser, } from "@langchain/core/output_parsers";
import { JsonOutputKeyToolsParser, convertLangChainToolCallToOpenAI, makeInvalidToolCall, parseToolCall, } from "@langchain/core/output_parsers/openai_tools";
import { RunnablePassthrough, RunnableSequence, } from "@langchain/core/runnables";
import { zodToJsonSchema } from "zod-to-json-schema";
import { _convertToolCallIdToMistralCompatible, _mistralContentChunkToMessageContentComplex, } from "./utils.js";
function convertMessagesToMistralMessages(messages) {
    const getRole = (role) => {
        switch (role) {
            case "human":
                return "user";
            case "ai":
                return "assistant";
            case "system":
                return "system";
            case "tool":
                return "tool";
            case "function":
                return "assistant";
            default:
                throw new Error(`Unknown message type: ${role}`);
        }
    };
    const getContent = (content, type) => {
        const _generateContentChunk = (complex, role) => {
            if (complex.type === "image_url" &&
                (role === "user" || role === "assistant")) {
                return {
                    type: complex.type,
                    imageUrl: complex?.image_url,
                };
            }
            if (complex.type === "text") {
                return {
                    type: complex.type,
                    text: complex?.text,
                };
            }
            throw new Error(`ChatMistralAI only supports messages of "image_url" for roles "user" and "assistant", and "text" for all others.\n\nReceived: ${JSON.stringify(content, null, 2)}`);
        };
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            const mistralRole = getRole(type);
            // Mistral "assistant" and "user" roles can support Mistral ContentChunks
            // Mistral "system" role can support Mistral TextChunks
            const newContent = [];
            content.forEach((messageContentComplex) => {
                // Mistral content chunks only support type "text" and "image_url"
                if (messageContentComplex.type === "text" ||
                    messageContentComplex.type === "image_url") {
                    newContent.push(_generateContentChunk(messageContentComplex, mistralRole));
                }
                else {
                    throw new Error(`Mistral only supports types "text" or "image_url" for complex message types.`);
                }
            });
            return newContent;
        }
        throw new Error(`Message content must be a string or an array.\n\nReceived: ${JSON.stringify(content, null, 2)}`);
    };
    const getTools = (message) => {
        if (isAIMessage(message) && !!message.tool_calls?.length) {
            return message.tool_calls
                .map((toolCall) => ({
                ...toolCall,
                id: _convertToolCallIdToMistralCompatible(toolCall.id ?? ""),
            }))
                .map(convertLangChainToolCallToOpenAI);
        }
        return undefined;
    };
    return messages.map((message) => {
        const toolCalls = getTools(message);
        const content = getContent(message.content, message.getType());
        if ("tool_call_id" in message && typeof message.tool_call_id === "string") {
            return {
                role: getRole(message.getType()),
                content,
                name: message.name,
                toolCallId: _convertToolCallIdToMistralCompatible(message.tool_call_id),
            };
            // Mistral "assistant" role can only support either content or tool calls but not both
        }
        else if (isAIMessage(message)) {
            if (toolCalls === undefined) {
                return {
                    role: getRole(message.getType()),
                    content,
                };
            }
            else {
                return {
                    role: getRole(message.getType()),
                    toolCalls,
                };
            }
        }
        return {
            role: getRole(message.getType()),
            content,
        };
    });
}
function mistralAIResponseToChatMessage(choice, usage) {
    const { message } = choice;
    if (message === undefined) {
        throw new Error("No message found in response");
    }
    // MistralAI SDK does not include toolCalls in the non
    // streaming return type, so we need to extract it like this
    // to satisfy typescript.
    let rawToolCalls = [];
    if ("toolCalls" in message && Array.isArray(message.toolCalls)) {
        rawToolCalls = message.toolCalls;
    }
    const content = _mistralContentChunkToMessageContentComplex(message.content);
    switch (message.role) {
        case "assistant": {
            const toolCalls = [];
            const invalidToolCalls = [];
            for (const rawToolCall of rawToolCalls) {
                try {
                    const parsed = parseToolCall(rawToolCall, { returnId: true });
                    toolCalls.push({
                        ...parsed,
                        id: parsed.id ?? uuidv4().replace(/-/g, ""),
                    });
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }
                catch (e) {
                    invalidToolCalls.push(makeInvalidToolCall(rawToolCall, e.message));
                }
            }
            return new AIMessage({
                content,
                tool_calls: toolCalls,
                invalid_tool_calls: invalidToolCalls,
                additional_kwargs: {},
                usage_metadata: usage
                    ? {
                        input_tokens: usage.promptTokens,
                        output_tokens: usage.completionTokens,
                        total_tokens: usage.totalTokens,
                    }
                    : undefined,
            });
        }
        default:
            return new HumanMessage({ content });
    }
}
function _convertDeltaToMessageChunk(delta, usage) {
    if (!delta.content && !delta.toolCalls) {
        if (usage) {
            return new AIMessageChunk({
                content: "",
                usage_metadata: usage
                    ? {
                        input_tokens: usage.promptTokens,
                        output_tokens: usage.completionTokens,
                        total_tokens: usage.totalTokens,
                    }
                    : undefined,
            });
        }
        return null;
    }
    // Our merge additional kwargs util function will throw unless there
    // is an index key in each tool object (as seen in OpenAI's) so we
    // need to insert it here.
    const rawToolCallChunksWithIndex = delta.toolCalls?.length
        ? delta.toolCalls?.map((toolCall, index) => ({
            ...toolCall,
            index,
            id: toolCall.id ?? uuidv4().replace(/-/g, ""),
            type: "function",
        }))
        : undefined;
    let role = "assistant";
    if (delta.role) {
        role = delta.role;
    }
    const content = _mistralContentChunkToMessageContentComplex(delta.content);
    let additional_kwargs;
    const toolCallChunks = [];
    if (rawToolCallChunksWithIndex !== undefined) {
        for (const rawToolCallChunk of rawToolCallChunksWithIndex) {
            const rawArgs = rawToolCallChunk.function?.arguments;
            const args = rawArgs === undefined || typeof rawArgs === "string"
                ? rawArgs
                : JSON.stringify(rawArgs);
            toolCallChunks.push({
                name: rawToolCallChunk.function?.name,
                args,
                id: rawToolCallChunk.id,
                index: rawToolCallChunk.index,
                type: "tool_call_chunk",
            });
        }
    }
    else {
        additional_kwargs = {};
    }
    if (role === "user") {
        return new HumanMessageChunk({ content });
    }
    else if (role === "assistant") {
        return new AIMessageChunk({
            content,
            tool_call_chunks: toolCallChunks,
            additional_kwargs,
            usage_metadata: usage
                ? {
                    input_tokens: usage.promptTokens,
                    output_tokens: usage.completionTokens,
                    total_tokens: usage.totalTokens,
                }
                : undefined,
        });
    }
    else if (role === "tool") {
        return new ToolMessageChunk({
            content,
            additional_kwargs,
            tool_call_id: rawToolCallChunksWithIndex?.[0].id ?? "",
        });
    }
    else if (role === "function") {
        return new FunctionMessageChunk({
            content,
            additional_kwargs,
        });
    }
    else {
        return new ChatMessageChunk({ content, role });
    }
}
function _convertToolToMistralTool(tools) {
    return tools.map((tool) => {
        if ("function" in tool) {
            return tool;
        }
        const description = tool.description ?? `Tool: ${tool.name}`;
        return {
            type: "function",
            function: {
                name: tool.name,
                description,
                parameters: zodToJsonSchema(tool.schema),
            },
        };
    });
}
/**
 * Mistral AI chat model integration.
 *
 * Setup:
 * Install `@langchain/mistralai` and set an environment variable named `MISTRAL_API_KEY`.
 *
 * ```bash
 * npm install @langchain/mistralai
 * export MISTRAL_API_KEY="your-api-key"
 * ```
 *
 * ## [Constructor args](https://api.js.langchain.com/classes/_langchain_mistralai.ChatMistralAI.html#constructor)
 *
 * ## [Runtime args](https://api.js.langchain.com/interfaces/_langchain_mistralai.ChatMistralAICallOptions.html)
 *
 * Runtime args can be passed as the second argument to any of the base runnable methods `.invoke`. `.stream`, `.batch`, etc.
 * They can also be passed via `.bind`, or the second arg in `.bindTools`, like shown in the examples below:
 *
 * ```typescript
 * // When calling `.bind`, call options should be passed via the first argument
 * const llmWithArgsBound = llm.bind({
 *   stop: ["\n"],
 *   tools: [...],
 * });
 *
 * // When calling `.bindTools`, call options should be passed via the second argument
 * const llmWithTools = llm.bindTools(
 *   [...],
 *   {
 *     tool_choice: "auto",
 *   }
 * );
 * ```
 *
 * ## Examples
 *
 * <details open>
 * <summary><strong>Instantiate</strong></summary>
 *
 * ```typescript
 * import { ChatMistralAI } from '@langchain/mistralai';
 *
 * const llm = new ChatMistralAI({
 *   model: "mistral-large-2402",
 *   temperature: 0,
 *   // other params...
 * });
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Invoking</strong></summary>
 *
 * ```typescript
 * const input = `Translate "I love programming" into French.`;
 *
 * // Models also accept a list of chat messages or a formatted prompt
 * const result = await llm.invoke(input);
 * console.log(result);
 * ```
 *
 * ```txt
 * AIMessage {
 *   "content": "The translation of \"I love programming\" into French is \"J'aime la programmation\". Here's the breakdown:\n\n- \"I\" translates to \"Je\"\n- \"love\" translates to \"aime\"\n- \"programming\" translates to \"la programmation\"\n\nSo, \"J'aime la programmation\" means \"I love programming\" in French.",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "tokenUsage": {
 *       "completionTokens": 89,
 *       "promptTokens": 13,
 *       "totalTokens": 102
 *     },
 *     "finish_reason": "stop"
 *   },
 *   "tool_calls": [],
 *   "invalid_tool_calls": [],
 *   "usage_metadata": {
 *     "input_tokens": 13,
 *     "output_tokens": 89,
 *     "total_tokens": 102
 *   }
 * }
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Streaming Chunks</strong></summary>
 *
 * ```typescript
 * for await (const chunk of await llm.stream(input)) {
 *   console.log(chunk);
 * }
 * ```
 *
 * ```txt
 * AIMessageChunk {
 *   "content": "The",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": " translation",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": " of",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": " \"",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": "I",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *  "content": ".",
 *  "additional_kwargs": {},
 *  "response_metadata": {
 *    "prompt": 0,
 *    "completion": 0
 *  },
 *  "tool_calls": [],
 *  "tool_call_chunks": [],
 *  "invalid_tool_calls": []
 *}
 *AIMessageChunk {
 *  "content": "",
 *  "additional_kwargs": {},
 *  "response_metadata": {
 *    "prompt": 0,
 *    "completion": 0
 *  },
 *  "tool_calls": [],
 *  "tool_call_chunks": [],
 *  "invalid_tool_calls": [],
 *  "usage_metadata": {
 *    "input_tokens": 13,
 *    "output_tokens": 89,
 *    "total_tokens": 102
 *  }
 *}
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Aggregate Streamed Chunks</strong></summary>
 *
 * ```typescript
 * import { AIMessageChunk } from '@langchain/core/messages';
 * import { concat } from '@langchain/core/utils/stream';
 *
 * const stream = await llm.stream(input);
 * let full: AIMessageChunk | undefined;
 * for await (const chunk of stream) {
 *   full = !full ? chunk : concat(full, chunk);
 * }
 * console.log(full);
 * ```
 *
 * ```txt
 * AIMessageChunk {
 *   "content": "The translation of \"I love programming\" into French is \"J'aime la programmation\". Here's the breakdown:\n\n- \"I\" translates to \"Je\"\n- \"love\" translates to \"aime\"\n- \"programming\" translates to \"la programmation\"\n\nSo, \"J'aime la programmation\" means \"I love programming\" in French.",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": [],
 *   "usage_metadata": {
 *     "input_tokens": 13,
 *     "output_tokens": 89,
 *     "total_tokens": 102
 *   }
 * }
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Bind tools</strong></summary>
 *
 * ```typescript
 * import { z } from 'zod';
 *
 * const GetWeather = {
 *   name: "GetWeather",
 *   description: "Get the current weather in a given location",
 *   schema: z.object({
 *     location: z.string().describe("The city and state, e.g. San Francisco, CA")
 *   }),
 * }
 *
 * const GetPopulation = {
 *   name: "GetPopulation",
 *   description: "Get the current population in a given location",
 *   schema: z.object({
 *     location: z.string().describe("The city and state, e.g. San Francisco, CA")
 *   }),
 * }
 *
 * const llmWithTools = llm.bindTools([GetWeather, GetPopulation]);
 * const aiMsg = await llmWithTools.invoke(
 *   "Which city is hotter today and which is bigger: LA or NY?"
 * );
 * console.log(aiMsg.tool_calls);
 * ```
 *
 * ```txt
 * [
 *   {
 *     name: 'GetWeather',
 *     args: { location: 'Los Angeles, CA' },
 *     type: 'tool_call',
 *     id: '47i216yko'
 *   },
 *   {
 *     name: 'GetWeather',
 *     args: { location: 'New York, NY' },
 *     type: 'tool_call',
 *     id: 'nb3v8Fpcn'
 *   },
 *   {
 *     name: 'GetPopulation',
 *     args: { location: 'Los Angeles, CA' },
 *     type: 'tool_call',
 *     id: 'EedWzByIB'
 *   },
 *   {
 *     name: 'GetPopulation',
 *     args: { location: 'New York, NY' },
 *     type: 'tool_call',
 *     id: 'jLdLia7zC'
 *   }
 * ]
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Structured Output</strong></summary>
 *
 * ```typescript
 * import { z } from 'zod';
 *
 * const Joke = z.object({
 *   setup: z.string().describe("The setup of the joke"),
 *   punchline: z.string().describe("The punchline to the joke"),
 *   rating: z.number().optional().describe("How funny the joke is, from 1 to 10")
 * }).describe('Joke to tell user.');
 *
 * const structuredLlm = llm.withStructuredOutput(Joke, { name: "Joke" });
 * const jokeResult = await structuredLlm.invoke("Tell me a joke about cats");
 * console.log(jokeResult);
 * ```
 *
 * ```txt
 * {
 *   setup: "Why don't cats play poker in the jungle?",
 *   punchline: 'Too many cheetahs!',
 *   rating: 7
 * }
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Usage Metadata</strong></summary>
 *
 * ```typescript
 * const aiMsgForMetadata = await llm.invoke(input);
 * console.log(aiMsgForMetadata.usage_metadata);
 * ```
 *
 * ```txt
 * { input_tokens: 13, output_tokens: 89, total_tokens: 102 }
 * ```
 * </details>
 *
 * <br />
 */
export class ChatMistralAI extends BaseChatModel {
    // Used for tracing, replace with the same name as your class
    static lc_name() {
        return "ChatMistralAI";
    }
    constructor(fields) {
        super(fields ?? {});
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain", "chat_models", "mistralai"]
        });
        Object.defineProperty(this, "model", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "mistral-small-latest"
        });
        Object.defineProperty(this, "apiKey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /**
         * @deprecated use serverURL instead
         */
        Object.defineProperty(this, "endpoint", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "serverURL", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "temperature", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0.7
        });
        Object.defineProperty(this, "streaming", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "topP", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 1
        });
        Object.defineProperty(this, "maxTokens", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /**
         * @deprecated use safePrompt instead
         */
        Object.defineProperty(this, "safeMode", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "safePrompt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "randomSeed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "seed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "maxRetries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "streamUsage", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "beforeRequestHooks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "requestErrorHooks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "responseHooks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "httpClient", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "presencePenalty", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "frequencyPenalty", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "numCompletions", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        const apiKey = fields?.apiKey ?? getEnvironmentVariable("MISTRAL_API_KEY");
        if (!apiKey) {
            throw new Error("API key MISTRAL_API_KEY is missing for MistralAI, but it is required.");
        }
        this.apiKey = apiKey;
        this.streaming = fields?.streaming ?? this.streaming;
        this.serverURL = fields?.serverURL ?? this.serverURL;
        this.temperature = fields?.temperature ?? this.temperature;
        this.topP = fields?.topP ?? this.topP;
        this.maxTokens = fields?.maxTokens ?? this.maxTokens;
        this.safePrompt = fields?.safePrompt ?? this.safePrompt;
        this.randomSeed = fields?.seed ?? fields?.randomSeed ?? this.seed;
        this.seed = this.randomSeed;
        this.maxRetries = fields?.maxRetries;
        this.httpClient = fields?.httpClient;
        this.model = fields?.model ?? fields?.modelName ?? this.model;
        this.streamUsage = fields?.streamUsage ?? this.streamUsage;
        this.beforeRequestHooks =
            fields?.beforeRequestHooks ?? this.beforeRequestHooks;
        this.requestErrorHooks =
            fields?.requestErrorHooks ?? this.requestErrorHooks;
        this.responseHooks = fields?.responseHooks ?? this.responseHooks;
        this.presencePenalty = fields?.presencePenalty ?? this.presencePenalty;
        this.frequencyPenalty = fields?.frequencyPenalty ?? this.frequencyPenalty;
        this.numCompletions = fields?.numCompletions ?? this.numCompletions;
        this.addAllHooksToHttpClient();
    }
    get lc_secrets() {
        return {
            apiKey: "MISTRAL_API_KEY",
        };
    }
    get lc_aliases() {
        return {
            apiKey: "mistral_api_key",
        };
    }
    getLsParams(options) {
        const params = this.invocationParams(options);
        return {
            ls_provider: "mistral",
            ls_model_name: this.model,
            ls_model_type: "chat",
            ls_temperature: params.temperature ?? undefined,
            ls_max_tokens: params.maxTokens ?? undefined,
        };
    }
    _llmType() {
        return "mistral_ai";
    }
    /**
     * Get the parameters used to invoke the model
     */
    invocationParams(options) {
        const { response_format, tools, tool_choice } = options ?? {};
        const mistralAITools = tools?.length
            ? _convertToolToMistralTool(tools)
            : undefined;
        const params = {
            model: this.model,
            tools: mistralAITools,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            topP: this.topP,
            randomSeed: this.seed,
            safePrompt: this.safePrompt,
            toolChoice: tool_choice,
            responseFormat: response_format,
            presencePenalty: this.presencePenalty,
            frequencyPenalty: this.frequencyPenalty,
            n: this.numCompletions,
        };
        return params;
    }
    bindTools(tools, kwargs) {
        return this.bind({
            tools: _convertToolToMistralTool(tools),
            ...kwargs,
        });
    }
    async completionWithRetry(input, streaming) {
        const caller = new AsyncCaller({
            maxRetries: this.maxRetries,
        });
        const client = new MistralClient({
            apiKey: this.apiKey,
            serverURL: this.serverURL,
            // If httpClient exists, pass it into constructor
            ...(this.httpClient ? { httpClient: this.httpClient } : {}),
        });
        return caller.call(async () => {
            try {
                let res;
                if (streaming) {
                    res = await client.chat.stream(input);
                }
                else {
                    res = await client.chat.complete(input);
                }
                return res;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            }
            catch (e) {
                if (e.message?.includes("status: 400") ||
                    e.message?.toLowerCase().includes("status 400") ||
                    e.message?.includes("validation failed")) {
                    e.status = 400;
                }
                throw e;
            }
        });
    }
    /** @ignore */
    async _generate(messages, options, runManager) {
        const tokenUsage = {};
        const params = this.invocationParams(options);
        const mistralMessages = convertMessagesToMistralMessages(messages);
        const input = {
            ...params,
            messages: mistralMessages,
        };
        // Enable streaming for signal controller or timeout due
        // to SDK limitations on canceling requests.
        const shouldStream = options.signal ?? !!options.timeout;
        // Handle streaming
        if (this.streaming || shouldStream) {
            const stream = this._streamResponseChunks(messages, options, runManager);
            const finalChunks = {};
            for await (const chunk of stream) {
                const index = chunk.generationInfo?.completion ?? 0;
                if (finalChunks[index] === undefined) {
                    finalChunks[index] = chunk;
                }
                else {
                    finalChunks[index] = finalChunks[index].concat(chunk);
                }
            }
            const generations = Object.entries(finalChunks)
                .sort(([aKey], [bKey]) => parseInt(aKey, 10) - parseInt(bKey, 10))
                .map(([_, value]) => value);
            return { generations, llmOutput: { estimatedTokenUsage: tokenUsage } };
        }
        // Not streaming, so we can just call the API once.
        const response = await this.completionWithRetry(input, false);
        const { completionTokens, promptTokens, totalTokens } = response?.usage ?? {};
        if (completionTokens) {
            tokenUsage.completionTokens =
                (tokenUsage.completionTokens ?? 0) + completionTokens;
        }
        if (promptTokens) {
            tokenUsage.promptTokens = (tokenUsage.promptTokens ?? 0) + promptTokens;
        }
        if (totalTokens) {
            tokenUsage.totalTokens = (tokenUsage.totalTokens ?? 0) + totalTokens;
        }
        const generations = [];
        for (const part of response?.choices ?? []) {
            if ("delta" in part) {
                throw new Error("Delta not supported in non-streaming mode.");
            }
            if (!("message" in part)) {
                throw new Error("No message found in the choice.");
            }
            let text = part.message?.content ?? "";
            if (Array.isArray(text)) {
                text = text[0].type === "text" ? text[0].text : "";
            }
            const generation = {
                text,
                message: mistralAIResponseToChatMessage(part, response?.usage),
            };
            if (part.finishReason) {
                generation.generationInfo = { finishReason: part.finishReason };
            }
            generations.push(generation);
        }
        return {
            generations,
            llmOutput: { tokenUsage },
        };
    }
    async *_streamResponseChunks(messages, options, runManager) {
        const mistralMessages = convertMessagesToMistralMessages(messages);
        const params = this.invocationParams(options);
        const input = {
            ...params,
            messages: mistralMessages,
        };
        const streamIterable = await this.completionWithRetry(input, true);
        for await (const { data } of streamIterable) {
            if (options.signal?.aborted) {
                throw new Error("AbortError");
            }
            const choice = data?.choices[0];
            if (!choice || !("delta" in choice)) {
                continue;
            }
            const { delta } = choice;
            if (!delta) {
                continue;
            }
            const newTokenIndices = {
                prompt: 0,
                completion: choice.index ?? 0,
            };
            const shouldStreamUsage = this.streamUsage || options.streamUsage;
            const message = _convertDeltaToMessageChunk(delta, shouldStreamUsage ? data.usage : null);
            if (message === null) {
                // Do not yield a chunk if the message is empty
                continue;
            }
            let text = delta.content ?? "";
            if (Array.isArray(text)) {
                text = text[0].type === "text" ? text[0].text : "";
            }
            const generationChunk = new ChatGenerationChunk({
                message,
                text,
                generationInfo: newTokenIndices,
            });
            yield generationChunk;
            // eslint-disable-next-line no-void
            void runManager?.handleLLMNewToken(generationChunk.text ?? "", newTokenIndices, undefined, undefined, undefined, { chunk: generationChunk });
        }
    }
    addAllHooksToHttpClient() {
        try {
            // To prevent duplicate hooks
            this.removeAllHooksFromHttpClient();
            // If the user wants to use hooks, but hasn't created an HTTPClient yet
            const hasHooks = [
                this.beforeRequestHooks,
                this.requestErrorHooks,
                this.responseHooks,
            ].some((hook) => hook && hook.length > 0);
            if (hasHooks && !this.httpClient) {
                this.httpClient = new MistralAIHTTPClient();
            }
            if (this.beforeRequestHooks) {
                for (const hook of this.beforeRequestHooks) {
                    this.httpClient?.addHook("beforeRequest", hook);
                }
            }
            if (this.requestErrorHooks) {
                for (const hook of this.requestErrorHooks) {
                    this.httpClient?.addHook("requestError", hook);
                }
            }
            if (this.responseHooks) {
                for (const hook of this.responseHooks) {
                    this.httpClient?.addHook("response", hook);
                }
            }
        }
        catch {
            throw new Error("Error in adding all hooks");
        }
    }
    removeAllHooksFromHttpClient() {
        try {
            if (this.beforeRequestHooks) {
                for (const hook of this.beforeRequestHooks) {
                    this.httpClient?.removeHook("beforeRequest", hook);
                }
            }
            if (this.requestErrorHooks) {
                for (const hook of this.requestErrorHooks) {
                    this.httpClient?.removeHook("requestError", hook);
                }
            }
            if (this.responseHooks) {
                for (const hook of this.responseHooks) {
                    this.httpClient?.removeHook("response", hook);
                }
            }
        }
        catch {
            throw new Error("Error in removing hooks");
        }
    }
    removeHookFromHttpClient(hook) {
        try {
            this.httpClient?.removeHook("beforeRequest", hook);
            this.httpClient?.removeHook("requestError", hook);
            this.httpClient?.removeHook("response", hook);
        }
        catch {
            throw new Error("Error in removing hook");
        }
    }
    /** @ignore */
    _combineLLMOutput() {
        return [];
    }
    withStructuredOutput(outputSchema, config) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const schema = outputSchema;
        const name = config?.name;
        const method = config?.method;
        const includeRaw = config?.includeRaw;
        let llm;
        let outputParser;
        if (method === "jsonMode") {
            llm = this.bind({
                response_format: { type: "json_object" },
            });
            if (isZodSchema(schema)) {
                outputParser = StructuredOutputParser.fromZodSchema(schema);
            }
            else {
                outputParser = new JsonOutputParser();
            }
        }
        else {
            let functionName = name ?? "extract";
            // Is function calling
            if (isZodSchema(schema)) {
                const asJsonSchema = zodToJsonSchema(schema);
                llm = this.bind({
                    tools: [
                        {
                            type: "function",
                            function: {
                                name: functionName,
                                description: asJsonSchema.description,
                                parameters: asJsonSchema,
                            },
                        },
                    ],
                    tool_choice: "any",
                });
                outputParser = new JsonOutputKeyToolsParser({
                    returnSingle: true,
                    keyName: functionName,
                    zodSchema: schema,
                });
            }
            else {
                let openAIFunctionDefinition;
                if (typeof schema.name === "string" &&
                    typeof schema.parameters === "object" &&
                    schema.parameters != null) {
                    openAIFunctionDefinition = schema;
                    functionName = schema.name;
                }
                else {
                    openAIFunctionDefinition = {
                        name: functionName,
                        description: schema.description ?? "",
                        parameters: schema,
                    };
                }
                llm = this.bind({
                    tools: [
                        {
                            type: "function",
                            function: openAIFunctionDefinition,
                        },
                    ],
                    tool_choice: "any",
                });
                outputParser = new JsonOutputKeyToolsParser({
                    returnSingle: true,
                    keyName: functionName,
                });
            }
        }
        if (!includeRaw) {
            return llm.pipe(outputParser);
        }
        const parserAssign = RunnablePassthrough.assign({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parsed: (input, config) => outputParser.invoke(input.raw, config),
        });
        const parserNone = RunnablePassthrough.assign({
            parsed: () => null,
        });
        const parsedWithFallback = parserAssign.withFallbacks({
            fallbacks: [parserNone],
        });
        return RunnableSequence.from([
            {
                raw: llm,
            },
            parsedWithFallback,
        ]);
    }
}
function isZodSchema(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
input) {
    // Check for a characteristic method of Zod schemas
    return typeof input?.parse === "function";
}
