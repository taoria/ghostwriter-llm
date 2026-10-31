export type MessageRole = "user" | "assistant" | "system";

/**
 * How the text before the cursor is assembled:
 * - "window": legacy fixed prefix/suffix window (default for notes).
 * - "full": the whole text before the cursor (outline / structure design).
 * - "in-note": detect `[Summary]` / `[摘要]` blocks; the summarized text is
 *   replaced by the summaries and sent immediately before the unsummarized tail
 *   (novels). With no markers it falls back to the full preceding text.
 */
export type ContextMode = "window" | "full" | "in-note";

export interface ProviderProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * A note pinned into every completion prompt ("global context"). The note does
 * not have to be the current one. Its content is rendered according to the
 * context strategy: "follow" uses the active mode, otherwise the item overrides.
 */
export interface HookItem {
  id: string;
  /** Vault-relative path of the injected note. */
  path: string;
  enabled: boolean;
  contextMode: "follow" | ContextMode;
  /** Character cap for this note; 0 = mode default (prefixChars, or the whole note in "full"). */
  maxChars: number;
}

/**
 * A named writing preset. Modes own the prompt/context/recall/CoT/summary-sending
 * settings; providers, summary file generation and UI options stay global.
 */
export interface ModeProfile {
  id: string;
  name: string;
  systemPrompt: string;
  promptTemplate: string;
  extraPrompt: string;
  promptTemplateRole: MessageRole;
  cotEnabled: boolean;
  cotTemplate: string;
  cotTrigger: string;
  cotTemplateRole: MessageRole;
  cotTriggerRole: MessageRole;
  maxWords: number;
  temperature: number;
  prefixChars: number;
  suffixChars: number;
  recallLevel: number;
  adjacentDepth: number;
  adjacentMaxNotes: number;
  adjacentNoteChars: number;
  adjacentTotalChars: number;
  summaryEnabled: boolean;
  summaryModel: string;
  summaryMaxTokens: number;
  summaryMaxWords: number;
  summaryTemperature: number;
  summaryInputChars: number;
  contextMode: ContextMode;
  inNoteSummaryPrompt: string;
}

/** Fields that belong to the active mode; kept in sync with the top-level settings on every save. */
export const MODE_KEYS = [
  "systemPrompt",
  "promptTemplate",
  "extraPrompt",
  "promptTemplateRole",
  "cotEnabled",
  "cotTemplate",
  "cotTrigger",
  "cotTemplateRole",
  "cotTriggerRole",
  "maxWords",
  "temperature",
  "prefixChars",
  "suffixChars",
  "recallLevel",
  "adjacentDepth",
  "adjacentMaxNotes",
  "adjacentNoteChars",
  "adjacentTotalChars",
  "summaryEnabled",
  "summaryModel",
  "summaryMaxTokens",
  "summaryMaxWords",
  "summaryTemperature",
  "summaryInputChars",
  "contextMode",
  "inNoteSummaryPrompt",
] as const satisfies readonly (keyof ModeProfile)[];

export interface GhostwriterSettings {
  providers: ProviderProfile[];
  activeProviderId: string;
  /** All writing presets. */
  modes: ModeProfile[];
  /** Id of the mode whose values are mirrored into the top-level fields below. */
  activeModeId: string;
  /** Language used for built-in prompt defaults and "restore defaults". */
  promptLanguage: PromptLanguage;
  maxTokens: number;
  maxWords: number;
  temperature: number;
  requestTimeoutSec: number;
  /** Extra HTTP headers sent with every provider request, one "Name: Value" per line; overrides the defaults. */
  customHeaders: string;
  systemPrompt: string;
  promptTemplate: string;
  extraPrompt: string;
  prefixChars: number;
  suffixChars: number;
  summary: string;
  summaryEnabled: boolean;
  summaryFolder: string;
  summaryModel: string;
  summaryMaxTokens: number;
  summaryMaxWords: number;
  summaryTemperature: number;
  summaryInputChars: number;
  summaryScanLimit: number;
  /** Disabled summary keys: entries may be a source-note path or a summary-file path; both are checked at injection time. */
  disabledSummaryFiles: string[];
  recallLevel: number;
  adjacentDepth: number;
  adjacentMaxNotes: number;
  adjacentNoteChars: number;
  adjacentTotalChars: number;
  stream: boolean;
  cotEnabled: boolean;
  cotTemplate: string;
  cotTemplateRole: MessageRole;
  cotTrigger: string;
  cotTriggerRole: MessageRole;
  promptTemplateRole: MessageRole;
  previewMode: boolean;
  peekCoT: boolean;
  /** Show the fully assembled prompt in a confirmation dialog before sending the request. */
  promptPreviewBeforeSend: boolean;
  /** Master switch for notes pinned into every prompt. */
  globalHooksEnabled: boolean;
  globalHooks: HookItem[];
  contextMode: ContextMode;
  inNoteSummaryPrompt: string;
  acceptKey: string;
  dismissKey: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an inline writing-completion engine for an Obsidian note.
Continue the user's writing naturally from the cursor position, preserving the existing tone, language, and formatting (Markdown).
Rules:
- Output ONLY the continuation text that belongs at the cursor. No preamble, no quotes, no "Here is...".
- Do not repeat content that already precedes the cursor.
- Be concise and coherent. Stop at a natural boundary (end of sentence/paragraph) unless more is clearly needed.
- Hard limit: the continuation MUST NOT exceed {max_words} words (CJK characters counted individually, Latin words counted as words). Stopping mid-sentence at the limit is acceptable.
- If a "summary" is provided, treat it as high-level context; do not recite it.
- Wrap the final continuation in <completion></completion>. Only the content inside <completion> will be used. Do not output anything else.`;

export const DEFAULT_COT_TEMPLATE = `First think briefly inside <thinking></thinking> about how to continue (tone, cohesion, key points), then provide the final continuation inside <completion></completion>.`;

export const DEFAULT_COT_TRIGGER = `(Optional reasoning) You may briefly plan inside <thinking></thinking> before writing the final continuation inside <completion></completion>. Keep the thinking short. Only the content inside <completion> will be used.`;

export const DEFAULT_PROMPT_TEMPLATE = `[Note title]
{title}

[Note summary]
{summary}

[Global context]
{hooks}

[Extra instructions]
{extra}

[Text BEFORE cursor]
{prefix}
<<<CURSOR>>>
[Text AFTER cursor]
{suffix}

Continue the writing at <<<CURSOR>>> inside <completion>. At most {max_words} words. Output only the continuation.`;

export const DEFAULT_SYSTEM_PROMPT_ZH = `你是一个 Obsidian 笔记的内联写作补全引擎。
从光标所在位置自然地续写用户的文字，保持原有的语气、语言和格式（Markdown）。
规则：
- 只输出应出现在光标处的续写文本。不要前言、不要引号、不要"这是..."之类的说明。
- 不要重复光标之前已有的内容。
- 简洁连贯。除非明显需要更多内容，否则在自然边界（句末/段末）停止。
- 硬性限制：续写不得超过 {max_words} 个字（中文按字符计，英文按单词计）。达到上限时可在句中停止。
- 如果提供了"摘要"，将其作为高层背景使用，但不要复述它。
- 将最终续写内容放入 <completion></completion> 内。只有 <completion> 内的内容会被采纳，不要输出其他任何内容。`;

export const DEFAULT_COT_TEMPLATE_ZH = `请先在 <thinking></thinking> 中简要思考应如何续写（语气、衔接、要点），然后在 <completion></completion> 中给出最终续写内容。`;

export const DEFAULT_COT_TRIGGER_ZH = `（可选推理）你可以先在 <thinking></thinking> 中简要规划，再在 <completion></completion> 中给出最终续写。思考保持简短。只有 <completion> 内的内容会被采纳。`;

export const DEFAULT_PROMPT_TEMPLATE_ZH = `[笔记标题]
{title}

[笔记摘要]
{summary}

[全局上下文]
{hooks}

[额外指令]
{extra}

[光标之前的文本]
{prefix}
<<<光标>>>
[光标之后的文本]
{suffix}

请在 <<<光标>>> 处续写，写入 <completion> 内。最多 {max_words} 字。只输出续写内容。`;

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = `You are a note-summarization engine for Obsidian.
Write a concise, faithful summary of the user's note. Rules:
- Output ONLY the summary text. No preamble, no labels, no headers, no quotes.
- Capture the main topic, key points, and tone. Skip filler.
- Hard limit: at most {max_words} words (CJK characters counted individually, Latin words as words). Stopping mid-sentence is acceptable.
- Match the language of the note (write the summary in the same language).`;

export type PromptLanguage = "en" | "zh";

export const DEFAULT_NOVEL_SUMMARY_PROMPT = `你是小说的情节摘要引擎。请为给定段落生成一段情节摘要。
规则：
- 只记录客观发生的事件与剧情：谁、在哪、做了什么、发生了什么转折、关键对话与信息。
- 禁止升华：不要归纳主题、寓意、情感基调或写作手法，不要评价，不要建议。
- 不遗漏关键伏笔、人物动机变化与新出场人物。
- 摘要不超过 {max_words} 字，使用与原文相同的语言。
- 只输出摘要文本本身，不要任何标题、前后缀或解释。`;

export interface PromptBundle {
  systemPrompt: string;
  promptTemplate: string;
  cotTemplate: string;
  cotTrigger: string;
  cotTemplateRole: MessageRole;
  cotTriggerRole: MessageRole;
  promptTemplateRole: MessageRole;
  extraPrompt: string;
}

export function defaultPromptsFor(lang: PromptLanguage): PromptBundle {
  if (lang === "zh") {
    return {
      systemPrompt: DEFAULT_SYSTEM_PROMPT_ZH,
      promptTemplate: DEFAULT_PROMPT_TEMPLATE_ZH,
      cotTemplate: DEFAULT_COT_TEMPLATE_ZH,
      cotTrigger: DEFAULT_COT_TRIGGER_ZH,
      cotTemplateRole: "user",
      cotTriggerRole: "system",
      promptTemplateRole: "user",
      extraPrompt: "",
    };
  }
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    cotTemplate: DEFAULT_COT_TEMPLATE,
    cotTrigger: DEFAULT_COT_TRIGGER,
    cotTemplateRole: "user",
    cotTriggerRole: "system",
    promptTemplateRole: "user",
    extraPrompt: "",
  };
}

export const PROMPT_BUNDLE_VERSION = 1;
export const PROMPT_BUNDLE_MAGIC = "ghostwriter-llm-prompts";

export const DEFAULT_NOVEL_SYSTEM_PROMPT = `You are a fiction continuation engine for an Obsidian novel note.
Continue the story from the cursor, preserving the narrator's voice, tense, point of view, established characters, and world details.
Rules:
- Output ONLY the continuation text that belongs at the cursor. No preamble, no quotes, no analysis.
- Do not repeat what already precedes the cursor.
- Stay consistent with the plot summaries and prior text; never contradict established facts.
- Advance the story with concrete action, dialogue, or description; do not summarize.
- Keep the prose style and formatting (Markdown) of the existing text.
- Hard limit: the continuation MUST NOT exceed {max_words} words (CJK characters counted individually, Latin words as words).
- Wrap the final continuation in <completion></completion>. Only the content inside <completion> is used. Do not output anything else.`;

export const DEFAULT_NOVEL_PROMPT_TEMPLATE = `[Note title]
{title}

[Plot summaries of earlier text]
{summary}

[Extra instructions]
{extra}

[Text BEFORE cursor]
{prefix}
<<<CURSOR>>>
[Text AFTER cursor]
{suffix}

Continue the story at <<<CURSOR>>> inside <completion>. At most {max_words} words. Output only the continuation.`;

export const DEFAULT_OUTLINE_SYSTEM_PROMPT = `You are an outline and structure design engine for an Obsidian note.
Design or extend outlines, plot beats, chapter structures, or argument skeletons at the cursor.
Rules:
- Output ONLY the outline content that belongs at the cursor (Markdown lists, headings, beats). No preamble, no commentary.
- Keep the existing structure, numbering, terminology, and tone; continue the pattern.
- Be concrete and ordered; every item must be a usable beat or point, not vague filler.
- Hard limit: at most {max_words} words (CJK characters counted individually, Latin words as words).
- Wrap the final outline in <completion></completion>. Only the content inside <completion> is used. Do not output anything else.`;

export const DEFAULT_OUTLINE_PROMPT_TEMPLATE = `[Note title]
{title}

[Existing notes / background]
{summary}

[Global context]
{hooks}

[Extra instructions]
{extra}

[Outline BEFORE cursor]
{prefix}
<<<CURSOR>>>
[Outline AFTER cursor]
{suffix}

Continue the outline at <<<CURSOR>>> inside <completion>. At most {max_words} words. Output only the new outline items.`;

export const DEFAULT_NOVEL_SYSTEM_PROMPT_ZH = `你是一个 Obsidian 笔记的内联写作补全引擎。

当前模式:Novel Mode

从光标所在位置自然地续写用户的文字，保持原有的语气、语言和格式（Markdown）。
规则：
- 只输出应出现在光标处的续写文本。不要前言、不要引号、不要"这是..."之类的说明。
- 不要重复光标之前已有的内容。
- 简洁连贯。除非明显需要更多内容，否则在自然边界（句末/段末）停止。
- 硬性限制：续写不得超过 {max_words} 个字（中文按字符计，英文按单词计）。达到上限时可在句中停止。
- 如果提供了"摘要"，将其作为高层背景使用，但不要复述它。
- 先在 <thinking>...</thinking> 中简要推理，再在 <completion></completion> 中给出最终续写。只有 <completion> 内的内容会被采纳。
<thinking_format>
1.文章的基调和氛围?
2.<<<光标>>>在哪?
3.应该写什么?
4.要注意哪些规则?
5.每个角色的认知边界，他们知道什么，不该知道什么?
</thinking_format>`;

export const DEFAULT_NOVEL_PROMPT_TEMPLATE_ZH = `[笔记标题]
{title}

[笔记摘要]
{summary}

[全局上下文]
{hooks}

[额外指令]
{extra}

[光标之前的文本]
{prefix}

<<<光标>>> 请续写，写入 <completion> 内。最多 {max_words} 字。只输出续写内容。

[光标之后的文本]

{suffix}

[回复格式]
<thinking>
</thinking>
<completion>
</completion>`;

export const DEFAULT_OUTLINE_SYSTEM_PROMPT_ZH = `你是 Obsidian 笔记的大纲与结构设计引擎。
在光标处设计或续写大纲、剧情节点、章节结构或论证骨架。
规则：
- 只输出应出现在光标处的大纲内容（Markdown 列表、标题、节点）。不要前言、不要点评。
- 保持已有的结构、编号、术语与语气，延续同样的模式。
- 条目必须具体、有序、可用，不要空泛填充。
- 硬性限制：续写不得超过 {max_words} 个字（中文按字符计，英文按单词计）。
- 将最终大纲放入 <completion></completion> 内。只有 <completion> 内的内容会被采纳，不要输出其他任何内容。`;

export const DEFAULT_OUTLINE_PROMPT_TEMPLATE_ZH = `[笔记标题]
{title}

[现有笔记 / 背景]
{summary}

[全局上下文]
{hooks}

[额外指令]
{extra}

[光标之前的大纲]
{prefix}
<<<光标>>>
[光标之后的大纲]
{suffix}

请在 <<<光标>>> 处续写大纲，写入 <completion> 内。最多 {max_words} 字。只输出新的大纲条目。`;

/** Built-in mode ids (stable across renames so migrations keep targeting the right preset). */
export const MODE_IDS = { note: "note", novel: "novel", outline: "outline" } as const;

/** The three built-in presets for a given language. */
export function defaultModeProfiles(lang: PromptLanguage): ModeProfile[] {
  const zh = lang === "zh";
  return [
    {
      id: MODE_IDS.note,
      name: zh ? "笔记模式" : "Note mode",
      systemPrompt: zh ? DEFAULT_SYSTEM_PROMPT_ZH : DEFAULT_SYSTEM_PROMPT,
      promptTemplate: zh ? DEFAULT_PROMPT_TEMPLATE_ZH : DEFAULT_PROMPT_TEMPLATE,
      extraPrompt: "",
      promptTemplateRole: "user",
      cotEnabled: false,
      cotTemplate: zh ? DEFAULT_COT_TEMPLATE_ZH : DEFAULT_COT_TEMPLATE,
      cotTrigger: zh ? DEFAULT_COT_TRIGGER_ZH : DEFAULT_COT_TRIGGER,
      cotTemplateRole: "user",
      cotTriggerRole: "system",
      maxWords: 100,
      temperature: 0.7,
      prefixChars: 2000,
      suffixChars: 1000,
      recallLevel: 1,
      adjacentDepth: 1,
      adjacentMaxNotes: 20,
      adjacentNoteChars: 1500,
      adjacentTotalChars: 12000,
      summaryEnabled: true,
      summaryModel: "gpt-4o-mini",
      summaryMaxTokens: 4096,
      summaryMaxWords: 100,
      summaryTemperature: 0.3,
      summaryInputChars: 8000,
      contextMode: "window",
      inNoteSummaryPrompt: zh ? DEFAULT_NOVEL_SUMMARY_PROMPT : DEFAULT_NOVEL_SUMMARY_PROMPT_EN,
    },
    {
      id: MODE_IDS.novel,
      name: zh ? "小说模式" : "Novel mode",
      systemPrompt: zh ? DEFAULT_NOVEL_SYSTEM_PROMPT_ZH : DEFAULT_NOVEL_SYSTEM_PROMPT,
      promptTemplate: zh ? DEFAULT_NOVEL_PROMPT_TEMPLATE_ZH : DEFAULT_NOVEL_PROMPT_TEMPLATE,
      extraPrompt: "",
      promptTemplateRole: "user",
      cotEnabled: true,
      cotTemplate: zh ? DEFAULT_COT_TEMPLATE_ZH : DEFAULT_COT_TEMPLATE,
      cotTrigger: zh ? "<thinking> first,go" : DEFAULT_COT_TRIGGER,
      cotTemplateRole: "user",
      cotTriggerRole: "system",
      maxWords: 256,
      temperature: 0.8,
      prefixChars: 40000,
      suffixChars: 40000,
      recallLevel: 2,
      adjacentDepth: 1,
      adjacentMaxNotes: 20,
      adjacentNoteChars: 1500,
      adjacentTotalChars: 120000,
      summaryEnabled: true,
      summaryModel: "glm-5.3-flash",
      summaryMaxTokens: 81920,
      summaryMaxWords: 2000,
      summaryTemperature: 0.8,
      summaryInputChars: 81920,
      contextMode: "in-note",
      inNoteSummaryPrompt: zh ? DEFAULT_NOVEL_SUMMARY_PROMPT : DEFAULT_NOVEL_SUMMARY_PROMPT_EN,
    },
    {
      id: MODE_IDS.outline,
      name: zh ? "大纲设计模式" : "Outline mode",
      systemPrompt: zh ? DEFAULT_OUTLINE_SYSTEM_PROMPT_ZH : DEFAULT_OUTLINE_SYSTEM_PROMPT,
      promptTemplate: zh ? DEFAULT_OUTLINE_PROMPT_TEMPLATE_ZH : DEFAULT_OUTLINE_PROMPT_TEMPLATE,
      extraPrompt: "",
      promptTemplateRole: "user",
      cotEnabled: false,
      cotTemplate: zh ? DEFAULT_COT_TEMPLATE_ZH : DEFAULT_COT_TEMPLATE,
      cotTrigger: zh ? DEFAULT_COT_TRIGGER_ZH : DEFAULT_COT_TRIGGER,
      cotTemplateRole: "user",
      cotTriggerRole: "system",
      maxWords: 300,
      temperature: 0.6,
      prefixChars: 2000,
      suffixChars: 2000,
      recallLevel: 0,
      adjacentDepth: 1,
      adjacentMaxNotes: 20,
      adjacentNoteChars: 1500,
      adjacentTotalChars: 12000,
      summaryEnabled: false,
      summaryModel: "gpt-4o-mini",
      summaryMaxTokens: 4096,
      summaryMaxWords: 100,
      summaryTemperature: 0.3,
      summaryInputChars: 8000,
      contextMode: "full",
      inNoteSummaryPrompt: zh ? DEFAULT_NOVEL_SUMMARY_PROMPT : DEFAULT_NOVEL_SUMMARY_PROMPT_EN,
    },
  ];
}

/** Built-in English in-note summary prompt (mirrors DEFAULT_NOVEL_SUMMARY_PROMPT). */
export const DEFAULT_NOVEL_SUMMARY_PROMPT_EN = `You are a plot-summary engine for fiction. Write a plot summary of the given passage.
Rules:
- Record only objective events and plot: who, where, what they did, what turned, key dialogue and information.
- No elevation: do not infer themes, morals, emotions, or literary devices; do not evaluate or advise.
- Do not omit key foreshadowing, changes in character motivation, or newly introduced characters.
- At most {max_words} words, in the same language as the source.
- Output only the summary text. No title, no prefix, no explanation.`;

/** The active mode: the one referenced by activeModeId, falling back to the first. */
export function activeMode(s: GhostwriterSettings): ModeProfile | undefined {
  return s.modes.find((m) => m.id === s.activeModeId) ?? s.modes[0];
}

/** Copy the top-level (live) mode fields into the active preset. */
export function captureActiveMode(s: GhostwriterSettings): void {
  const m = activeMode(s);
  if (!m) return;
  for (const k of MODE_KEYS) {
    (m as unknown as Record<string, unknown>)[k] = (s as unknown as Record<string, unknown>)[k];
  }
}

/** Copy a preset's fields into the top-level (live) settings. */
export function applyModeToSettings(s: GhostwriterSettings, mode: ModeProfile): void {
  for (const k of MODE_KEYS) {
    (s as unknown as Record<string, unknown>)[k] = (mode as unknown as Record<string, unknown>)[k];
  }
}

export function makeModeId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A fresh preset cloned from current live values (used by "add"/"duplicate"). */
export function cloneModeFromSettings(s: GhostwriterSettings, name: string): ModeProfile {
  const m: ModeProfile = { ...defaultModeProfiles(s.promptLanguage)[0], id: makeModeId(), name };
  for (const k of MODE_KEYS) {
    (m as unknown as Record<string, unknown>)[k] = (s as unknown as Record<string, unknown>)[k];
  }
  return m;
}

export const DEFAULT_SETTINGS: GhostwriterSettings = {
  providers: [],
  activeProviderId: "",
  modes: defaultModeProfiles("en"),
  activeModeId: MODE_IDS.note,
  promptLanguage: "en",
  maxTokens: 8192,
  maxWords: 100,
  temperature: 0.7,
  requestTimeoutSec: 120,
  customHeaders: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  extraPrompt: "",
  prefixChars: 2000,
  suffixChars: 1000,
  summary: "",
  summaryEnabled: true,
  summaryFolder: "summaries",
  summaryModel: "gpt-4o-mini",
  summaryMaxTokens: 4096,
  summaryMaxWords: 100,
  summaryTemperature: 0.3,
  summaryInputChars: 8000,
  summaryScanLimit: 500,
  disabledSummaryFiles: [],
  recallLevel: 1,
  adjacentDepth: 1,
  adjacentMaxNotes: 20,
  adjacentNoteChars: 1500,
  adjacentTotalChars: 12000,
  stream: true,
  cotEnabled: false,
  cotTemplate: DEFAULT_COT_TEMPLATE,
  cotTemplateRole: "user",
  cotTrigger: DEFAULT_COT_TRIGGER,
  cotTriggerRole: "system",
  promptTemplateRole: "user",
  previewMode: false,
  peekCoT: false,
  promptPreviewBeforeSend: false,
  globalHooksEnabled: false,
  globalHooks: [],
  contextMode: "window",
  inNoteSummaryPrompt: DEFAULT_NOVEL_SUMMARY_PROMPT_EN,
  acceptKey: "Shift+Insert",
  dismissKey: "Escape",
};

/** The profile requests are issued against: the active id wins, the first profile is the fallback. */
export function activeProvider(s: GhostwriterSettings): ProviderProfile {
  const p = s.providers.find((x) => x.id === s.activeProviderId) ?? s.providers[0];
  if (p) return p;
  throw new Error("No provider profile configured (Settings → Providers)");
}

/**
 * Parse the custom-headers setting ("Name: Value", one per line) into a header
 * map. Line order is preserved; malformed lines are reported to the console and
 * skipped. Comments (# …) are ignored.
 */
export function parseCustomHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const sep = text.indexOf(":");
    if (sep <= 0) {
      console.warn(`[ghostwriter] ignoring malformed custom header: ${text}`);
      continue;
    }
    const name = text.slice(0, sep).trim();
    const value = text.slice(sep + 1).trim();
    if (!name) {
      console.warn(`[ghostwriter] ignoring malformed custom header: ${text}`);
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

const LEGACY_CONNECTION_DEFAULTS = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

const LEGACY_SETTING_KEYS = [
  "apiBaseUrl",
  "apiKey",
  "model",
  "summaryDisabledPaths",
  "novelMode",
  "novelSummaryPrompt",
];

const asStrings = (arr: unknown): string[] =>
  Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string") : [];

function normalizeHooks(raw: unknown): HookItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HookItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const path = typeof r.path === "string" ? r.path.trim() : "";
    if (!path) continue;
    const mode = r.contextMode === "window" || r.contextMode === "full" || r.contextMode === "in-note"
      ? r.contextMode
      : "follow";
    const cap = Math.floor(Number(r.maxChars ?? 0));
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : makeModeId(),
      path,
      enabled: r.enabled !== false,
      contextMode: mode,
      maxChars: Number.isFinite(cap) && cap > 0 ? cap : 0,
    });
  }
  return out;
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function detectLanguage(data: Record<string, unknown>): PromptLanguage {
  const sp = typeof data.systemPrompt === "string" ? data.systemPrompt : "";
  const pt = typeof data.promptTemplate === "string" ? data.promptTemplate : "";
  return CJK_RE.test(sp + pt) ? "zh" : "en";
}

function coerceContextMode(v: unknown): ContextMode | undefined {
  return v === "window" || v === "full" || v === "in-note" ? v : undefined;
}

const ROLES: MessageRole[] = ["user", "assistant", "system"];

function coerceModeNumbers(m: ModeProfile): void {
  const lvl = Math.floor(Number(m.recallLevel ?? 1));
  m.recallLevel = Math.min(3, Math.max(0, Number.isFinite(lvl) ? lvl : 1));
  m.adjacentDepth = Math.max(1, Math.floor(Number(m.adjacentDepth ?? 1)) || 1);
  m.adjacentMaxNotes = Math.max(1, Math.floor(Number(m.adjacentMaxNotes ?? 20)) || 20);
  m.adjacentNoteChars = Math.max(200, Math.floor(Number(m.adjacentNoteChars ?? 1500)) || 1500);
  m.adjacentTotalChars = Math.max(200, Math.floor(Number(m.adjacentTotalChars ?? 12000)) || 12000);
  const mw = Math.floor(Number(m.maxWords ?? 100));
  m.maxWords = Number.isFinite(mw) && mw > 0 ? mw : 100;
  const t = Number(m.temperature ?? 0.7);
  m.temperature = Number.isFinite(t) && t >= 0 && t <= 2 ? t : 0.7;
  const pc = Math.floor(Number(m.prefixChars ?? 2000));
  m.prefixChars = Number.isFinite(pc) && pc >= 0 ? pc : 2000;
  const sc = Math.floor(Number(m.suffixChars ?? 1000));
  m.suffixChars = Number.isFinite(sc) && sc >= 0 ? sc : 1000;
  if (typeof m.summaryModel !== "string") m.summaryModel = "gpt-4o-mini";
  const smt = Math.floor(Number(m.summaryMaxTokens ?? 4096));
  m.summaryMaxTokens = Number.isFinite(smt) && smt > 0 ? smt : 4096;
  const smw = Math.floor(Number(m.summaryMaxWords ?? 100));
  m.summaryMaxWords = Number.isFinite(smw) && smw > 0 ? smw : 100;
  const st = Number(m.summaryTemperature ?? 0.3);
  m.summaryTemperature = Number.isFinite(st) && st >= 0 && st <= 2 ? st : 0.3;
  const sic = Math.floor(Number(m.summaryInputChars ?? 8000));
  m.summaryInputChars = Number.isFinite(sic) && sic > 0 ? sic : 8000;
  if (!ROLES.includes(m.promptTemplateRole)) m.promptTemplateRole = "user";
  if (!ROLES.includes(m.cotTemplateRole)) m.cotTemplateRole = "user";
  if (!ROLES.includes(m.cotTriggerRole)) m.cotTriggerRole = "system";
  m.contextMode = coerceContextMode(m.contextMode) ?? "window";
  if (typeof m.inNoteSummaryPrompt !== "string") m.inNoteSummaryPrompt = DEFAULT_NOVEL_SUMMARY_PROMPT_EN;
}

interface ModesResult {
  modes: ModeProfile[];
  /** Set when legacy top-level values were folded into a preset; becomes the active mode. */
  preferredActiveId?: string;
}

function normalizeModes(
  raw: unknown,
  lang: PromptLanguage,
  s: GhostwriterSettings & Record<string, unknown>,
  data: Record<string, unknown>
): ModesResult {
  const defaults = defaultModeProfiles(lang);
  const byId = new Map(defaults.map((d) => [d.id, d]));
  const list: ModeProfile[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === "string" && r.id ? r.id : makeModeId();
      const base = byId.get(id) ?? defaults[0];
      const m: ModeProfile = {
        ...base,
        id,
        name: typeof r.name === "string" && r.name.trim() ? r.name : base.name,
      };
      for (const k of MODE_KEYS) {
        if (r[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = r[k];
      }
      list.push(m);
    }
  }
  let preferredActiveId: string | undefined;
  if (!list.length) {
    // No presets persisted yet: fold the current top-level values into the preset
    // they belong to (a legacy novel setup becomes the Novel preset, otherwise Note).
    const legacyNovel = data.novelMode === true;
    const targetIdx = legacyNovel ? 1 : 0;
    const target: ModeProfile = { ...defaults[targetIdx] };
    for (const k of MODE_KEYS) {
      if (data[k] !== undefined) (target as unknown as Record<string, unknown>)[k] = s[k];
    }
    target.contextMode = coerceContextMode(data.contextMode) ?? (legacyNovel ? "in-note" : "window");
    const legacySummaryPrompt =
      typeof data.novelSummaryPrompt === "string" && data.novelSummaryPrompt.trim()
        ? data.novelSummaryPrompt
        : "";
    if (legacySummaryPrompt) target.inNoteSummaryPrompt = legacySummaryPrompt;
    list.push({ ...defaults[0] }, { ...defaults[1] }, { ...defaults[2] });
    list[targetIdx] = target;
    preferredActiveId = target.id;
  }
  for (const m of list) coerceModeNumbers(m);
  return { modes: list, preferredActiveId };
}

/**
 * Build the current settings shape from persisted data, migrating legacy fields:
 * top-level connection fields fold into a "Default" provider profile when no
 * providers exist, old prompt/context fields fold into a "Note" mode preset when
 * no presets exist, the legacy novelMode/novelSummaryPrompt become the "Novel"
 * preset, summaryDisabledPaths merges into disabledSummaryFiles, and all legacy
 * keys are dropped so they leave data.json.
 */
export function migrateSettings(raw: unknown): GhostwriterSettings {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const s = Object.assign({}, DEFAULT_SETTINGS, data) as GhostwriterSettings & Record<string, unknown>;

  // Clone so the shared DEFAULT_SETTINGS arrays are never mutated.
  s.providers = Array.isArray(s.providers) ? s.providers.map((p) => ({ ...p })) : [];
  if (s.providers.length === 0) {
    const legacyBase = typeof data.apiBaseUrl === "string" ? data.apiBaseUrl.trim() : "";
    const legacyModel = typeof data.model === "string" ? data.model.trim() : "";
    s.providers.push({
      id: "default",
      name: "Default",
      apiBaseUrl: legacyBase || LEGACY_CONNECTION_DEFAULTS.apiBaseUrl,
      apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
      model: legacyModel || LEGACY_CONNECTION_DEFAULTS.model,
    });
  }
  const active = s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
  s.activeProviderId = active.id;

  s.promptLanguage = data.promptLanguage === "en" || data.promptLanguage === "zh"
    ? data.promptLanguage
    : detectLanguage(data);

  const normalized = normalizeModes(data.modes, s.promptLanguage, s, data);
  s.modes = normalized.modes;
  if (normalized.preferredActiveId && s.modes.some((m) => m.id === normalized.preferredActiveId)) {
    s.activeModeId = normalized.preferredActiveId;
  }
  if (!s.modes.some((m) => m.id === s.activeModeId)) s.activeModeId = s.modes[0].id;
  const mode = s.modes.find((m) => m.id === s.activeModeId) ?? s.modes[0];
  applyModeToSettings(s, mode);

  s.disabledSummaryFiles = [
    ...new Set([...asStrings(s.disabledSummaryFiles), ...asStrings(data.summaryDisabledPaths)]),
  ];

  s.globalHooksEnabled = data.globalHooksEnabled === true;
  s.globalHooks = normalizeHooks(s.globalHooks);
  s.promptPreviewBeforeSend = data.promptPreviewBeforeSend === true;

  const tSec = Math.floor(Number(s.requestTimeoutSec ?? 120));
  s.requestTimeoutSec = Math.max(5, Number.isFinite(tSec) ? tSec : 120);

  for (const k of LEGACY_SETTING_KEYS) delete s[k];
  return s;
}
