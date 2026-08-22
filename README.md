# Ghostwriter LLM for Obsidian

GitHub Copilot-style inline writing completion for Obsidian, powered by an OpenAI-compatible chat-completions API.

## Features

- Inline ghost-text completion at the cursor.
- Streaming responses with optional thinking preview.
- Preview mode for reviewing a completion before insertion.
- Configurable prompt templates, message roles, and completion context.
- OpenAI-compatible providers, including local servers such as llama.cpp.
- Separate, manually generated note summaries stored as `summary-{number}.md` files.
- Configurable accept and dismiss shortcuts.

## Quick Start

1. Build the plugin with `npm install` followed by `npm run build`.
2. The build publishes `main.js`, `styles.css`, and `manifest.json` to the configured local test vault.
3. In Obsidian, open the plugin settings and configure the API base URL, API key, and model.
4. Run the command `Trigger LLM completion at cursor`.
5. Accept the suggestion with `Shift+Insert` or dismiss it with `Escape`.

The default publish directory is:

```text
test/test/.obsidian/plugins/ghostwriter-llm/
```

To publish to another local directory, set `OBSIDIAN_PLUGIN_DEST` before running `npm run publish`.

## Summaries

Summaries are never written into the source note. The `Generate summary for current note` command creates or updates a separate file in the configured summary folder, which defaults to `summaries/`.

Each generated file uses this format:

```markdown
---
source: "path/to/note.md"
---

The manually generated summary text.
```

Summary generation is manual. Summary injection can be enabled or disabled globally in settings, or temporarily with the `Summary: ON/OFF` status-bar item or the `Toggle summary injection (session)` command.

## Settings Groups

- **Prompt management**: restore, export, and import prompt bundles.
- **Connection & model**: API endpoint, model, token limit, word limit, and temperature.
- **Prompt & context**: system prompt, prompt template, and cursor context size.
- **Summary recall**: summary folder, summary model, and summary generation limits.
- **Reasoning**: optional chain-of-thought instructions and triggers.
- **Display & shortcuts**: preview mode, streaming, thinking preview, and keyboard shortcuts.

## Demo

![Ghostwriter LLM demo](demo.gif)

The original MP4 recording is included as `QQ20260822-165446.mp4`.

## Development

```bash
npm install
npm run build
npm run dev
```

`npm run build` runs the TypeScript check, creates a production bundle, and publishes the plugin files to the local test vault. `npm run dev` starts the esbuild watch process.

## Security

API keys are stored by Obsidian in the plugin's local `data.json`. The test vault and its `.obsidian` directory are ignored by Git. Never commit `data.json` or any API key.

## License

MIT
