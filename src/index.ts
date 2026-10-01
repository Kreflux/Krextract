// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Kreflux. https://github.com/Kreflux/Krextract

export const VERSION = "0.1.0";
export const NAME = "Kreflux Reasoning Extraction";

export type GuardCode =
  | "private_channel" | "unknown_part" | "inline_reasoning" | "protected_value"
  | "invalid_payload" | "output_limit" | "incomplete_stream" | "empty_output";
export type Provider = "openai-chat" | "openai-responses" | "anthropic";
export interface GuardOptions {
  maxOutputChars?: number;
  protectedValues?: readonly string[];
}
export interface PublicResult {
  readonly status: "released" | "withheld";
  readonly text: string;
  readonly codes: readonly GuardCode[];
  readonly withheldParts: number;
}
export type PromptSignal = "extraction_request" | "authority_claim" | "encoded_request" | "input_limit";
export interface PromptAssessment {
  readonly decision: "review" | "no_match";
  readonly signals: readonly PromptSignal[];
}

const MAX_EVENTS = 4096;
const MAX_INPUT = 16000;
const PRIVATE_CHANNELS = new Set(["analysis", "reasoning", "thinking", "redacted_thinking", "scratchpad"]);
const TAGS = ["<think", "</think", "<thinking", "<analysis", "</analysis", "<reasoning", "</reasoning", "<scratchpad", "<private_reasoning", "<|analysis|>", "<|channel|>analysis", "<|im_sep|>analysis"];
const INLINE_REASONING = /<\s*\/?\s*(?:think(?:ing)?|analysis|reasoning|scratchpad|private[_-]?reasoning)(?=[\s/>]|$)|<\|(?:analysis|reasoning|thinking)\|>|<\|(?:channel|im_sep)\|>\s*(?:analysis|reasoning)/i;

function canonicalize(text: string): string {
  let value = text;
  for (let pass = 0; pass < 2; pass++) {
    value = value.replace(/\\u([\da-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&#(?:x([\da-f]{1,6})|(\d{1,7}));/gi, (_, hex: string | undefined, decimal: string) => {
        const code = parseInt(hex ?? decimal, hex ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      });
    try { value = decodeURIComponent(value); } catch { /* Malformed percent escapes remain literal. */ }
  }
  return value.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase();
}

function hasReasoningMarker(text: string): boolean {
  if (INLINE_REASONING.test(text)) return true;
  const start = text.lastIndexOf("<");
  if (start < 0) return false;
  const tail = text.slice(start).replace(/\s/g, "");
  return tail.length > 0 && TAGS.some((tag) => tag.startsWith(tail));
}

export function inspectPrompt(input: string): PromptAssessment {
  if (typeof input !== "string") throw new TypeError("Prompt must be a string.");
  if (input.length > MAX_INPUT) return Object.freeze({ decision: "review", signals: Object.freeze(["input_limit"] as PromptSignal[]) });
  const text = canonicalize(input);
  const target = /\b(?:hidden|private|internal|verbatim|full)\s+(?:chain[- ]of[- ]thought|reasoning|analysis|thoughts?|scratchpad)\b|\bchain[- ]of[- ]thought\b|\bsystem\s+(?:prompt|instructions)\b|\bscratchpad\b|(?:隐藏|内部|私有|完整)(?:的)?(?:推理|思维链|思考|分析)|系统提示词/.test(text);
  const request = /\b(?:show|reveal|dump|print|repeat|return|expose|extract|give|include|output|encode|translate|continue|reconstruct|display)\b|展示|显示|输出|提取|打印|泄露|透露|复述|翻译/.test(text);
  const signals: PromptSignal[] = [];
  if (target && request) {
    signals.push("extraction_request");
    if (/\b(?:developer|administrator|system message|debug mode|audit|authorized|authorization)\b|开发者|管理员|调试|授权/.test(text)) signals.push("authority_claim");
    if (/\b(?:base64|rot13|hexadecimal|encode|encoded|encrypt|translate)\b|编码|翻译/.test(text)) signals.push("encoded_request");
  }
  return Object.freeze({ decision: signals.length ? "review" : "no_match", signals: Object.freeze(signals) });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OutputBoundary {
  #chunks: string[] = [];
  #size = 0;
  #events = 0;
  #withheld = 0;
  #failed = false;
  #codes = new Set<GuardCode>();
  #result: PublicResult | undefined;
  #limit: number;
  #protected: string[];

  constructor(options: GuardOptions = {}) {
    const limit = options.maxOutputChars ?? 65536;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new RangeError("Output limit must be an integer from 1 to 1000000.");
    const values = options.protectedValues ?? [];
    if (!Array.isArray(values) || values.length > 32 || values.some((value) => typeof value !== "string" || value.length > 1024 || canonicalize(value).length < 4)) throw new TypeError("Supply at most 32 protected strings, each 4 to 1024 characters after normalization.");
    this.#limit = limit;
    this.#protected = values.map(canonicalize);
  }

  reject(code: GuardCode): void {
    if (this.#result) throw new Error("Output boundary is already closed.");
    this.#codes.add(code);
    this.#failed = true;
    this.#chunks = [];
    this.#size = 0;
  }

  write(part: unknown): void {
    if (this.#result) throw new Error("Output boundary is already closed.");
    if (this.#failed) return;
    if (++this.#events > MAX_EVENTS) { this.reject("output_limit"); return; }
    if (!record(part) || typeof part.channel !== "string") { this.reject("invalid_payload"); return; }
    if (part.channel !== "final") {
      this.#withheld++;
      this.#codes.add(PRIVATE_CHANNELS.has(part.channel) ? "private_channel" : "unknown_part");
      return;
    }
    if (typeof part.text !== "string") { this.reject("invalid_payload"); return; }
    if (part.text.length > this.#limit - this.#size) { this.reject("output_limit"); return; }
    this.#size += part.text.length;
    this.#chunks.push(part.text);
  }

  // No text leaves this object before explicit, successful upstream completion.
  finish(completed: boolean): PublicResult {
    if (this.#result) return this.#result;
    if (completed !== true) this.reject("incomplete_stream");
    const text = this.#chunks.join("");
    const normalized = canonicalize(text);
    if (hasReasoningMarker(normalized)) this.reject("inline_reasoning");
    if (this.#protected.some((value) => normalized.includes(value))) this.reject("protected_value");
    if (!text.trim() && !this.#failed) this.reject("empty_output");
    this.#result = Object.freeze({
      status: this.#failed ? "withheld" : "released",
      text: this.#failed ? "" : text,
      codes: Object.freeze([...this.#codes]),
      withheldParts: this.#withheld,
    });
    this.#chunks = [];
    this.#protected = [];
    return this.#result;
  }

  abort(): PublicResult { return this.finish(false); }
}

function writeContent(boundary: OutputBoundary, content: unknown, format: "chat" | "responses" | "anthropic"): void {
  if (format === "chat" && typeof content === "string") { boundary.write({ channel: "final", text: content }); return; }
  if (content === null && format === "chat") return;
  if (!Array.isArray(content)) { boundary.reject("invalid_payload"); return; }
  if (content.length > MAX_EVENTS) { boundary.reject("output_limit"); return; }
  for (const part of content) {
    if (!record(part) || typeof part.type !== "string") { boundary.reject("invalid_payload"); return; }
    if (part.channel !== undefined && part.channel !== "final") {
      boundary.write({ channel: typeof part.channel === "string" ? part.channel : "unknown" });
      continue;
    }
    const textType = format === "responses" ? "output_text" : "text";
    if (part.type === textType) {
      boundary.write({ channel: "final", text: part.text });
    } else if (format === "responses" && part.type === "refusal") {
      boundary.write({ channel: "final", text: part.refusal });
    } else {
      boundary.write({ channel: part.type });
    }
  }
}

export function projectResponse(provider: Provider, payload: unknown, options: GuardOptions = {}): PublicResult {
  const boundary = new OutputBoundary(options);
  if (!record(payload)) { boundary.reject("invalid_payload"); return boundary.finish(false); }
  let completed = false;
  if (provider === "openai-chat") {
    if (!Array.isArray(payload.choices) || payload.choices.length !== 1) { boundary.reject("invalid_payload"); return boundary.finish(false); }
    const choice: unknown = payload.choices[0];
    if (!record(choice) || !record(choice.message) || choice.message.role !== "assistant") { boundary.reject("invalid_payload"); return boundary.finish(false); }
    const message = choice.message;
    completed = choice.finish_reason === "stop";
    for (const key of ["reasoning", "reasoning_content", "thinking"]) {
      if (Object.hasOwn(message, key)) boundary.write({ channel: "reasoning" });
    }
    if (message.channel !== undefined && message.channel !== "final") {
      boundary.write({ channel: typeof message.channel === "string" ? message.channel : "unknown" });
    } else {
      writeContent(boundary, message.content, "chat");
    }
  } else if (provider === "openai-responses") {
    completed = payload.status === "completed";
    if (!Array.isArray(payload.output) || payload.output.length > MAX_EVENTS) { boundary.reject("invalid_payload"); return boundary.finish(false); }
    for (const item of payload.output) {
      if (!record(item) || typeof item.type !== "string") { boundary.reject("invalid_payload"); break; }
      if (item.type === "message" && item.role === "assistant" && (item.channel === undefined || item.channel === "final")) {
        if (item.status !== "completed") { boundary.reject("incomplete_stream"); break; }
        writeContent(boundary, item.content, "responses");
      } else {
        boundary.write({ channel: typeof item.channel === "string" ? item.channel : item.type });
      }
    }
  } else if (provider === "anthropic") {
    if (payload.type !== "message" || payload.role !== "assistant") { boundary.reject("invalid_payload"); return boundary.finish(false); }
    completed = payload.stop_reason === "end_turn";
    writeContent(boundary, payload.content, "anthropic");
  } else {
    boundary.reject("invalid_payload");
  }
  return boundary.finish(completed);
}
