import { mkdir, copyFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredTarget = process.env.OBSIDIAN_PLUGIN_DEST;
const target = configuredTarget
  ? path.resolve(repoRoot, configuredTarget)
  : path.join(repoRoot, "test", "test", ".obsidian", "plugins", "obsidian-llm-ghost-completion");

const files = ["main.js", "styles.css", "manifest.json"];

await mkdir(target, { recursive: true });
for (const file of files) {
  await copyFile(path.join(repoRoot, file), path.join(target, file));
}

console.log(`Published plugin to ${target}`);
