export type MessageRole = "user" | "assistant" | "system";

export interface ProviderProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export interface GhostwriterSettings {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  providers: ProviderProfile[];
  activeProviderId: string;
  maxTokens: number;
  maxWords: number;
  temperature: number;
  systemPrompt: string;
  promptTemplate: string;
  extraPrompt: string;
  prefixChars: number;
  suffixChars: number;
  summary: string;
  summaryEnabled: boolean;
  summaryDisabledPaths: string[];
  summaryFolder: string;
  summaryModel: string;
  summaryMaxTokens: number;
  summaryMaxWords: number;
  summaryTemperature: number;
  summaryInputChars: number;
  summaryScanLimit: number;
  disabledSummaryFiles: string[];
  recallLevel: number;
  adjacentDepth: number;
  adjacentMaxNotes: number;
  stream: boolean;
  cotEnabled: boolean;
  cotTemplate: string;
  cotTemplateRole: MessageRole;
  cotTrigger: string;
  cotTriggerRole: MessageRole;
  promptTemplateRole: MessageRole;
  previewMode: boolean;
  peekCoT: boolean;
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

export const DEFAULT_SETTINGS: GhostwriterSettings = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  providers: [],
  activeProviderId: "",
  maxTokens: 8192,
  maxWords: 100,
  temperature: 0.7,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  extraPrompt: "",
  prefixChars: 2000,
  suffixChars: 1000,
  summary: "",
  summaryEnabled: true,
  summaryDisabledPaths: [],
  summaryFolder: "summaries",
  summaryModel: "gpt-4o-mini",
  summaryMaxTokens: 200,
  summaryMaxWords: 100,
  summaryTemperature: 0.3,
  summaryInputChars: 8000,
  summaryScanLimit: 500,
  disabledSummaryFiles: [],
  recallLevel: 1,
  adjacentDepth: 1,
  adjacentMaxNotes: 20,
  stream: true,
  cotEnabled: false,
  cotTemplate: DEFAULT_COT_TEMPLATE,
  cotTemplateRole: "user",
  cotTrigger: DEFAULT_COT_TRIGGER,
  cotTriggerRole: "system",
  promptTemplateRole: "user",
  previewMode: false,
  peekCoT: false,
  acceptKey: "Shift+Insert",
  dismissKey: "Escape",
};
