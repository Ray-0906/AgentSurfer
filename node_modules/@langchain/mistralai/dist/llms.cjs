"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MistralAI = void 0;
const llms_1 = require("@langchain/core/language_models/llms");
const outputs_1 = require("@langchain/core/outputs");
const http_js_1 = require("@mistralai/mistralai/lib/http.js");
const env_1 = require("@langchain/core/utils/env");
const chunk_array_1 = require("@langchain/core/utils/chunk_array");
const async_caller_1 = require("@langchain/core/utils/async_caller");
/**
 * MistralAI completions LLM.
 */
class MistralAI extends llms_1.LLM {
    static lc_name() {
        return "MistralAI";
    }
    constructor(fields) {
        super(fields ?? {});
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain", "llms", "mistralai"]
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "model", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "codestral-latest"
        });
        Object.defineProperty(this, "temperature", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "topP", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "maxTokens", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "randomSeed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "streaming", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "batchSize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 20
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
        Object.defineProperty(this, "maxRetries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "maxConcurrency", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
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
        this.model = fields?.model ?? this.model;
        this.temperature = fields?.temperature ?? this.temperature;
        this.topP = fields?.topP ?? this.topP;
        this.maxTokens = fields?.maxTokens ?? this.maxTokens;
        this.randomSeed = fields?.randomSeed ?? this.randomSeed;
        this.batchSize = fields?.batchSize ?? this.batchSize;
        this.streaming = fields?.streaming ?? this.streaming;
        this.serverURL = fields?.serverURL ?? this.serverURL;
        this.maxRetries = fields?.maxRetries;
        this.maxConcurrency = fields?.maxConcurrency;
        this.beforeRequestHooks =
            fields?.beforeRequestHooks ?? this.beforeRequestHooks;
        this.requestErrorHooks =
            fields?.requestErrorHooks ?? this.requestErrorHooks;
        this.responseHooks = fields?.responseHooks ?? this.responseHooks;
        this.httpClient = fields?.httpClient ?? this.httpClient;
        const apiKey = fields?.apiKey ?? (0, env_1.getEnvironmentVariable)("MISTRAL_API_KEY");
        if (!apiKey) {
            throw new Error(`MistralAI requires an API key to be set.
Either provide one via the "apiKey" field in the constructor, or set the "MISTRAL_API_KEY" environment variable.`);
        }
        this.apiKey = apiKey;
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
    _llmType() {
        return "mistralai";
    }
    invocationParams(options) {
        return {
            model: this.model,
            suffix: options.suffix,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            topP: this.topP,
            randomSeed: this.randomSeed,
            stop: options.stop,
        };
    }
    /**
     * For some given input string and options, return a string output.
     *
     * Despite the fact that `invoke` is overridden below, we still need this
     * in order to handle public APi calls to `generate()`.
     */
    async _call(prompt, options) {
        const params = {
            ...this.invocationParams(options),
            prompt,
        };
        const result = await this.completionWithRetry(params, options, false);
        let content = result?.choices?.[0].message.content ?? "";
        if (Array.isArray(content)) {
            content = content[0].type === "text" ? content[0].text : "";
        }
        return content;
    }
    async _generate(prompts, options, runManager) {
        const subPrompts = (0, chunk_array_1.chunkArray)(prompts, this.batchSize);
        const choices = [];
        const params = this.invocationParams(options);
        for (let i = 0; i < subPrompts.length; i += 1) {
            const data = await (async () => {
                if (this.streaming) {
                    const responseData = [];
                    for (let x = 0; x < subPrompts[i].length; x += 1) {
                        const choices = [];
                        let response;
                        const stream = await this.completionWithRetry({
                            ...params,
                            prompt: subPrompts[i][x],
                        }, options, true);
                        for await (const { data } of stream) {
                            // on the first message set the response properties
                            if (!response) {
                                response = {
                                    id: data.id,
                                    object: "chat.completion",
                                    created: data.created,
                                    model: data.model,
                                };
                            }
                            // on all messages, update choice
                            for (const part of data.choices) {
                                let content = part.delta.content ?? "";
                                // Convert MistralContentChunk data into a string
                                if (Array.isArray(content)) {
                                    let strContent = "";
                                    for (const contentChunk of content) {
                                        if (contentChunk.type === "text") {
                                            strContent += contentChunk.text;
                                        }
                                        else if (contentChunk.type === "image_url") {
                                            const imageURL = typeof contentChunk.imageUrl === "string"
                                                ? contentChunk.imageUrl
                                                : contentChunk.imageUrl.url;
                                            strContent += imageURL;
                                        }
                                    }
                                    content = strContent;
                                }
                                if (!choices[part.index]) {
                                    choices[part.index] = {
                                        index: part.index,
                                        message: {
                                            role: "assistant",
                                            content,
                                            toolCalls: null,
                                        },
                                        finishReason: part.finishReason ?? "length",
                                    };
                                }
                                else {
                                    const choice = choices[part.index];
                                    choice.message.content += content;
                                    choice.finishReason = part.finishReason ?? "length";
                                }
                                void runManager?.handleLLMNewToken(content, {
                                    prompt: part.index,
                                    completion: part.index,
                                });
                            }
                        }
                        if (options.signal?.aborted) {
                            throw new Error("AbortError");
                        }
                        responseData.push({
                            ...response,
                            choices,
                        });
                    }
                    return responseData;
                }
                else {
                    const responseData = [];
                    for (let x = 0; x < subPrompts[i].length; x += 1) {
                        const res = await this.completionWithRetry({
                            ...params,
                            prompt: subPrompts[i][x],
                        }, options, false);
                        responseData.push(res);
                    }
                    return responseData;
                }
            })();
            choices.push(...data.map((d) => d.choices ?? []));
        }
        const generations = choices.map((promptChoices) => promptChoices.map((choice) => {
            let text = choice.message?.content ?? "";
            if (Array.isArray(text)) {
                text = text[0].type === "text" ? text[0].text : "";
            }
            return {
                text,
                generationInfo: {
                    finishReason: choice.finishReason,
                },
            };
        }));
        return {
            generations,
        };
    }
    async completionWithRetry(request, options, stream) {
        const { Mistral } = await this.imports();
        const caller = new async_caller_1.AsyncCaller({
            maxConcurrency: options.maxConcurrency || this.maxConcurrency,
            maxRetries: this.maxRetries,
        });
        const client = new Mistral({
            apiKey: this.apiKey,
            serverURL: this.serverURL,
            timeoutMs: options.timeout,
            // If httpClient exists, pass it into constructor
            ...(this.httpClient ? { httpClient: this.httpClient } : {}),
        });
        return caller.callWithOptions({
            signal: options.signal,
        }, async () => {
            try {
                let res;
                if (stream) {
                    res = await client.fim.stream(request);
                }
                else {
                    res = await client.fim.complete(request);
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
    async *_streamResponseChunks(prompt, options, runManager) {
        const params = {
            ...this.invocationParams(options),
            prompt,
        };
        const stream = await this.completionWithRetry(params, options, true);
        for await (const message of stream) {
            const { data } = message;
            const choice = data?.choices[0];
            if (!choice) {
                continue;
            }
            let text = choice.delta.content ?? "";
            if (Array.isArray(text)) {
                text = text[0].type === "text" ? text[0].text : "";
            }
            const chunk = new outputs_1.GenerationChunk({
                text,
                generationInfo: {
                    finishReason: choice.finishReason,
                    tokenUsage: data.usage,
                },
            });
            yield chunk;
            // eslint-disable-next-line no-void
            void runManager?.handleLLMNewToken(chunk.text ?? "");
        }
        if (options.signal?.aborted) {
            throw new Error("AbortError");
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
                this.httpClient = new http_js_1.HTTPClient();
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
    async imports() {
        const { Mistral } = await import("@mistralai/mistralai");
        return { Mistral };
    }
}
exports.MistralAI = MistralAI;
