# Ghostwriter LLM for Obsidian

GitHub Copilot-style inline writing completion for Obsidian, using any OpenAI-compatible chat-completions API.

![Ghostwriter LLM demo](demo.gif)

## Features

- Inline ghost text at the cursor, streaming, with an optional thinking preview.
- **Writing modes**: named presets with their own prompts, CoT, recall, context strategy and summary settings.
- **Global hooks**: pin other notes into every prompt.
- **Background mode**: keep completions running when you switch notes, with a right-sidebar session manager that previews every session.
- **In-note summaries** for long fiction (`[Summary]` / `[摘要]` blocks).
- Separate note summaries (`summary-N.md`) with link-following recall.
- Optional pre-send prompt preview, prompt-cache hit-rate reporting, configurable accept/dismiss keys.

## Quick Start

1. `npm install && npm run build` — typechecks, bundles, and publishes to `test/test/.obsidian/plugins/ghostwriter-llm/`.
2. In Obsidian → plugin settings, add a provider (Base URL, API key, model) and pick a writing mode.
3. Run `Trigger LLM completion at cursor`; accept with `Shift+Insert`, dismiss with `Escape`.

Set `OBSIDIAN_PLUGIN_DEST` to publish elsewhere; `npm run publish` republishes without rebuilding.

## Writing Modes

A mode is a named preset owning the system prompt, prompt template, extra prompt, message roles, CoT, word/temperature limits, recall settings, context strategy and summary settings. Three ship built in (Chinese or English via **Default prompt language**):

| Mode | Context strategy |
| --- | --- |
| Note | `full` — the whole text before/after the cursor, untruncated |
| Novel | `in-note` — summaries replace the summarized paragraphs |
| Outline | `full` |

Manage them under **Writing modes** (rename, duplicate, add, delete, restore defaults) or switch with the `Switch writing mode` command. Providers, the summary folder/scan limit, per-file summary switches and UI options are global.

Templates support `{title}`, `{summary}`, `{hooks}`, `{extra}`, `{prefix}`, `{suffix}`, `{max_words}` and `<<<CURSOR>>>` / `<<<光标>>>`.

## Global Hooks

Pin notes into every prompt via **Manage global context hooks** (settings or command palette): enable/disable, reorder, per-item strategy (`follow mode`, `full`, `in-note`) and an optional character cap. Hooks render as `[Global context: <title>]` at `{hooks}`; templates without it append them to `{summary}`. Notes already injected as hooks are excluded from adjacent-note recall.

## Summaries

- `Generate summary for current note` writes `summaries/summary-N.md` with `source:` frontmatter; the source note is never modified.
- `Generate In-Note Summary` (`Mod+Shift+S`) inserts `> [Summary] …` after the selected paragraphs. In `in-note` mode, markers are detected anywhere in a line and the summarized text is replaced by the summaries.
- Injection is configured per mode; the `Summary: ON/OFF` status-bar item toggles it for the session, and `Note summary: ON/OFF` excludes the current note.

## Prompt Preview

Enable **Preview prompt before sending** to confirm the assembled payload (all messages plus model/token settings) with Send / Cancel / Copy. **Warn when prompt exceeds 128k chars** shows a confirmation — with a "Don't warn me again" opt-out — before oversized requests.

## Background Mode & Sessions

Enable **Background mode** to let completions keep running when you switch notes. Every request becomes a session listed in the **Ghostwriter sessions** right sidebar (`Open background sessions` / the ribbon icon / **Open sessions** in settings):

- Live preview of each session's completion, thinking and assembled prompt.
- Status, elapsed time, target note and writing mode per session.
- Actions: **Cancel**, **Accept**, **Open note**, **Retry**, **Remove**, **Clear finished**.
- **Accept** on a non-active note writes the text back at the saved cursor offset (via the original editor when it is still valid, otherwise directly into the file).
- With background mode on and **Preview mode** enabled, previews stream in the sidebar instead of a modal card.

When background mode is off, switching notes cancels the current suggestion (the previous behavior).

## Commands

`Trigger LLM completion at cursor` · `Trigger LLM completion with an instruction` (`Mod+Shift+Enter`) · `Switch writing mode` · `Manage global context hooks` · `Open background sessions` · `Generate In-Note Summary` (`Mod+Shift+S`) · `Generate summary for current note` · `Show summary status` · `Toggle summary injection (session)` · `Toggle current note summary injection` · `Dismiss current LLM suggestion`

## Development

```bash
npm install
npm run dev     # esbuild watch
npm run build   # typecheck + production bundle + publish
```

## License

MIT
