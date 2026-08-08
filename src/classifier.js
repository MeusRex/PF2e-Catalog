import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInferenceSchema, normalizeInference, taxonomyForPrompt } from "./taxonomy.js";

export function loadPrompt(promptVersion) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const promptPath = path.join(projectRoot, "prompts", `${promptVersion}.txt`);
  return fs.readFileSync(promptPath, "utf8").trim();
}

function buildPrompt(basePrompt, taxonomy, previousError = null) {
  const repair = previousError
    ? `\n\nThe previous response was invalid: ${previousError}. Return a corrected response.`
    : "";
  return `${basePrompt}\n\nControlled taxonomy:\n${taxonomyForPrompt(taxonomy)}${repair}`;
}

export async function classifyImage({ imageBuffer, taxonomy, config, client }) {
  const schema = buildInferenceSchema(taxonomy);
  const basePrompt = loadPrompt(config.classification.promptVersion);
  let lastError = null;
  let lastPayload = null;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= config.classification.maxAttempts; attempt += 1) {
    try {
      const prompt = buildPrompt(basePrompt, taxonomy, lastError?.message);
      const result = await client.classify({ imageBuffer, prompt, schema });
      lastPayload = result.payload;
      const raw = JSON.parse(result.content);
      const normalized = normalizeInference(raw, taxonomy, config.classification);
      return {
        raw,
        normalized,
        durationMs: Date.now() - startedAt,
        requestMetadata: {
          endpoint: "/chat",
          schema,
          attempts: attempt,
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const error = new Error(`Classification failed after ${config.classification.maxAttempts} attempts: ${lastError?.message}`);
  error.cause = lastError;
  error.durationMs = Date.now() - startedAt;
  error.lastPayload = lastPayload;
  throw error;
}
