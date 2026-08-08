import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildInferenceSchema, impliedTagKeys, loadTaxonomy, normalizeInference, tagsMatchingFilter, taxonomyForPrompt, validateTaxonomy } from "../src/taxonomy.js";

const taxonomy = loadTaxonomy(path.resolve("taxonomy/taxonomy.json"));

test("taxonomy loads and produces a strict schema", () => {
  const schema = buildInferenceSchema(taxonomy);
  assert.equal(taxonomy.version, "1.0.0");
  assert.ok(schema.properties.tags.items.properties.category.enum.includes("morphology"));
  assert.ok(schema.properties.tags.items.properties.tag.enum.includes("canine"));
  assert.equal(schema.additionalProperties, false);
});

test("normalization rejects invalid category/tag pairs", () => {
  const normalized = normalizeInference({
    caption: "A wolf-like humanoid stands in a combat pose.",
    visible_features: ["canine head", "gray fur"],
    tags: [
      { category: "morphology", tag: "canine", confidence: 0.98, evidence: "Canine muzzle" },
      { category: "morphology", tag: "priest", confidence: 0.95, evidence: "Invalid pair" },
    ],
    suggested_tags: [],
    warnings: [],
  }, taxonomy, { minimumConfidence: 0.55, reviewConfidence: 0.75 });

  assert.deepEqual(normalized.acceptedTags.map((tag) => tag.tag), ["canine"]);
  assert.equal(normalized.rejectedTags.length, 1);
});

test("normalization deduplicates tags and applies category maximums", () => {
  const normalized = normalizeInference({
    caption: "A colorful armored figure shown against a plain background.",
    visible_features: [],
    tags: [
      { category: "armor", tag: "light_armor", confidence: 0.7, evidence: "Leather" },
      { category: "armor", tag: "light_armor", confidence: 0.9, evidence: "Clear leather panels" },
      { category: "armor", tag: "medium_armor", confidence: 0.8, evidence: "Mail" },
      { category: "armor", tag: "heavy_armor", confidence: 0.6, evidence: "Plate" },
    ],
    suggested_tags: [],
    warnings: [],
  }, taxonomy, { minimumConfidence: 0.55, reviewConfidence: 0.75 });

  assert.equal(normalized.acceptedTags.length, 2);
  assert.deepEqual(normalized.acceptedTags.map((tag) => tag.tag), ["light_armor", "medium_armor"]);
  assert.equal(normalized.acceptedTags[0].confidence, 0.9);
});

test("low-confidence tags remain observations rather than accepted tags", () => {
  const normalized = normalizeInference({
    caption: "A distant figure whose ancestry is visually ambiguous.",
    visible_features: ["distant humanoid"],
    tags: [{ category: "ancestry_candidate", tag: "elf", confidence: 0.4, evidence: "Possibly pointed ears" }],
    suggested_tags: [],
    warnings: ["Subject is distant"],
  }, taxonomy, { minimumConfidence: 0.55, reviewConfidence: 0.75 });

  assert.equal(normalized.acceptedTags.length, 0);
  assert.equal(normalized.observationTags.length, 1);
});

test("aliases and implications are described to the model and implication closure expands filters", () => {
  const edited = structuredClone(taxonomy);
  edited.categories.magic_theme.values.fire_magic = {
    label: "Fire Magic",
    aliases: ["pyromancy"],
    description: "Visible supernatural flame or heat.",
    implies: ["element:fire"],
  };
  validateTaxonomy(edited);
  assert.deepEqual(impliedTagKeys(edited, "magic_theme", "fire_magic"), ["magic_theme:fire_magic", "element:fire"]);
  assert.ok(tagsMatchingFilter(edited, "element", "fire").some((item) => item.category === "magic_theme" && item.tag === "fire_magic"));
  const prompt = taxonomyForPrompt(edited);
  assert.match(prompt, /Aliases: pyromancy/);
  assert.match(prompt, /Implies: element:fire/);
  assert.match(prompt, /Visible supernatural flame/);
});

test("taxonomy validation rejects missing targets, cycles, and duplicate aliases", () => {
  const missing = structuredClone(taxonomy);
  missing.categories.element.values.fire.implies = ["element:not_real"];
  assert.throws(() => validateTaxonomy(missing), /missing tag/);

  const cyclic = structuredClone(taxonomy);
  cyclic.categories.element.values.fire.implies = ["element:cold"];
  cyclic.categories.element.values.cold.implies = ["element:fire"];
  assert.throws(() => validateTaxonomy(cyclic), /cycle/);

  const duplicate = structuredClone(taxonomy);
  duplicate.categories.element.values.fire.aliases.push("icy");
  duplicate.categories.element.values.cold.aliases.push("icy");
  assert.throws(() => validateTaxonomy(duplicate), /already used/);
});
