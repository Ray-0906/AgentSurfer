import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseLLMParams, LLM } from "@langchain/core/language_models/llms";
import { type BaseLanguageModelCallOptions } from "@langchain/core/language_models/base";
import { GenerationChunk, LLMResult } from "@langchain/core/outputs";
import { FIMCompletionRequest as MistralAIFIMCompletionRequest } from "@mistralai/mistralai/models/components/fimcompletionrequest.js";
import { FIMCompletionStreamRequest as MistralAIFIMCompletionStreamRequest } from "@mistralai/mistralai/models/components/fimcompletionstreamrequest.js";
import { FIMCompletionResponse as MistralAIFIMCompletionResponse } from "@mistralai/mistralai/models/components/fimcompletionresponse.js";
import { CompletionEvent as MistralAIChatCompletionEvent } from "@mistralai/mistralai/models/components/completionevent.js";
import { BeforeRequestHook, RequestErrorHook, ResponseHook, HTTPClient as MistralAIHTTPClient } from "@mistralai/mistralai/lib/http.js";
export interface MistralAICallOptions extends BaseLanguageModelCallOptions {
    /**
     * Optional text/code that adds more context for the model.
     * When given a prompt and a suffix the model will fill what
     * is between them. When suffix is not provided, the model
     * will simply execute completion starting with prompt.
     */
    suffix?: string;
}
export interface MistralAIInput extends BaseLLMParams {
    /**
     * The name of the model to use.
     * @default "codestral-latest"
     */
    model?: string;
    /**
     * The API key to use.
     * @default {process.env.MISTRAL_API_KEY}
     */
    apiKey?: string;
    /**
     * Override the default server URL used by the Mistral SDK.
     * @deprecated use serverURL instead
     */
    endpoint?: string;
    /**
     * Override the default server URL used by the Mistral SDK.
     */
    serverURL?: string;
    /**
     * What sampling temperature to use, between 0.0 and 2.0.
     * Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.
     * @default {0.7}
     */
    temperature?: number;
    /**
     * Nucleus sampling, where the model considers the results of the tokens with `topP` probability mass.
     * So 0.1 means only the tokens comprising the top 10% probability mass are considered.
     * Should be between 0 and 1.
     * @default {1}
     */
    topP?: number;
    /**
     * The maximum number of tokens to generate in the completion.
     * The token count of your prompt plus maxTokens cannot exceed the model's context length.
     */
    maxTokens?: number;
    /**
     * Whether or not to stream the response.
     * @default {false}
     */
    streaming?: boolean;
    /**
     * The seed to use for random sampling. If set, different calls will generate deterministic results.
     * Alias for `seed`
     */
    randomSeed?: number;
    /**
     * Batch size to use when passing multiple documents to generate
     */
    batchSize?: number;
    /**
     * A list of custom hooks that must follow (req: Request) => Awaitable<Request | void>
     * They are automatically added when a ChatMistralAI instance is created
     */
    beforeRequestHooks?: BeforeRequestHook[];
    /**
     * A list of custom hooks that must follow (err: unknown, req: Request) => Awaitable<void>
     * They are automatically added when a ChatMistralAI instance is created
     */
    requestErrorHooks?: RequestErrorHook[];
    /**
     * A list of custom hooks that must follow (res: Response, req: Request) => Awaitable<void>
     * They are automatically added when a ChatMistralAI instance is created
     */
    responseHooks?: ResponseHook[];
    /**
     * Optional custom HTTP client to manage API requests
     * Allows users to add custom fetch implementations, hooks, as well as error and response processing.
     */
    httpClient?: MistralAIHTTPClient;
}
/**
 * MistralAI completions LLM.
 */
export declare class MistralAI extends LLM<MistralAICallOptions> implements MistralAIInput {
    static lc_name(): string;
    lc_namespace: string[];
    lc_serializable: boolean;
    model: string;
    temperature: number;
    topP?: number;
    maxTokens?: number | undefined;
    randomSeed?: number | undefined;
    streaming: boolean;
    batchSize: number;
    apiKey: string;
    /**
     * @deprecated use serverURL instead
     */
    endpoint: string;
    serverURL?: string;
    maxRetries?: number;
    maxConcurrency?: number;
    beforeRequestHooks?: Array<BeforeRequestHook>;
    requestErrorHooks?: Array<RequestErrorHook>;
    responseHooks?: Array<ResponseHook>;
    httpClient?: MistralAIHTTPClient;
    constructor(fields?: MistralAIInput);
    get lc_secrets(): {
        [key: string]: string;
    } | undefined;
    get lc_aliases(): {
        [key: string]: string;
    } | undefined;
    _llmType(): string;
    invocationParams(options: this["ParsedCallOptions"]): Omit<MistralAIFIMCompletionRequest | MistralAIFIMCompletionStreamRequest, "prompt">;
    /**
     * For some given input string and options, return a string output.
     *
     * Despite the fact that `invoke` is overridden below, we still need this
     * in order to handle public APi calls to `generate()`.
     */
    _call(prompt: string, options: this["ParsedCallOptions"]): Promise<string>;
    _generate(prompts: string[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): Promise<LLMResult>;
    completionWithRetry(request: MistralAIFIMCompletionRequest, options: this["ParsedCallOptions"], stream: false): Promise<MistralAIFIMCompletionResponse>;
    completionWithRetry(request: MistralAIFIMCompletionStreamRequest, options: this["ParsedCallOptions"], stream: true): Promise<AsyncIterable<MistralAIChatCompletionEvent>>;
    _streamResponseChunks(prompt: string, options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): AsyncGenerator<GenerationChunk>;
    addAllHooksToHttpClient(): void;
    removeAllHooksFromHttpClient(): void;
    removeHookFromHttpClient(hook: BeforeRequestHook | RequestErrorHook | ResponseHook): void;
    /** @ignore */
    private imports;
}
