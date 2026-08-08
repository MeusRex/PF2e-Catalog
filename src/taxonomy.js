import fs from "node:fs";

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function tagKey(category, tag) {
  return `${category}:${tag}`;
}

function normalizedWords(value) {
  return String(value).trim().toLocaleLowerCase();
}

export function validateTaxonomy(taxonomy) {
  if (!taxonomy?.version || !taxonomy.categories || typeof taxonomy.categories !== "object" || Array.isArray(taxonomy.categories)) {
    throw new Error("Taxonomy must contain version and categories");
  }
  const known = new Set();
  const names = new Map();
  for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
    if (!ID_PATTERN.test(categoryId)) throw new Error(`Invalid category ID: ${categoryId}`);
    if (!category?.label?.trim() || !category.values || typeof category.values !== "object" || Array.isArray(category.values)) {
      throw new Error(`Invalid taxonomy category: ${categoryId}`);
    }
    if (!Number.isInteger(category.maximumTags) || category.maximumTags < 1) {
      throw new Error(`Category ${categoryId} must have a positive maximumTags`);
    }
    for (const [tagId, tag] of Object.entries(category.values)) {
      if (!ID_PATTERN.test(tagId)) throw new Error(`Invalid tag ID: ${categoryId}:${tagId}`);
      if (!tag?.label?.trim()) throw new Error(`Tag ${categoryId}:${tagId} must have a label`);
      if (tag.aliases != null && (!Array.isArray(tag.aliases) || tag.aliases.some((item) => typeof item !== "string" || !item.trim()))) {
        throw new Error(`Tag ${categoryId}:${tagId} aliases must be non-empty strings`);
      }
      if (tag.implies != null && (!Array.isArray(tag.implies) || tag.implies.some((item) => typeof item !== "string"))) {
        throw new Error(`Tag ${categoryId}:${tagId} implications must be tag references`);
      }
      const localNames = new Set();
      known.add(tagKey(categoryId, tagId));
      for (const name of [tag.label, ...(tag.aliases ?? [])]) {
        const normalized = normalizedWords(name);
        if (localNames.has(normalized)) throw new Error(`Tag ${categoryId}:${tagId} repeats name or alias "${name}"`);
        localNames.add(normalized);
        const owner = names.get(normalized);
        if (owner && owner !== tagKey(categoryId, tagId)) throw new Error(`Name or alias "${name}" is already used by ${owner}`);
        names.set(normalized, tagKey(categoryId, tagId));
      }
    }
  }
  for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
    for (const [tagId, tag] of Object.entries(category.values)) {
      for (const target of tag.implies ?? []) {
        if (!known.has(target)) throw new Error(`Tag ${categoryId}:${tagId} implies missing tag ${target}`);
        if (target === tagKey(categoryId, tagId)) throw new Error(`Tag ${target} cannot imply itself`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) throw new Error(`Taxonomy implication cycle includes ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    const [categoryId, tagId] = key.split(":");
    for (const target of taxonomy.categories[categoryId].values[tagId].implies ?? []) visit(target);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of known) visit(key);
  return taxonomy;
}

export function loadTaxonomy(filePath) {
  return validateTaxonomy(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function saveTaxonomy(filePath, taxonomy) {
  validateTaxonomy(taxonomy);
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(taxonomy, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    fs.unlinkSync(filePath);
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function nextTaxonomyVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return `${version}.1`;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function isAllowedTag(taxonomy, category, tag) {
  return Boolean(taxonomy.categories[category]?.values?.[tag]);
}

export function impliedTagKeys(taxonomy, category, tag) {
  const root = tagKey(category, tag);
  if (!isAllowedTag(taxonomy, category, tag)) return [];
  const result = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    const [currentCategory, currentTag] = current.split(":");
    for (const target of taxonomy.categories[currentCategory].values[currentTag].implies ?? []) {
      if (!result.has(target)) {
        result.add(target);
        queue.push(target);
      }
    }
  }
  return [...result];
}

export function tagsMatchingFilter(taxonomy, category, tag) {
  const target = tagKey(category, tag);
  const matches = [];
  for (const [candidateCategory, group] of Object.entries(taxonomy.categories)) {
    for (const candidateTag of Object.keys(group.values)) {
      if (impliedTagKeys(taxonomy, candidateCategory, candidateTag).includes(target)) {
        matches.push({ category: candidateCategory, tag: candidateTag });
      }
    }
  }
  return matches;
}

export function effectiveTags(taxonomy, tags) {
  const result = new Map();
  for (const item of tags) {
    for (const key of impliedTagKeys(taxonomy, item.category, item.tag)) {
      const [category, tag] = key.split(":");
      const definition = taxonomy.categories[category].values[tag];
      result.set(key, {
        category,
        tag,
        display_name: definition.label,
        inherited: category !== item.category || tag !== item.tag,
      });
    }
  }
  return [...result.values()];
}

export function buildInferenceSchema(taxonomy) {
  const categories = Object.keys(taxonomy.categories);
  const tags = [...new Set(Object.values(taxonomy.categories).flatMap((category) => Object.keys(category.values)))];
  return {
    type: "object", additionalProperties: false,
    properties: {
      caption: { type: "string", minLength: 10, maxLength: 1200 },
      visible_features: { type: "array", maxItems: 20, items: { type: "string", maxLength: 160 } },
      tags: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, properties: {
        category: { type: "string", enum: categories }, tag: { type: "string", enum: tags },
        confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "string", maxLength: 300 },
      }, required: ["category", "tag", "confidence", "evidence"] } },
      suggested_tags: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, properties: {
        label: { type: "string", maxLength: 80 }, suggested_category: { type: ["string", "null"], maxLength: 80 },
        reason: { type: "string", maxLength: 300 },
      }, required: ["label", "suggested_category", "reason"] } },
      warnings: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
    }, required: ["caption", "visible_features", "tags", "suggested_tags", "warnings"],
  };
}

export function taxonomyForPrompt(taxonomy) {
  return Object.entries(taxonomy.categories).map(([categoryId, category]) => {
    const values = Object.entries(category.values).map(([tagId, tag]) => {
      const details = [`Label: ${tag.label}`];
      if (tag.aliases?.length) details.push(`Aliases: ${tag.aliases.join(", ")}`);
      if (tag.description?.trim()) details.push(`Description: ${tag.description.trim()}`);
      if (tag.implies?.length) details.push(`Implies: ${tag.implies.join(", ")}`);
      return `  - ${categoryId}:${tagId} (${details.join("; ")})`;
    }).join("\n");
    return `- ${category.label} [${categoryId}; maximum ${category.maximumTags}]\n${values}`;
  }).join("\n");
}

export function normalizeInference(raw, taxonomy, options) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Inference response must be an object");
  if (typeof raw.caption !== "string" || raw.caption.trim().length < 10) throw new Error("Inference caption is missing or too short");
  if (!Array.isArray(raw.visible_features) || !Array.isArray(raw.tags)) throw new Error("Inference arrays are missing");
  const byPair = new Map();
  const rejected = [];
  for (const candidate of raw.tags) {
    if (!candidate || typeof candidate !== "object") continue;
    const confidence = Number(candidate.confidence);
    if (!isAllowedTag(taxonomy, candidate.category, candidate.tag)) { rejected.push({ ...candidate, reason: "unknown category/tag pair" }); continue; }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) { rejected.push({ ...candidate, reason: "invalid confidence" }); continue; }
    const normalized = { category: candidate.category, tag: candidate.tag, confidence,
      evidence: typeof candidate.evidence === "string" ? candidate.evidence.trim() : "",
      accepted: confidence >= options.minimumConfidence, needsReview: confidence < options.reviewConfidence };
    const pair = `${normalized.category}\u0000${normalized.tag}`;
    if (!byPair.has(pair) || byPair.get(pair).confidence < confidence) byPair.set(pair, normalized);
  }
  const accepted = []; const observations = [];
  for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
    const candidates = [...byPair.values()].filter((tag) => tag.category === categoryId).sort((a, b) => b.confidence - a.confidence);
    for (const candidate of candidates.slice(0, category.maximumTags)) (candidate.accepted ? accepted : observations).push(candidate);
  }
  return { caption: raw.caption.trim(), visibleFeatures: raw.visible_features.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean),
    acceptedTags: accepted, observationTags: observations, rejectedTags: rejected,
    suggestedTags: Array.isArray(raw.suggested_tags) ? raw.suggested_tags : [], warnings: Array.isArray(raw.warnings) ? raw.warnings : [] };
}
