import { ContentChunk as MistralAIContentChunk } from "@mistralai/mistralai/models/components/contentchunk.js";
import { MessageContentComplex } from "@langchain/core/messages";
export declare function _isValidMistralToolCallId(toolCallId: string): boolean;
export declare function _convertToolCallIdToMistralCompatible(toolCallId: string): string;
export declare function _mistralContentChunkToMessageContentComplex(content: string | MistralAIContentChunk[] | null | undefined): string | MessageContentComplex[];
