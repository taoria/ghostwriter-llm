import { App, Notice, PluginSettingTab, Setting, TextComponent, DropdownComponent } from "obsidian";
import type GhostwriterPlugin from "./main";
import { ProviderProfile, activeProvider, activeMode, parseCustomHeaders } from "./settings";
import { fetchModels } from "./completionService";
import { SummaryEntry } from "./summaryService";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_COT_TEMPLATE,
  DEFAULT_NOVEL_SUMMARY_PROMPT_EN,
  defaultPromptsFor,
  PromptLanguage,
  PromptBundle,
  ModeProfile,
  ContextMode,
  PROMPT_BUNDLE_VERSION,
  PROMPT_BUNDLE_MAGIC,
} from "./settings";

const PROMPT_KEYS: (keyof PromptBundle)[] = [
  "systemPrompt",
  "promptTemplate",
  "cotTemplate",
  "cotTrigger",
  "cotTemplateRole",
  "cotTriggerRole",
  "promptTemplateRole",
  "extraPrompt",
];

export class GhostwriterSettingTab extends PluginSettingTab {
  plugin: GhostwriterPlugin;

  constructor(app: App, plugin: GhostwriterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Ghostwriter LLM" });

    const section = (title: string, description: string) => {
      const heading = containerEl.createDiv({ cls: "ghostwriter-settings-section" });
      heading.createEl("h3", { text: title });
      heading.createEl("p", { text: description });
    };

    const s = () => this.plugin.settings;
    const activeProfile = (): ProviderProfile | undefined =>
      s().providers.find((p) => p.id === s().activeProviderId);

    const syncActive = async (patch: Partial<ProviderProfile>): Promise<void> => {
      const st = s();
      const p = st.providers.find((x) => x.id === st.activeProviderId);
      if (p) Object.assign(p, patch);
      await this.plugin.saveSettings();
    };

    section("Providers", "Save multiple OpenAI-compatible providers, switch between them, and fetch their model list.");
    if (s().providers.length > 0) {
      new Setting(containerEl)
        .setName("Active provider")
        .setDesc("Switching loads the saved Base URL, API key and model of that profile.")
        .addDropdown((dd) => {
          const opts: Record<string, string> = {};
          for (const p of s().providers) opts[p.id] = p.name || p.id;
          dd.addOptions(opts);
          dd.setValue(s().activeProviderId);
          dd.onChange(async (id) => {
            await this.plugin.switchProvider(id);
            this.display();
          });
        })
        .addButton((btn) => {
          btn.setButtonText("Delete")
            .setIcon("trash")
            .setClass("mod-warning")
            .setTooltip("Delete the active provider profile")
            .onClick(async () => {
              const st = s();
              const idx = st.providers.findIndex((p) => p.id === st.activeProviderId);
              const removed = idx >= 0 ? st.providers.splice(idx, 1)[0] : undefined;
              if (!st.providers.length) {
                st.providers.push({
                  id: "default",
                  name: "Default",
                  apiBaseUrl: removed?.apiBaseUrl ?? "https://api.openai.com/v1",
                  apiKey: removed?.apiKey ?? "",
                  model: removed?.model ?? "gpt-4o-mini",
                });
                new Notice("Last profile deleted; recreated a Default profile");
              } else {
                new Notice("Provider deleted");
              }
              await this.plugin.switchProvider(st.providers[0].id);
              this.display();
            });
        });
    }

    const newName = { value: "" };
    new Setting(containerEl)
      .setName("Add provider")
      .setDesc("Create a new profile pre-filled with the current connection values, then edit it below.")
      .addText((text) => {
        text.setPlaceholder("Profile name");
        text.onChange((v) => {
          newName.value = v;
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Add").setCta().onClick(async () => {
          const st = s();
          const name = newName.value.trim() || `Provider ${st.providers.length + 1}`;
          const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const cur = activeProvider(st);
          st.providers.push({
            id,
            name,
            apiBaseUrl: cur.apiBaseUrl,
            apiKey: cur.apiKey,
            model: cur.model,
          });
          await this.plugin.switchProvider(id);
          this.display();
          new Notice(`Provider "${name}" added`);
        });
      });

    const active = activeProfile();
    if (active) {
      new Setting(containerEl)
        .setName("Profile name")
        .setDesc("Display name of the active provider.")
        .addText((text) =>
          text.setValue(active.name).onChange((value) => {
            void syncActive({ name: value });
          })
        );

      new Setting(containerEl)
        .setName("API Base URL")
        .setDesc("OpenAI-compatible endpoint. Works with OpenAI, DeepSeek, Moonshot, Together, local llama.cpp server, etc.")
        .addText((text) =>
          text
            .setPlaceholder("https://api.openai.com/v1")
            .setValue(active.apiBaseUrl)
            .onChange(async (value) => {
              await syncActive({ apiBaseUrl: value.trim() });
            })
        );

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("Stored in plaintext in data.json (standard Obsidian behavior). Each profile keeps its own key.")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("sk-...")
            .setValue(active.apiKey)
            .onChange(async (value) => {
              await syncActive({ apiKey: value });
            });
        });

      this.addModelFieldWithFetch(
        containerEl,
        "Model",
        "Type a model id manually, or fetch the list from the provider and pick one.",
        {
          get: () => active.model,
          set: async (value) => {
            await syncActive({ model: value });
          },
          placeholder: "gpt-4o-mini",
        }
      );
    }

    section("Writing modes", "Each mode is a named preset of prompts, context, recall, CoT and summary settings. Providers, the summary folder/scan limit, and UI options stay global.");

    const modes = (): ModeProfile[] => s().modes;
    const currentMode = (): ModeProfile | undefined => activeMode(s());

    if (modes().length > 0) {
      new Setting(containerEl)
        .setName("Active mode")
        .setDesc("Switching loads that mode's prompts, context and recall settings.")
        .addDropdown((dd) => {
          const opts: Record<string, string> = {};
          for (const m of modes()) opts[m.id] = m.name || m.id;
          dd.addOptions(opts);
          dd.setValue(s().activeModeId);
          dd.onChange(async (id) => {
            await this.plugin.switchMode(id);
            this.display();
          });
        })
        .addButton((btn) => {
          btn.setButtonText("Duplicate")
            .setTooltip("Create a copy of the active mode")
            .onClick(async () => {
              const cur = currentMode();
              await this.plugin.addMode(`${cur?.name ?? "Mode"} copy`);
              this.display();
            });
        })
        .addButton((btn) => {
          btn.setButtonText("Delete")
            .setIcon("trash")
            .setClass("mod-warning")
            .setTooltip("Delete the active mode")
            .setDisabled(modes().length <= 1)
            .onClick(async () => {
              const cur = currentMode();
              if (!cur) return;
              await this.plugin.deleteMode(cur.id);
              this.display();
            });
        });
    }

    const curMode = currentMode();
    if (curMode) {
      new Setting(containerEl)
        .setName("Mode name")
        .setDesc("Display name of the active mode.")
        .addText((text) =>
          text.setValue(curMode.name).onChange(async (value) => {
            curMode.name = value;
            await this.plugin.saveSettings();
          })
        );
    }

    const newModeName = { value: "" };
    new Setting(containerEl)
      .setName("Add mode")
      .setDesc("Create a new mode pre-filled with the active mode's values.")
      .addText((text) => {
        text.setPlaceholder("Mode name");
        text.onChange((v) => {
          newModeName.value = v;
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Add").setCta().onClick(async () => {
          await this.plugin.addMode(newModeName.value.trim());
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Default prompt language")
      .setDesc("Language used for built-in prompt defaults when restoring a mode to its defaults.")
      .addDropdown((dd) => {
        dd.addOptions({ zh: "中文 (Chinese)", en: "English" });
        dd.setValue(s().promptLanguage);
        dd.onChange(async (value) => {
          s().promptLanguage = value as PromptLanguage;
          await this.plugin.saveSettings();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Restore active mode")
          .setClass("mod-warning")
          .setTooltip("Replace the active mode's prompts/context/recall/summary settings with built-in defaults")
          .onClick(async () => {
            await this.plugin.restoreModeDefaults(s().promptLanguage);
            this.display();
          });
      });

    section("Generation limits", "Soft limits for the active writing mode. The request timeout and the hard token cap are in Advanced below.");

    new Setting(containerEl)
      .setName("Max words")
      .setDesc("Soft word limit injected into the prompt as {max_words}. The model is instructed not to exceed this. Independent of max_tokens.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxWords))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxWords = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Temperature")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.temperature))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0 && n <= 2) {
              this.plugin.settings.temperature = n;
              await this.plugin.saveSettings();
            }
          })
      );

    section("Prompt & context", "Text sent around the cursor and the main completion instructions for the active writing mode.");
    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Instructions sent as the system message. Supports placeholders: {max_words}, {title}. Controls completion behavior.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 60;
        text
          .setValue(this.plugin.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Prompt template")
      .setDesc("Main message body. Placeholders: {title} {prefix} {suffix} {summary} {extra} {max_words}. Reorder freely to control injection position. Default used if left empty.")
      .addTextArea((text) => {
        text.inputEl.rows = 10;
        text.inputEl.cols = 60;
        text
          .setValue(this.plugin.settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE)
          .onChange(async (value) => {
            this.plugin.settings.promptTemplate = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Extra prompt")
      .setDesc("Content injected at the {extra} placeholder in the template.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.cols = 60;
        text
          .setValue(this.plugin.settings.extraPrompt)
          .onChange(async (value) => {
            this.plugin.settings.extraPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    section("Recall level", "How much context is collected into the completion prompt for the active writing mode.");
    new Setting(containerEl)
      .setName("Recall level")
      .setDesc("0 = cursor context only (no recall blocks). 1 = context + summaries (default). 2 = also inject linked adjacent notes (see depth below). 3 = full current note + all linked notes, summaries excluded.")
      .addDropdown((dd) => {
        dd.addOptions({
          "0": "0 · Only cursor context",
          "1": "1 · Context + summaries (default)",
          "2": "2 · + Adjacent linked notes",
          "3": "3 · Full context, no summaries",
        });
        dd.setValue(String(this.plugin.settings.recallLevel ?? 1));
        dd.onChange(async (value) => {
          const n = Number(value);
          if ([0, 1, 2, 3].includes(n)) {
            this.plugin.settings.recallLevel = n;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName("Adjacent depth")
      .setDesc("Link-follow depth for recall level 2. 1 = only notes directly linked to/from the current note. Deeper hops follow outgoing links.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.adjacentDepth))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 1) {
              this.plugin.settings.adjacentDepth = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Adjacent max notes")
      .setDesc("Cap on how many adjacent note blocks may be injected per completion.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.adjacentMaxNotes))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 1) {
              this.plugin.settings.adjacentMaxNotes = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Adjacent note chars")
      .setDesc("Per-note character cap for adjacent note blocks (recall level 2/3).")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.adjacentNoteChars))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 200) {
              this.plugin.settings.adjacentNoteChars = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    section("Summary recall", "Inject generated summaries into completion context. Whether summaries are injected and the generation parameters (model, max words/tokens, temperature, input chars) belong to the active writing mode; the folder, scan limit and per-file switches are global.");
    new Setting(containerEl)
      .setName("Summary recall")
      .setDesc("Master switch. When on, the plugin scans the configured summary subfolder for `summary-{number}.md` files and injects them as the {summary} context (current note first, then others alphabetically). When off, no summaries are injected. A session toggle (status bar / command) ANDs with this.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.summaryEnabled)
          .onChange(async (value) => {
            this.plugin.settings.summaryEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.updateStatusBar?.();
          })
      );

    // Per-file switches: disable individual summary-N.md files regardless of their source note.
    const fileListContainer = containerEl.createDiv({ cls: "ghostwriter-summary-files" });
    new Setting(containerEl)
      .setName("Summary status")
      .setDesc("Open the status panel: running / succeeded / failed summary operations (with error reasons) and every summary file, including ones that cannot be previewed or injected.")
      .addButton((btn) => {
        btn.setButtonText("Open status panel").onClick(() => {
          this.plugin.openSummaryStatus();
        });
      });
    void (async () => {
      let entries: SummaryEntry[] = [];
      try {
        entries = await this.plugin.summaryService.collectAll(this.plugin.settings.summaryScanLimit);
      } catch (err) {
        console.warn("list summary files failed", err);
      }
      entries.sort((a, b) => a.summaryFilePath.localeCompare(b.summaryFilePath, undefined, { numeric: true }));
      if (!entries.length) {
        fileListContainer.createEl("p", {
          text: "No summary files found.",
          cls: "setting-item-description",
        });
        return;
      }
      for (const e of entries) {
        const fileName = e.summaryFilePath.split("/").pop() ?? e.summaryFilePath;
        new Setting(fileListContainer)
          .setName(`${fileName} → ${e.title}`)
          .setDesc(`Source: ${e.path}`)
          .addToggle((toggle) => {
            const keyDisabled = (key: string): boolean =>
              (this.plugin.settings.disabledSummaryFiles ?? []).includes(key);
            toggle
              .setTooltip("Inject this summary file during recall")
              .setValue(!keyDisabled(e.summaryFilePath) && !keyDisabled(e.path))
              .onChange(async (value) => {
                const st = this.plugin.settings;
                const list = new Set(st.disabledSummaryFiles ?? []);
                if (value) {
                  list.delete(e.summaryFilePath);
                  list.delete(e.path);
                } else {
                  list.add(e.summaryFilePath);
                  list.add(e.path);
                }
                st.disabledSummaryFiles = [...list];
                await this.plugin.saveSettings();
              });
          });
      }
    })();

    new Setting(containerEl)
      .setName("Summary folder")
      .setDesc("Vault-relative subfolder for generated files such as `summary-1.md`. It is created when you manually generate a summary.")
      .addText((text) =>
        text
          .setPlaceholder("summaries")
          .setValue(this.plugin.settings.summaryFolder)
          .onChange(async (value) => {
            this.plugin.settings.summaryFolder = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "summaries";
            await this.plugin.saveSettings();
          })
      );

    this.addModelFieldWithFetch(
      containerEl,
      "Summary model",
      "The model used to generate summaries (typically a cheaper/faster one such as gpt-4o-mini). Fetch models uses the active provider's Base URL and API key.",
      {
        get: () => this.plugin.settings.summaryModel,
        set: async (value) => {
          this.plugin.settings.summaryModel = value;
          await this.plugin.saveSettings();
        },
        placeholder: "gpt-4o-mini",
      }
    );

    new Setting(containerEl)
      .setName("Summary max words")
      .setDesc("Soft word/char limit injected as the {max_words} instruction to the summary model.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.summaryMaxWords))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.summaryMaxWords = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    section("Reasoning", "Optionally ask the model to think before producing the final completion (active writing mode).");
    new Setting(containerEl)
      .setName("Chain-of-thought (CoT)")
      .setDesc("Enable thinking-then-completion. The model is asked to reason inside <thinking>...</thinking> then output the final text inside <completion>...</completion>. The thinking part is stripped so only the completion shows as ghost text.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.cotEnabled)
          .onChange(async (value) => {
            this.plugin.settings.cotEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("CoT template")
      .setDesc("Injected at the BEGINNING (before the main prompt) to instruct the model to think first. Ignored when CoT is off.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.cols = 60;
        text
          .setValue(this.plugin.settings.cotTemplate || DEFAULT_COT_TEMPLATE)
          .onChange(async (value) => {
            this.plugin.settings.cotTemplate = value;
            await this.plugin.saveSettings();
          });
      });

    section("Context strategy", "How the text before the cursor is assembled for the active mode.");
    new Setting(containerEl)
      .setName("Context strategy")
      .setDesc("full = the whole preceding text (and whole text after the cursor), with no truncation; in-note = detect [Summary]/[摘要] blocks and send the summaries immediately before the unsummarized text (falls back to the full text when none are found).")
      .addDropdown((dd) => {
        dd.addOptions({
          full: "full · whole preceding text",
          "in-note": "in-note · summaries + unsummarized tail",
        });
        dd.setValue(this.plugin.settings.contextMode ?? "full");
        dd.onChange(async (value) => {
          this.plugin.settings.contextMode = value as ContextMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("In-note summary prompt")
      .setDesc("System prompt used by “Generate In-Note Summary” (records events and plot, no thematic elevation). Placeholder: {max_words}.")
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text.inputEl.cols = 60;
        text
          .setValue(this.plugin.settings.inNoteSummaryPrompt || DEFAULT_NOVEL_SUMMARY_PROMPT_EN)
          .onChange(async (value) => {
            this.plugin.settings.inNoteSummaryPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    section("Global hooks", "Pin notes (not necessarily the current one) into every completion prompt. Each hook is rendered with the active context strategy, or with its own override, and injected at {hooks} (older templates without {hooks} get them appended to the summary).");

    new Setting(containerEl)
      .setName("Enable global hooks")
      .setDesc("Master switch. Manage the note list in the hooks dialog.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.globalHooksEnabled)
          .onChange(async (value) => {
            this.plugin.settings.globalHooksEnabled = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) => {
        btn.setButtonText("Manage hooks…").onClick(() => {
          this.plugin.openGlobalHooks();
        });
      });

    section("Display & shortcuts", "Choose how suggestions are shown and configure the keys used to accept or dismiss them.");
    new Setting(containerEl)
      .setName("Preview mode")
      .setDesc("Show completions in a card popup (with the thinking visible) instead of inline ghost text. Accept/Reject from the card. Useful for reviewing CoT before inserting.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.previewMode)
          .onChange(async (value) => {
            this.plugin.settings.previewMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Preview prompt before sending")
      .setDesc("Show the fully assembled prompt (all messages plus model/token settings) in a confirmation dialog. Click Send to issue the request, or Cancel to abort. Works in both inline and preview mode.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.promptPreviewBeforeSend)
          .onChange(async (value) => {
            this.plugin.settings.promptPreviewBeforeSend = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Warn when prompt exceeds 128k chars")
      .setDesc("Show a confirmation dialog when the assembled prompt text is above ~128,000 characters, so a too-large request does not fail silently. The dialog also offers “Don't warn me again”.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.warnOversizePrompt)
          .onChange(async (value) => {
            this.plugin.settings.warnOversizePrompt = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Peek CoT (inline)")
      .setDesc("In inline mode, show the model's thinking stream in the floating popup near the cursor while the completion renders as ghost text. Click the 'Thinking' header to collapse/expand.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.peekCoT)
          .onChange(async (value) => {
            this.plugin.settings.peekCoT = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Stream responses")
      .setDesc("Show completion text progressively (SSE streaming). Recommended.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.stream)
          .onChange(async (value) => {
            this.plugin.settings.stream = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Accept key(s)")
      .setDesc("Keys that accept the ghost completion. Comma-separated for multiple. Supported: Tab, Enter, Shift-Enter, Shift-Insert, Shift-Tab, Ctrl-Enter, Alt-Enter, Mod-Enter. Example: Shift+Insert")
      .addText((text) =>
        text
          .setPlaceholder("Shift+Insert")
          .setValue(this.plugin.settings.acceptKey)
          .onChange(async (value) => {
            this.plugin.settings.acceptKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Dismiss key(s)")
      .setDesc("Keys that dismiss the current suggestion. Comma-separated for multiple. Supported: Escape, Shift-Escape. Example: Escape")
      .addText((text) =>
        text
          .setPlaceholder("Escape")
          .setValue(this.plugin.settings.dismissKey)
          .onChange(async (value) => {
            this.plugin.settings.dismissKey = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Advanced: collapsed low-frequency options ---
    const advanced = containerEl.createEl("details", { cls: "ghostwriter-settings-advanced" });
    advanced.createEl("summary", { text: "Advanced" });
    advanced.createEl("p", {
      text: "Low-frequency options; the defaults are fine for most setups.",
      cls: "setting-item-description",
    });
    const adv = advanced.createDiv();

    const promptLangRef: { value: PromptLanguage } = { value: "en" };
    new Setting(adv)
      .setName("Restore default prompts")
      .setDesc("Reset System prompt, CoT template, Prompt template and Extra prompt to the built-in defaults for the chosen language. Other settings are not touched.")
      .addDropdown((dd) => {
        dd.addOptions({ en: "English", zh: "中文 (Chinese)" });
        dd.setValue("en");
        dd.onChange((value) => {
          promptLangRef.value = value as PromptLanguage;
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Restore")
          .setClass("mod-warning")
          .setTooltip("Replace all prompt-related fields with defaults")
          .onClick(async () => {
            const bundle = defaultPromptsFor(promptLangRef.value);
            for (const k of PROMPT_KEYS) {
              (this.plugin.settings as unknown as Record<string, unknown>)[k as string] = bundle[k];
            }
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Prompts restored (${promptLangRef.value === "zh" ? "中文" : "English"})`);
          });
      });

    new Setting(adv)
      .setName("Export prompts")
      .setDesc("Download the current prompt bundle (system prompt, prompt template, CoT template, CoT trigger, roles, extra prompt) as a .json file you can share or back up. The only way to edit the hidden CoT trigger and message roles.")
      .addButton((btn) => {
        btn.setButtonText("Export")
          .setTooltip("Save prompts to a .json file")
          .onClick(() => this.exportPrompts());
      });

    new Setting(adv)
      .setName("Import prompts")
      .setDesc("Load prompts from an exported JSON file. Replaces all prompt-related fields; other settings are not touched.")
      .addButton((btn) => {
        btn.setButtonText("Import")
          .setTooltip("Load prompts from a .json file")
          .onClick(() => this.importPrompts());
      });

    new Setting(adv)
      .setName("Request timeout (sec)")
      .setDesc("Abort the request and show an error if the provider does not finish within this time. Prevents an endless Generating state.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.requestTimeoutSec))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 5) {
              this.plugin.settings.requestTimeoutSec = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(adv)
      .setName("Max tokens")
      .setDesc("Hard API-side token cap. With CoT enabled the model also outputs its thinking, so keep this high (default 8192). Set above max_words * ~3 as a safety net.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxTokens = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(adv)
      .setName("Custom headers")
      .setDesc("Extra HTTP headers sent with every provider request (completions, summaries, model list). One \"Name: Value\" per line; # lines are comments. These override the defaults — e.g. set \"X-Title: obsidian\" or \"HTTP-Referer\" for OpenRouter. Leave empty to send none.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.cols = 60;
        text.inputEl.style.fontFamily = "var(--font-monospace)";
        text
          .setPlaceholder("X-Title: obsidian\n# HTTP-Referer: https://example.com")
          .setValue(this.plugin.settings.customHeaders ?? "")
          .onChange(async (value) => {
            this.plugin.settings.customHeaders = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(adv)
      .setName("Adjacent total chars")
      .setDesc("Overall character budget for all adjacent note blocks combined (recall level 2/3). Keeps the prompt within the model's context window.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.adjacentTotalChars))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 200) {
              this.plugin.settings.adjacentTotalChars = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(adv)
      .setName("Manual fallback summary")
      .setDesc("Optional extra text appended to the injected summary context as a [Manual summary] block. Recalled alongside generated summary files. Leave empty to skip.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.cols = 60;
        text
          .setValue(this.plugin.settings.summary)
          .onChange(async (value) => {
            this.plugin.settings.summary = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(adv)
      .setName("Summary max tokens")
      .setDesc("API-side token cap for a single summary generation. Reasoning models spend tokens on hidden thinking before writing the summary — keep this generous (default 4096). If it is exhausted the plugin auto-retries with a larger budget.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.summaryMaxTokens))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.summaryMaxTokens = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(adv)
      .setName("Summary temperature")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.summaryTemperature))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0 && n <= 2) {
              this.plugin.settings.summaryTemperature = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(adv)
      .setName("Summary input chars")
      .setDesc("Maximum characters of the note body sent to the summary model. Larger notes are truncated from the start.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.summaryInputChars))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.summaryInputChars = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(adv)
      .setName("Summary scan limit")
      .setDesc("Max number of generated summary files scanned per completion. Lower this for very large vaults.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.summaryScanLimit))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.summaryScanLimit = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );
  }

  /** Base URL / API key of the active provider profile. */
  private activeConnection(): { apiBaseUrl: string; apiKey: string } {
    const p = activeProvider(this.plugin.settings);
    return { apiBaseUrl: p.apiBaseUrl, apiKey: p.apiKey };
  }

  /** Text field + "Fetch models" button; the fetched-models dropdown is placed right below the row. */
  private addModelFieldWithFetch(
    container: HTMLElement,
    name: string,
    desc: string,
    opts: { get: () => string; set: (value: string) => Promise<void>; placeholder: string }
  ): void {
    let fetchedModels: string[] = [];
    let textComp: TextComponent | null = null;
    let dropdown: DropdownComponent | null = null;

    const renderPick = (): void => {
      pickContainer.empty();
      dropdown = null;
      if (!fetchedModels.length) return;
      new Setting(pickContainer)
        .setName("Fetched models")
        .setDesc(`${fetchedModels.length} models reported by the endpoint. Pick one to fill the field.`)
        .addDropdown((dd) => {
          dropdown = dd;
          dd.addOption("", "-- select a model --");
          for (const m of fetchedModels) dd.addOption(m, m);
          const cur = opts.get();
          dd.setValue(fetchedModels.includes(cur) ? cur : "");
          dd.onChange(async (m) => {
            if (!m) return;
            await opts.set(m);
            textComp?.setValue(m);
          });
        });
    };

    const setting = new Setting(container)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        textComp = text;
        text
          .setPlaceholder(opts.placeholder)
          .setValue(opts.get())
          .onChange(async (value) => {
            await opts.set(value.trim());
            const v = value.trim();
            dropdown?.setValue(fetchedModels.includes(v) ? v : "");
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Fetch models").onClick(async () => {
          const { apiBaseUrl, apiKey } = this.activeConnection();
          if (!apiBaseUrl.trim()) {
            new Notice("Set an API Base URL first");
            return;
          }
          btn.setDisabled(true).setButtonText("Fetching…");
          try {
            fetchedModels = await fetchModels(apiBaseUrl, apiKey, parseCustomHeaders(this.plugin.settings.customHeaders ?? ""));
            if (!fetchedModels.length) new Notice("The provider returned no models");
            else new Notice(`Found ${fetchedModels.length} models`);
          } catch (err) {
            new Notice(`Fetch models failed: ${(err as Error).message}`);
          } finally {
            btn.setDisabled(false).setButtonText("Fetch models");
            renderPick();
          }
        });
      });

    const pickContainer = document.createElement("div");
    pickContainer.className = "ghostwriter-model-pick";
    setting.settingEl.insertAdjacentElement("afterend", pickContainer);
    renderPick();
  }

  private async exportPrompts(): Promise<void> {
    const bundle: PromptBundle & { $type: string; version: number } = {
      $type: PROMPT_BUNDLE_MAGIC,
      version: PROMPT_BUNDLE_VERSION,
      systemPrompt: this.plugin.settings.systemPrompt,
      promptTemplate: this.plugin.settings.promptTemplate,
      cotTemplate: this.plugin.settings.cotTemplate,
      cotTrigger: this.plugin.settings.cotTrigger,
      cotTemplateRole: this.plugin.settings.cotTemplateRole,
      cotTriggerRole: this.plugin.settings.cotTriggerRole,
      promptTemplateRole: this.plugin.settings.promptTemplateRole,
      extraPrompt: this.plugin.settings.extraPrompt,
    };
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `ghostwriter-llm-prompts-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    new Notice("Prompts exported");
  }

  private importPrompts(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", async () => {
      document.body.removeChild(input);
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text) as Partial<PromptBundle & { $type?: string; version?: number }>;
        if (data.$type !== PROMPT_BUNDLE_MAGIC) {
          new Notice("Not a valid LLM Ghost prompt bundle");
          return;
        }
        if (typeof data.version === "number" && data.version > PROMPT_BUNDLE_VERSION) {
          new Notice(`Bundle version ${data.version} is newer than supported (${PROMPT_BUNDLE_VERSION}); importing anyway.`);
        }
        const s = this.plugin.settings;
        if (typeof data.systemPrompt === "string") s.systemPrompt = data.systemPrompt;
        if (typeof data.promptTemplate === "string") s.promptTemplate = data.promptTemplate;
        if (typeof data.cotTemplate === "string") s.cotTemplate = data.cotTemplate;
        if (typeof data.cotTrigger === "string") s.cotTrigger = data.cotTrigger;
        if (data.cotTemplateRole === "user" || data.cotTemplateRole === "assistant" || data.cotTemplateRole === "system") {
          s.cotTemplateRole = data.cotTemplateRole;
        }
        if (data.cotTriggerRole === "user" || data.cotTriggerRole === "assistant" || data.cotTriggerRole === "system") {
          s.cotTriggerRole = data.cotTriggerRole;
        }
        if (data.promptTemplateRole === "user" || data.promptTemplateRole === "assistant" || data.promptTemplateRole === "system") {
          s.promptTemplateRole = data.promptTemplateRole;
        }
        if (typeof data.extraPrompt === "string") s.extraPrompt = data.extraPrompt;
        await this.plugin.saveSettings();
        this.display();
        new Notice("Prompts imported");
      } catch (err) {
        new Notice(`Import failed: ${(err as Error).message}`);
      }
    });

    input.addEventListener("cancel", () => {
      if (document.body.contains(input)) document.body.removeChild(input);
    });

    input.click();
  }
}
