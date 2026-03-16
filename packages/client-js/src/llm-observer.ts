/**
 * LLM call observer — auto-instruments OpenAI, Anthropic, and other LLM SDKs
 * to capture prompts, completions, token counts, latency, cost, and model metadata.
 *
 * Writes to .trickle/llm.jsonl as:
 *   { "kind": "llm_call", "provider": "openai", "model": "gpt-4",
 *     "inputTokens": 100, "outputTokens": 50, "durationMs": 1234.5, ... }
 *
 * Supports both streaming and non-streaming calls.
 * Zero code changes needed — intercepted via Module._load hook.
 */

import * as fs from 'fs';
import * as path from 'path';

let llmFile: string | null = null;
let eventCount = 0;
const MAX_LLM_EVENTS = 500;
const TRUNCATE_LEN = 500;

// Token budget enforcement
let cumulativeTokens = 0;
let cumulativeCost = 0;
let budgetWarned = false;
const TOKEN_BUDGET = parseInt(process.env.TRICKLE_TOKEN_BUDGET || '0', 10);
const COST_BUDGET = parseFloat(process.env.TRICKLE_COST_BUDGET || '0');

// Approximate pricing per 1M tokens (USD) — used for cost estimation
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
};

function getLlmFile(): string {
  if (llmFile) return llmFile;
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  llmFile = path.join(dir, 'llm.jsonl');
  return llmFile;
}

interface LlmEvent {
  kind: 'llm_call';
  provider: string;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  stream: boolean;
  finishReason: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  inputPreview: string;
  outputPreview: string;
  messageCount: number;
  toolUse: boolean;
  timestamp: number;
  error?: string;
}

function writeLlmEvent(event: LlmEvent): void {
  if (eventCount >= MAX_LLM_EVENTS) return;
  eventCount++;

  // Track cumulative usage for budget enforcement
  cumulativeTokens += event.totalTokens || 0;
  cumulativeCost += event.estimatedCostUsd || 0;

  if (!budgetWarned) {
    if (TOKEN_BUDGET > 0 && cumulativeTokens > TOKEN_BUDGET) {
      console.warn(`[trickle] ⚠ Token budget exceeded: ${cumulativeTokens} tokens used (budget: ${TOKEN_BUDGET}). Set TRICKLE_TOKEN_BUDGET=0 to disable.`);
      budgetWarned = true;
    }
    if (COST_BUDGET > 0 && cumulativeCost > COST_BUDGET) {
      console.warn(`[trickle] ⚠ Cost budget exceeded: $${cumulativeCost.toFixed(4)} spent (budget: $${COST_BUDGET.toFixed(4)}). Set TRICKLE_COST_BUDGET=0 to disable.`);
      budgetWarned = true;
    }
  }
  try {
    fs.appendFileSync(getLlmFile(), JSON.stringify(event) + '\n');
  } catch {}
}

function truncate(s: string, len = TRUNCATE_LEN): string {
  if (!s) return '';
  return s.length > len ? s.substring(0, len) + '...' : s;
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Find best matching pricing key
  const key = Object.keys(PRICING).find(k => model.includes(k)) || '';
  if (!key) return 0;
  const p = PRICING[key];
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 1_000_000) / 1_000_000;
}

function extractInputPreview(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const last = messages[messages.length - 1];
  if (typeof last?.content === 'string') return truncate(last.content);
  if (Array.isArray(last?.content)) {
    const textPart = last.content.find((p: any) => p.type === 'text');
    if (textPart?.text) return truncate(textPart.text);
  }
  return '';
}

function extractSystemPrompt(messages: any[]): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const sys = messages.find((m: any) => m.role === 'system');
  if (sys?.content && typeof sys.content === 'string') return truncate(sys.content, 200);
  return undefined;
}

function hasToolUse(params: any): boolean {
  return !!(params.tools && Array.isArray(params.tools) && params.tools.length > 0);
}

// ────────────────────────────────────────────────────
// OpenAI SDK v4+ instrumentation
// ────────────────────────────────────────────────────

export function patchOpenAI(openaiModule: any, debug: boolean): void {
  if (!openaiModule || getattr(openaiModule, '_trickle_llm_patched')) return;
  setattr(openaiModule, '_trickle_llm_patched', true);

  const OpenAIClass = openaiModule.OpenAI || openaiModule.default;
  if (typeof OpenAIClass !== 'function') return;

  // OpenAI SDK v4+ creates resource instances (chat, completions) in the constructor
  // as own properties. The Completions class is not directly exported, but we can
  // access it by creating a temporary client and getting the prototype of chat.completions.
  try {
    // Create a temporary client to discover the Completions class
    // (ES6 classes require `new`, can't use .call())
    const tmpClient = new OpenAIClass({ apiKey: 'trickle-probe' });
    const CompletionsClass = Object.getPrototypeOf(tmpClient.chat?.completions)?.constructor;
    if (CompletionsClass && CompletionsClass.prototype.create && !CompletionsClass.prototype.create.__trickle_patched) {
      const origCreate = CompletionsClass.prototype.create;
      CompletionsClass.prototype.create = function patchedCreate(this: any, ...args: any[]) {
        const params = args[0] || {};
        const startTime = performance.now();
        const isStream = !!params.stream;
        const result = origCreate.apply(this, args);
        if (isStream) return handleOpenAIStream(result, params, startTime, debug);
        if (result && typeof result.then === 'function') {
          return result.then((response: any) => {
            captureOpenAIResponse(params, response, startTime, debug);
            return response;
          }).catch((err: any) => {
            captureOpenAIError(params, err, startTime, debug);
            throw err;
          });
        }
        return result;
      };
      (CompletionsClass.prototype.create as any).__trickle_patched = true;
      if (debug) console.log('[trickle/llm] Patched OpenAI SDK');
      return;
    }
  } catch (e: any) {
    if (debug) console.log('[trickle/llm] OpenAI patch probe failed:', e.message);
  }
}

function patchOpenAIClient(client: any, debug: boolean): void {
  // Patch chat.completions.create
  if (client.chat?.completions?.create && !client.chat.completions.create.__trickle_patched) {
    const origCreate = client.chat.completions.create.bind(client.chat.completions);
    client.chat.completions.create = function patchedCreate(...args: any[]) {
      const params = args[0] || {};
      const startTime = performance.now();
      const isStream = !!params.stream;

      const result = origCreate(...args);

      if (isStream) {
        return handleOpenAIStream(result, params, startTime, debug);
      }

      // Non-streaming: hook the promise
      if (result && typeof result.then === 'function') {
        return result.then((response: any) => {
          captureOpenAIResponse(params, response, startTime, debug);
          return response;
        }).catch((err: any) => {
          captureOpenAIError(params, err, startTime, debug);
          throw err;
        });
      }

      return result;
    };
    client.chat.completions.create.__trickle_patched = true;
  }

  // Patch completions.create (legacy)
  if (client.completions?.create && !client.completions.create.__trickle_patched) {
    const origCreate = client.completions.create.bind(client.completions);
    client.completions.create = function patchedCreate(...args: any[]) {
      const params = args[0] || {};
      const startTime = performance.now();

      const result = origCreate(...args);
      if (result && typeof result.then === 'function') {
        return result.then((response: any) => {
          const usage = response.usage || {};
          const text = response.choices?.[0]?.text || '';
          writeLlmEvent({
            kind: 'llm_call', provider: 'openai', model: params.model || 'unknown',
            durationMs: round(performance.now() - startTime),
            inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
            estimatedCostUsd: estimateCost(params.model || '', usage.prompt_tokens || 0, usage.completion_tokens || 0),
            stream: false, finishReason: response.choices?.[0]?.finish_reason || 'unknown',
            temperature: params.temperature, maxTokens: params.max_tokens,
            inputPreview: truncate(params.prompt || ''), outputPreview: truncate(text),
            messageCount: 0, toolUse: false, timestamp: Date.now(),
          });
          return response;
        });
      }
      return result;
    };
    client.completions.create.__trickle_patched = true;
  }
}

async function handleOpenAIStream(resultPromise: any, params: any, startTime: number, debug: boolean): Promise<any> {
  const stream = await resultPromise;
  const chunks: string[] = [];
  let finishReason = 'unknown';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Wrap the async iterator
  const origIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = function () {
    const iter = origIterator();
    return {
      async next() {
        const result = await iter.next();
        if (!result.done) {
          const chunk = result.value;
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) chunks.push(delta.content);
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (chunk.usage) {
            totalInputTokens = chunk.usage.prompt_tokens || totalInputTokens;
            totalOutputTokens = chunk.usage.completion_tokens || totalOutputTokens;
          }
        } else {
          // Stream finished — capture
          const outputText = chunks.join('');
          writeLlmEvent({
            kind: 'llm_call', provider: 'openai', model: params.model || 'unknown',
            durationMs: round(performance.now() - startTime),
            inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            estimatedCostUsd: estimateCost(params.model || '', totalInputTokens, totalOutputTokens),
            stream: true, finishReason,
            temperature: params.temperature, maxTokens: params.max_tokens,
            systemPrompt: extractSystemPrompt(params.messages),
            inputPreview: extractInputPreview(params.messages),
            outputPreview: truncate(outputText),
            messageCount: params.messages?.length || 0,
            toolUse: hasToolUse(params), timestamp: Date.now(),
          });
          if (debug) console.log(`[trickle/llm] OpenAI stream: ${params.model} (${totalOutputTokens} tokens)`);
        }
        return result;
      },
      return: iter.return?.bind(iter),
      throw: iter.throw?.bind(iter),
    };
  };

  return stream;
}

function captureOpenAIResponse(params: any, response: any, startTime: number, debug: boolean): void {
  const usage = response.usage || {};
  const outputText = response.choices?.[0]?.message?.content || '';
  const event: LlmEvent = {
    kind: 'llm_call', provider: 'openai', model: params.model || 'unknown',
    durationMs: round(performance.now() - startTime),
    inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    estimatedCostUsd: estimateCost(params.model || '', usage.prompt_tokens || 0, usage.completion_tokens || 0),
    stream: false, finishReason: response.choices?.[0]?.finish_reason || 'unknown',
    temperature: params.temperature, maxTokens: params.max_tokens,
    systemPrompt: extractSystemPrompt(params.messages),
    inputPreview: extractInputPreview(params.messages),
    outputPreview: truncate(outputText),
    messageCount: params.messages?.length || 0,
    toolUse: hasToolUse(params), timestamp: Date.now(),
  };
  writeLlmEvent(event);
  if (debug) console.log(`[trickle/llm] OpenAI: ${params.model} (${usage.total_tokens || 0} tokens, ${event.durationMs}ms)`);
}

function captureOpenAIError(params: any, err: any, startTime: number, debug: boolean): void {
  writeLlmEvent({
    kind: 'llm_call', provider: 'openai', model: params.model || 'unknown',
    durationMs: round(performance.now() - startTime),
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    stream: !!params.stream, finishReason: 'error',
    temperature: params.temperature, maxTokens: params.max_tokens,
    systemPrompt: extractSystemPrompt(params.messages),
    inputPreview: extractInputPreview(params.messages),
    outputPreview: '', messageCount: params.messages?.length || 0,
    toolUse: hasToolUse(params), timestamp: Date.now(),
    error: truncate(err?.message || String(err), 200),
  });
}

// ────────────────────────────────────────────────────
// Anthropic SDK instrumentation
// ────────────────────────────────────────────────────

export function patchAnthropic(anthropicModule: any, debug: boolean): void {
  if (!anthropicModule || getattr(anthropicModule, '_trickle_llm_patched')) return;
  setattr(anthropicModule, '_trickle_llm_patched', true);

  const AnthropicClass = anthropicModule.Anthropic || anthropicModule.default;
  if (typeof AnthropicClass !== 'function') return;

  try {
    const tmpClient = new AnthropicClass({ apiKey: 'trickle-probe' });
    const MessagesClass = Object.getPrototypeOf(tmpClient.messages)?.constructor;
    if (MessagesClass && MessagesClass.prototype.create && !MessagesClass.prototype.create.__trickle_patched) {
      const origCreate = MessagesClass.prototype.create;
      MessagesClass.prototype.create = function patchedCreate(this: any, ...args: any[]) {
        const params = args[0] || {};
        const startTime = performance.now();
        const isStream = !!params.stream;
        const result = origCreate.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then((response: any) => {
            if (isStream) return handleAnthropicStream(response, params, startTime, debug);
            captureAnthropicResponse(params, response, startTime, debug);
            return response;
          }).catch((err: any) => {
            captureAnthropicError(params, err, startTime, debug);
            throw err;
          });
        }
        return result;
      };
      (MessagesClass.prototype.create as any).__trickle_patched = true;
      if (debug) console.log('[trickle/llm] Patched Anthropic SDK');
      return;
    }
  } catch (e: any) {
    if (debug) console.log('[trickle/llm] Anthropic patch probe failed:', e.message);
  }
}

function patchAnthropicClient(client: any, debug: boolean): void {
  // Patch messages.create
  if (client.messages?.create && !client.messages.create.__trickle_patched) {
    const origCreate = client.messages.create.bind(client.messages);
    client.messages.create = function patchedCreate(...args: any[]) {
      const params = args[0] || {};
      const startTime = performance.now();
      const isStream = !!params.stream;

      const result = origCreate(...args);

      if (result && typeof result.then === 'function') {
        return result.then((response: any) => {
          if (isStream) {
            return handleAnthropicStream(response, params, startTime, debug);
          }
          captureAnthropicResponse(params, response, startTime, debug);
          return response;
        }).catch((err: any) => {
          captureAnthropicError(params, err, startTime, debug);
          throw err;
        });
      }
      return result;
    };
    client.messages.create.__trickle_patched = true;
  }

  // Patch messages.stream (if it exists)
  if (client.messages?.stream && !client.messages.stream.__trickle_patched) {
    const origStream = client.messages.stream.bind(client.messages);
    client.messages.stream = function patchedStream(...args: any[]) {
      const params = args[0] || {};
      const startTime = performance.now();
      const result = origStream(...args);

      if (result && typeof result.then === 'function') {
        return result.then((stream: any) => handleAnthropicStream(stream, params, startTime, debug));
      }
      return handleAnthropicStream(result, params, startTime, debug);
    };
    client.messages.stream.__trickle_patched = true;
  }
}

function handleAnthropicStream(stream: any, params: any, startTime: number, debug: boolean): any {
  // Anthropic streams have a finalMessage() or on('message') pattern
  // Hook into the stream events to capture the final result
  if (stream && typeof stream.on === 'function') {
    stream.on('finalMessage', (message: any) => {
      captureAnthropicResponse(params, message, startTime, debug);
    });
  }
  // Also support the async iterator pattern
  if (stream && stream[Symbol.asyncIterator]) {
    const origIterator = stream[Symbol.asyncIterator].bind(stream);
    const chunks: string[] = [];
    stream[Symbol.asyncIterator] = function () {
      const iter = origIterator();
      return {
        async next() {
          const result = await iter.next();
          if (!result.done) {
            const event = result.value;
            if (event.type === 'content_block_delta' && event.delta?.text) {
              chunks.push(event.delta.text);
            }
            if (event.type === 'message_stop' || event.type === 'message_delta') {
              if (event.usage) {
                const outputText = chunks.join('');
                writeLlmEvent({
                  kind: 'llm_call', provider: 'anthropic', model: params.model || 'unknown',
                  durationMs: round(performance.now() - startTime),
                  inputTokens: event.usage.input_tokens || 0,
                  outputTokens: event.usage.output_tokens || 0,
                  totalTokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
                  estimatedCostUsd: estimateCost(params.model || '', event.usage.input_tokens || 0, event.usage.output_tokens || 0),
                  stream: true, finishReason: 'end_turn',
                  temperature: params.temperature, maxTokens: params.max_tokens,
                  systemPrompt: typeof params.system === 'string' ? truncate(params.system, 200) : undefined,
                  inputPreview: extractInputPreview(params.messages),
                  outputPreview: truncate(outputText),
                  messageCount: params.messages?.length || 0,
                  toolUse: hasToolUse(params), timestamp: Date.now(),
                });
              }
            }
          }
          return result;
        },
        return: iter.return?.bind(iter),
        throw: iter.throw?.bind(iter),
      };
    };
  }
  return stream;
}

function captureAnthropicResponse(params: any, response: any, startTime: number, debug: boolean): void {
  const usage = response.usage || {};
  const outputText = response.content?.map((c: any) => c.text || '').join('') || '';
  const event: LlmEvent = {
    kind: 'llm_call', provider: 'anthropic', model: response.model || params.model || 'unknown',
    durationMs: round(performance.now() - startTime),
    inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    estimatedCostUsd: estimateCost(response.model || params.model || '', usage.input_tokens || 0, usage.output_tokens || 0),
    stream: false, finishReason: response.stop_reason || 'unknown',
    temperature: params.temperature, maxTokens: params.max_tokens,
    systemPrompt: typeof params.system === 'string' ? truncate(params.system, 200) : undefined,
    inputPreview: extractInputPreview(params.messages),
    outputPreview: truncate(outputText),
    messageCount: params.messages?.length || 0,
    toolUse: hasToolUse(params) || response.content?.some((c: any) => c.type === 'tool_use'),
    timestamp: Date.now(),
  };
  writeLlmEvent(event);
  if (debug) console.log(`[trickle/llm] Anthropic: ${event.model} (${event.totalTokens} tokens, ${event.durationMs}ms)`);
}

function captureAnthropicError(params: any, err: any, startTime: number, debug: boolean): void {
  writeLlmEvent({
    kind: 'llm_call', provider: 'anthropic', model: params.model || 'unknown',
    durationMs: round(performance.now() - startTime),
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    stream: !!params.stream, finishReason: 'error',
    temperature: params.temperature, maxTokens: params.max_tokens,
    systemPrompt: typeof params.system === 'string' ? truncate(params.system, 200) : undefined,
    inputPreview: extractInputPreview(params.messages),
    outputPreview: '', messageCount: params.messages?.length || 0,
    toolUse: hasToolUse(params), timestamp: Date.now(),
    error: truncate(err?.message || String(err), 200),
  });
}

// ────────────────────────────────────────────────────
// Google Gemini SDK instrumentation (@google/genai)
// ────────────────────────────────────────────────────

export function patchGemini(geminiModule: any, debug: boolean): void {
  if (!geminiModule || getattr(geminiModule, '_trickle_llm_patched')) return;
  setattr(geminiModule, '_trickle_llm_patched', true);

  // @google/genai exports GoogleGenAI class
  // Usage: const ai = new GoogleGenAI({ apiKey }); ai.models.generateContent({...})
  const GoogleGenAI = geminiModule.GoogleGenAI || geminiModule.default?.GoogleGenAI;
  if (typeof GoogleGenAI !== 'function') {
    if (debug) console.log('[trickle/llm] Gemini: GoogleGenAI class not found');
    return;
  }

  try {
    // GoogleGenAI creates models as own property in the constructor.
    // Patch the GoogleGenAI constructor to wrap generateContent after creation.
    const origGoogleGenAIInit = GoogleGenAI.prototype.constructor;

    // Use a post-construction hook: after new GoogleGenAI() creates the instance
    // with models.generateContent as an own property, wrap that method.
    const tmpClient = new GoogleGenAI({ apiKey: 'trickle-probe' });
    const ModelsClass = Object.getPrototypeOf(tmpClient.models)?.constructor;

    if (ModelsClass) {
      const origModelsInit = ModelsClass;
      // Patch the Models constructor to wrap generateContent after instance creation
      const origConstruct = ModelsClass.prototype.constructor;

      // We can't replace the ES6 class constructor, so instead we use a
      // post-construction approach: hook into GoogleGenAI's prototype to
      // patch models on each new client instance.
      const origGAIProto = GoogleGenAI.prototype;
      const origInitDescriptors = Object.getOwnPropertyDescriptors(origGAIProto);

      // Define a lazy wrapper: first time models.generateContent is called,
      // install the instrumentation wrapper
      function wrapModelsInstance(models: any): void {
        if (!models || models.__trickle_patched) return;
        models.__trickle_patched = true;

        if (typeof models.generateContent === 'function') {
          const origGenerate = models.generateContent.bind(models);
          models.generateContent = function patchedGenerateContent(...args: any[]) {
            const params = args[0] || {};
            const startTime = performance.now();
            const result = origGenerate(...args);
            if (result && typeof result.then === 'function') {
              return result.then((response: any) => {
                captureGeminiResponse(params, response, startTime, false, debug);
                return response;
              }).catch((err: any) => {
                captureGeminiError(params, err, startTime, debug);
                throw err;
              });
            }
            return result;
          };
        }

        if (typeof models.generateContentStream === 'function') {
          const origStream = models.generateContentStream.bind(models);
          models.generateContentStream = function patchedStream(...args: any[]) {
            const params = args[0] || {};
            const startTime = performance.now();
            const result = origStream(...args);
            if (result && typeof result.then === 'function') {
              return result.then((stream: any) => handleGeminiStream(stream, params, startTime, debug));
            }
            return result;
          };
        }
      }

      // Intercept the GoogleGenAI constructor to patch each instance's models
      // Since we can't replace ES6 class constructors, we use a Proxy
      const proxyHandler: ProxyHandler<any> = {
        construct(target: any, args: any[], newTarget: any): object {
          const instance = Reflect.construct(target, args, newTarget) as any;
          if (instance.models) wrapModelsInstance(instance.models);
          return instance as object;
        }
      };
      const ProxiedGoogleGenAI = new Proxy(GoogleGenAI, proxyHandler);

      // Replace on the module (try both export styles)
      try { geminiModule.GoogleGenAI = ProxiedGoogleGenAI; } catch {}
      try { if (geminiModule.default?.GoogleGenAI) geminiModule.default.GoogleGenAI = ProxiedGoogleGenAI; } catch {}

      // Also patch the already-created probe instance (in case someone imported before us)
      // This is a no-op since the probe is discarded.

      if (debug) console.log('[trickle/llm] Patched Gemini SDK');
    }
  } catch (e: any) {
    if (debug) console.log('[trickle/llm] Gemini patch probe failed:', e.message);
  }
}

function captureGeminiResponse(params: any, response: any, startTime: number, isStream: boolean, debug: boolean): void {
  const usage = response.usageMetadata || {};
  const model = params.model || 'gemini-unknown';
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const totalTokens = usage.totalTokenCount || inputTokens + outputTokens;

  let outputText = '';
  let finishReason = 'unknown';
  try {
    outputText = response.text || '';
  } catch {
    const candidates = response.candidates || [];
    if (candidates[0]?.content?.parts?.[0]?.text) {
      outputText = candidates[0].content.parts[0].text;
    }
  }
  const candidates = response.candidates || [];
  if (candidates[0]?.finishReason) finishReason = candidates[0].finishReason;

  // Extract input preview from contents
  let inputPreview = '';
  const contents = params.contents;
  if (typeof contents === 'string') {
    inputPreview = truncate(contents);
  } else if (Array.isArray(contents)) {
    const last = contents[contents.length - 1];
    if (typeof last === 'string') inputPreview = truncate(last);
    else if (last?.parts?.[0]?.text) inputPreview = truncate(last.parts[0].text);
  }

  const event: LlmEvent = {
    kind: 'llm_call', provider: 'gemini', model,
    durationMs: round(performance.now() - startTime),
    inputTokens, outputTokens, totalTokens,
    estimatedCostUsd: estimateCost(model, inputTokens, outputTokens),
    stream: isStream, finishReason,
    temperature: params.config?.temperature,
    maxTokens: params.config?.maxOutputTokens,
    systemPrompt: typeof params.config?.systemInstruction === 'string'
      ? truncate(params.config.systemInstruction, 200) : undefined,
    inputPreview, outputPreview: truncate(outputText),
    messageCount: Array.isArray(contents) ? contents.length : (contents ? 1 : 0),
    toolUse: !!(params.config?.tools?.length || params.tools?.length),
    timestamp: Date.now(),
  };
  writeLlmEvent(event);
  if (debug) console.log(`[trickle/llm] Gemini: ${model} (${totalTokens} tokens, ${event.durationMs}ms)`);
}

function captureGeminiError(params: any, err: any, startTime: number, debug: boolean): void {
  const model = params.model || 'gemini-unknown';
  writeLlmEvent({
    kind: 'llm_call', provider: 'gemini', model,
    durationMs: round(performance.now() - startTime),
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    stream: false, finishReason: 'error',
    temperature: params.config?.temperature,
    maxTokens: params.config?.maxOutputTokens,
    inputPreview: typeof params.contents === 'string' ? truncate(params.contents) : '',
    outputPreview: '', messageCount: 0,
    toolUse: false, timestamp: Date.now(),
    error: truncate(err?.message || String(err), 200),
  });
}

async function handleGeminiStream(stream: any, params: any, startTime: number, debug: boolean): Promise<any> {
  if (!stream || !stream[Symbol.asyncIterator]) return stream;

  const chunks: string[] = [];
  const origIterator = stream[Symbol.asyncIterator].bind(stream);
  let lastUsage: any = null;

  stream[Symbol.asyncIterator] = function () {
    const iter = origIterator();
    return {
      async next() {
        const result = await iter.next();
        if (!result.done) {
          const chunk = result.value;
          try { if (chunk.text) chunks.push(chunk.text); } catch {}
          if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
        } else {
          // Stream finished
          const model = params.model || 'gemini-unknown';
          const inputTokens = lastUsage?.promptTokenCount || 0;
          const outputTokens = lastUsage?.candidatesTokenCount || 0;
          writeLlmEvent({
            kind: 'llm_call', provider: 'gemini', model,
            durationMs: round(performance.now() - startTime),
            inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
            estimatedCostUsd: estimateCost(model, inputTokens, outputTokens),
            stream: true, finishReason: 'stop',
            temperature: params.config?.temperature,
            maxTokens: params.config?.maxOutputTokens,
            inputPreview: typeof params.contents === 'string' ? truncate(params.contents) : '',
            outputPreview: truncate(chunks.join('')),
            messageCount: 0, toolUse: false, timestamp: Date.now(),
          });
          if (debug) console.log(`[trickle/llm] Gemini stream: ${model} (${outputTokens} tokens)`);
        }
        return result;
      },
      return: iter.return?.bind(iter),
      throw: iter.throw?.bind(iter),
    };
  };
  return stream;
}

// ────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function getattr(obj: any, key: string): boolean {
  try { return !!obj[key]; } catch { return false; }
}

function setattr(obj: any, key: string, val: any): void {
  try { obj[key] = val; } catch {}
}

/**
 * Initialize the LLM observer — clears previous data file.
 */
export function initLlmObserver(): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  llmFile = path.join(dir, 'llm.jsonl');
  try { fs.writeFileSync(llmFile, ''); } catch {}
  eventCount = 0;
}
