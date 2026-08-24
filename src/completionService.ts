import { requestUrl } from "obsidian";
import * as nodeHttps from "https";
import * as nodeHttp from "http";
import {
  GhostwriterSettings,
  MessageRole,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_COT_TEMPLATE,
  DEFAULT_COT_TRIGGER,
} from "./settings";

export interface CompletionParams {
  prefix: string;
  suffix: string;
  summary: string;
  title: string;
}

export interface CacheUsage {
  promptTokens: number;
  hitTokens: number;
  missTokens: number;
}

export interface CompletionCallbacks {
  onThinkingDelta?: (delta: string) => void;
  onCompletionDelta: (delta: string) => void;
  onDone: (completion: string, thinking: string, cacheUsage?: CacheUsage) => void;
  onError: (err: Error) => void;
}

interface ChatMessage {
  role: MessageRole;
  content: string;
}

export function fillTemplate(
  template: string,
  vars: { summary: string; extra: string; prefix: string; suffix: string; maxWords: number; title: string }
): string {
  const safe = (s: string) => s ?? "";
  return template
    .replace(/\{summary\}/g, safe(vars.summary))
    .replace(/\{extra\}/g, safe(vars.extra))
    .replace(/\{prefix\}/g, safe(vars.prefix))
    .replace(/\{suffix\}/g, safe(vars.suffix))
    .replace(/\{max_words\}/g, String(vars.maxWords))
    .replace(/\{title\}/g, safe(vars.title));
}

export function buildMessages(p: CompletionParams, settings: GhostwriterSettings): ChatMessage[] {
  const summary = p.summary?.trim() ?? "";
  const extra = settings.extraPrompt?.trim() ?? "";
  const title = p.title?.trim() ?? "";
  const tpl = settings.promptTemplate && settings.promptTemplate.trim()
    ? settings.promptTemplate
    : DEFAULT_PROMPT_TEMPLATE;
  const promptContent = fillTemplate(tpl, {
    summary,
    extra,
    prefix: p.prefix,
    suffix: p.suffix,
    maxWords: settings.maxWords,
    title,
  });

  const messages: ChatMessage[] = [];

  const systemContent = fillTemplate(settings.systemPrompt, {
    summary: "",
    extra: "",
    prefix: "",
    suffix: "",
    maxWords: settings.maxWords,
    title,
  });
  if (systemContent.trim()) {
    messages.push({ role: "system", content: systemContent });
  }

  if (settings.cotEnabled) {
    const cotTpl = settings.cotTemplate && settings.cotTemplate.trim()
      ? settings.cotTemplate
      : DEFAULT_COT_TEMPLATE;
    if (cotTpl.trim()) {
      messages.push({ role: settings.cotTemplateRole, content: cotTpl });
    }
  }

  messages.push({ role: settings.promptTemplateRole, content: promptContent });

  if (settings.cotEnabled) {
    const trigger = settings.cotTrigger && settings.cotTrigger.trim()
      ? settings.cotTrigger.trim()
      : DEFAULT_COT_TRIGGER;
    if (trigger.trim()) {
      messages.push({ role: settings.cotTriggerRole, content: trigger });
    }
  }

  return mergeAdjacent(messages);
}

function mergeAdjacent(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

const COMPLETION_OPEN = "<completion>";
const COMPLETION_CLOSE = "</completion>";
const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

function streamPrefillThinking(settings: GhostwriterSettings): string {
  if (!settings.cotEnabled) return "";
  if (settings.cotTriggerRole !== "assistant") return "";
  const t = (settings.cotTrigger ?? "").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  const idx = lower.lastIndexOf(THINKING_OPEN);
  if (idx < 0) return "";
  return t.slice(idx);
}

export function extractThinking(full: string): string {
  const start = full.lastIndexOf(THINKING_OPEN);
  if (start < 0) return "";
  const afterOpen = full.slice(start + THINKING_OPEN.length);
  const end = afterOpen.indexOf(THINKING_CLOSE);
  if (end >= 0) return afterOpen.slice(0, end);
  return afterOpen;
}

function trimOuter(s: string): string {
  return s.replace(/^[\s\r\n]+/, "").replace(/[\s\r\n]+$/, "");
}

export function extractCompletion(full: string): string {
  const start = full.lastIndexOf(COMPLETION_OPEN);
  if (start < 0) return trimOuter(full);
  const afterOpen = full.slice(start + COMPLETION_OPEN.length);
  const end = afterOpen.lastIndexOf(COMPLETION_CLOSE);
  const raw = end >= 0 ? afterOpen.slice(0, end) : afterOpen;
  return trimOuter(raw);
}

export function extractCompletionStrict(full: string): string {
  const start = full.lastIndexOf(COMPLETION_OPEN);
  if (start < 0) return "";
  const afterOpen = full.slice(start + COMPLETION_OPEN.length);
  const end = afterOpen.lastIndexOf(COMPLETION_CLOSE);
  return end >= 0 ? afterOpen.slice(0, end) : afterOpen;
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/")) base = base.slice(0, -1);
  if (path.startsWith("/")) path = path.slice(1);
  return `${base}/${path}`;
}

interface SSEEvent {
  done: boolean;
  delta?: string;
  cacheUsage?: CacheUsage;
}

function asTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function parseCacheUsage(raw: unknown): CacheUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const hit = asTokenCount(usage.prompt_cache_hit_tokens);
  const miss = asTokenCount(usage.prompt_cache_miss_tokens);
  const prompt = asTokenCount(usage.prompt_tokens);
  if (hit === null && miss === null) return undefined;
  const hitTokens = hit ?? 0;
  const missTokens = miss ?? Math.max(0, (prompt ?? hitTokens) - hitTokens);
  return {
    promptTokens: prompt ?? hitTokens + missTokens,
    hitTokens,
    missTokens,
  };
}

export function formatCacheUsage(usage: CacheUsage): string {
  const accountedTokens = usage.hitTokens + usage.missTokens;
  const promptTokens = usage.promptTokens > 0 ? usage.promptTokens : accountedTokens;
  const rate = promptTokens > 0 ? usage.hitTokens / promptTokens : 0;
  return `${(rate * 100).toFixed(1)}% hit (${usage.hitTokens.toLocaleString()}/${promptTokens.toLocaleString()} prompt tokens)`;
}

function parseSSELine(line: string): SSEEvent | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return { done: true };
  try {
    const json = JSON.parse(data);
    const delta = json?.choices?.[0]?.delta?.content;
    return {
      done: false,
      delta: typeof delta === "string" ? delta : undefined,
      cacheUsage: parseCacheUsage(json?.usage),
    };
  } catch {
    return null;
  }
}

function parseSSEBody(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const event = parseSSELine(line);
    if (event?.done) break;
    if (event) events.push(event);
  }
  return events;
}

function ingestSSELine(line: string, state: StreamState, cot: boolean, cb: CompletionCallbacks): boolean {
  const event = parseSSELine(line.trim());
  if (!event) return false;
  if (event.done) return true;
  if (event.cacheUsage) state.cacheUsage = event.cacheUsage;
  if (event.delta) ingestDelta(state, event.delta, cot, cb);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface StreamState {
  full: string;
  prevThinking: string;
  prevCompletion: string;
  leadingStripped: boolean;
  tailBuffer: string;
  cacheUsage?: CacheUsage;
}

const TRAILING_NL = /[\r\n]+$/;

function ingestDelta(state: StreamState, delta: string, cot: boolean, cb: CompletionCallbacks): void {
  state.full += delta;
  if (!cot) {
    let d = delta;
    if (!state.leadingStripped) {
      d = d.replace(/^[\s\r\n]+/, "");
      if (d) state.leadingStripped = true;
    }
    flushTrailingSafe(state, d, cb);
    state.prevCompletion += delta;
    return;
  }

  const hasCompletion = state.full.includes(COMPLETION_OPEN);
  const hasThinking = state.full.includes(THINKING_OPEN);

  if (!hasCompletion && !hasThinking) {
    let d = delta;
    if (!state.leadingStripped) {
      d = d.replace(/^[\s\r\n]+/, "");
      if (d) state.leadingStripped = true;
    }
    flushTrailingSafe(state, d, cb);
    state.prevCompletion += delta;
    return;
  }

  if (hasThinking) {
    const curThinking = extractThinking(state.full);
    if (curThinking.length > state.prevThinking.length) {
      cb.onThinkingDelta?.(curThinking.slice(state.prevThinking.length));
      state.prevThinking = curThinking;
    }
  }

  if (!hasCompletion) return;

  let curCompletion = extractCompletionStrict(state.full);
  curCompletion = curCompletion.replace(/^[\s\r\n]+/, "");
  if (!state.leadingStripped && curCompletion) {
    state.leadingStripped = true;
  }
  if (curCompletion.length > state.prevCompletion.length) {
    const toEmit = curCompletion.slice(state.prevCompletion.length);
    state.prevCompletion = curCompletion;
    flushTrailingSafe(state, toEmit, cb);
  }
}

function flushTrailingSafe(
  state: StreamState,
  chunk: string,
  cb: CompletionCallbacks
): void {
  if (!chunk) return;
  const combined = state.tailBuffer + chunk;
  state.tailBuffer = "";
  let lastNon = combined.length;
  while (lastNon > 0 && /[\r\n]/.test(combined[lastNon - 1])) lastNon--;
  const safe = combined.slice(0, lastNon);
  const tail = combined.slice(lastNon);
  if (safe) cb.onCompletionDelta?.(safe);
  if (tail) state.tailBuffer = tail;
}

export class CompletionService {
  constructor(private settings: () => GhostwriterSettings) {}

  private headers(): Record<string, string> {
    const s = this.settings();
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (s.apiKey) h["Authorization"] = `Bearer ${s.apiKey}`;
    return h;
  }

  private body(params: CompletionParams, stream: boolean): string {
    return JSON.stringify(this.buildPayload(params, stream));
  }

  buildPayload(params: CompletionParams, stream: boolean): {
    model: string;
    messages: ChatMessage[];
    max_tokens: number;
    temperature: number;
    stream: boolean;
    stream_options?: { include_usage: boolean };
  } {
    const s = this.settings();
    return {
      model: s.model,
      messages: buildMessages(params, s),
      max_tokens: s.maxTokens,
      temperature: s.temperature,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  async complete(
    params: CompletionParams,
    cb: CompletionCallbacks,
    signal: AbortSignal
  ): Promise<void> {
    const s = this.settings();
    const url = joinUrl(s.apiBaseUrl, "chat/completions");
    try {
      if (s.stream) {
        const nodeOk = await this.completeStreamingNode(url, params, cb, signal);
        if (nodeOk) return;
        if (signal.aborted) return;
        const fetchOk = await this.completeStreamingFetch(url, params, cb, signal);
        if (fetchOk) return;
        if (signal.aborted) return;
        await this.completeStreamingRequestUrl(url, params, cb, signal);
      } else {
        await this.completeOneShot(url, params, cb, signal);
      }
    } catch (err) {
      if (signal.aborted) return;
      if ((err as Error).name === "AbortError") return;
      cb.onError(err as Error);
    }
  }

  private async completeOneShot(
    url: string,
    params: CompletionParams,
    cb: CompletionCallbacks,
    signal: AbortSignal
  ): Promise<void> {
    const cot = this.settings().cotEnabled;
    const resp = await this.request(url, this.body(params, false), signal);
    if (signal.aborted) return;
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`API ${resp.status}: ${resp.text || "request failed"}`);
    }
    let content = "";
    let cacheUsage: CacheUsage | undefined;
    try {
      const json = JSON.parse(resp.text);
      content = json?.choices?.[0]?.message?.content ?? "";
      cacheUsage = parseCacheUsage(json?.usage);
    } catch {
      content = "";
    }
    const prefilled = cot ? streamPrefillThinking(this.settings()) : "";
    const fullContent = prefilled + content;
    const thinking = cot ? extractThinking(fullContent) : "";
    let completion = cot ? extractCompletion(fullContent) : content.replace(/^[\s\r\n]+/, "");
    completion = completion.replace(/^[\s\r\n]+/, "");
    if (thinking) cb.onThinkingDelta?.(thinking);
    if (completion) cb.onCompletionDelta?.(completion);
    cb.onDone(completion, thinking, cacheUsage);
  }

  private async completeStreamingNode(
    url: string,
    params: CompletionParams,
    cb: CompletionCallbacks,
    signal: AbortSignal
  ): Promise<boolean> {
    const cot = this.settings().cotEnabled;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const lib = parsed.protocol === "https:" ? nodeHttps : nodeHttp;
    if (!lib) return false;
    const body = this.body(params, true);
    const headers = {
      ...this.headers(),
      Accept: "text/event-stream",
      "Accept-Encoding": "identity",
      "Content-Length": String(new TextEncoder().encode(body).length),
    };

    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      let resolved = false;
      const done = (r: boolean) => {
        if (resolved) return;
        resolved = true;
        resolve(r);
      };

      const prefilled = streamPrefillThinking(this.settings());
      const state: StreamState = {
        full: prefilled,
        prevThinking: "",
        prevCompletion: "",
        leadingStripped: false,
        tailBuffer: "",
        cacheUsage: undefined,
      };
      let buffer = "";
      let errorBody = "";

      const options: nodeHttps.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers,
      };

      let req: nodeHttp.ClientRequest;
      try {
        req = lib.request(options, (res) => {
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          res.setEncoding("utf-8");

          res.on("data", (chunk: string) => {
            if (signal.aborted) {
              req.destroy();
              return;
            }
            if (!ok) {
              errorBody += chunk;
              return;
            }
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line) continue;
              if (ingestSSELine(line, state, cot, cb)) {
                buffer = "";
                break;
              }
            }
          });

          res.on("end", () => {
            if (signal.aborted) {
              done(false);
              return;
            }
            if (!ok) {
              cb.onError(new Error(`API ${status}: ${errorBody || "request failed"}`));
              done(true);
              return;
            }
            if (buffer.trim()) ingestSSELine(buffer, state, cot, cb);
            cb.onDone(
              cot ? extractCompletion(state.full) : trimOuter(state.full),
              cot ? extractThinking(state.full) : "",
              state.cacheUsage
            );
            done(true);
          });

          res.on("error", (err: Error) => {
            if (signal.aborted) {
              done(false);
              return;
            }
            cb.onError(err);
            done(true);
          });
        });
      } catch {
        done(false);
        return;
      }

      req.on("error", (err: Error) => {
        if (signal.aborted) {
          done(false);
          return;
        }
        done(false);
      });

      signal.addEventListener("abort", () => {
        req.destroy();
        done(false);
      }, { once: true });

      req.write(body);
      req.end();
    });
  }

  private async completeStreamingFetch(
    url: string,
    params: CompletionParams,
    cb: CompletionCallbacks,
    signal: AbortSignal
  ): Promise<boolean> {
    const cot = this.settings().cotEnabled;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...this.headers(), Accept: "text/event-stream" },
        body: this.body(params, true),
        signal,
      });
      if (!resp.ok || !resp.body) {
        return false;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      const prefilledFetch = streamPrefillThinking(this.settings());
       const state: StreamState = {
         full: prefilledFetch,
         prevThinking: "",
         prevCompletion: "",
         leadingStripped: false,
         tailBuffer: "",
         cacheUsage: undefined,
       };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
           const line = buffer.slice(0, idx).trim();
           buffer = buffer.slice(idx + 1);
           if (!line) continue;
           if (ingestSSELine(line, state, cot, cb)) {
             buffer = "";
             break;
           }
         }
       }
       if (buffer.trim()) ingestSSELine(buffer, state, cot, cb);
       cb.onDone(cot ? extractCompletion(state.full) : trimOuter(state.full), cot ? extractThinking(state.full) : "", state.cacheUsage);
      return true;
    } catch (err) {
      if (signal.aborted) return false;
      return false;
    }
  }

  private async completeStreamingRequestUrl(
    url: string,
    params: CompletionParams,
    cb: CompletionCallbacks,
    signal: AbortSignal
  ): Promise<void> {
    const cot = this.settings().cotEnabled;
    const resp = await this.request(url, this.body(params, true), signal);
    if (signal.aborted) return;
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`API ${resp.status}: ${resp.text || "request failed"}`);
    }
    const deltas = parseSSEBody(resp.text);
    const prefilledRu = streamPrefillThinking(this.settings());
    const state: StreamState = {
      full: prefilledRu,
      prevThinking: "",
      prevCompletion: "",
      leadingStripped: false,
      tailBuffer: "",
      cacheUsage: undefined,
    };
    for (const event of deltas) {
      if (signal.aborted) return;
      if (event.cacheUsage) state.cacheUsage = event.cacheUsage;
      if (event.delta) ingestDelta(state, event.delta, cot, cb);
      await sleep(15);
    }
    cb.onDone(cot ? extractCompletion(state.full) : trimOuter(state.full), cot ? extractThinking(state.full) : "", state.cacheUsage);
  }

  private async request(
    url: string,
    body: string,
    signal: AbortSignal
  ): Promise<{ status: number; text: string }> {
    const headers = this.headers();
    if (this.settings().stream) headers["Accept"] = "text/event-stream";

    const reqPromise = requestUrl({
      url,
      method: "POST",
      headers,
      contentType: "application/json",
      body,
      throw: false,
    });

    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      reqPromise.then(
        (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ status: r.status, text: r.text });
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  }
}
