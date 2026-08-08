import fs from "node:fs";

export function loadTaxonomy(filePath) {
  const taxonomy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!taxonomy.version || !taxonomy.categories || typeof taxonomy.categories !== "object") {
    throw new Error("Taxonomy must contain version and categories");
  }

  for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
    if (!category.label || !category.values || typeof category.values !== "object") {
      throw new Error(`Invalid taxonomy category: ${categoryId}`);
    }
    if (!Number.isInteger(category.maximumTags) || category.maximumTags < 1) {
      throw new Error(`Category ${categoryId} must have a positive maximumTags`);
    }
  }
  return taxonomy;
}

export function isAllowedTag(taxonomy, category, tag) {
  return Boolean(taxonomy.categories[category]?.values?.[tag]);
}

export function buildInferenceSchema(taxonomy) {
  const categories = Object.keys(taxonomy.categories);
  const tags = [...new Set(
    Object.values(taxonomy.categories).flatMap((category) => Object.keys(category.values)),
  )];

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      caption: { type: "string", minLength: 10, maxLength: 1200 },
      visible_features: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 160 },
      },
      tags: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string", enum: categories },
            tag: { type: "string", enum: tags },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            evidence: { type: "string", maxLength: 300 },
          },
          required: ["category", "tag", "confidence", "evidence"],
        },
      },
      suggested_tags: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string", maxLength: 80 },
            suggested_category: { type: ["string", "null"], maxLength: 80 },
            reason: { type: "string", maxLength: 300 },
          },
          required: ["label", "suggested_category", "reason"],
        },
      },
      warnings: {
        type: "array",
        maxItems: 10,
        items: { type: "string", maxLength: 300 },
      },
    },
    required: ["caption", "visible_features", "tags", "suggested_tags", "warnings"],
  };
}

export function taxonomyForPrompt(taxonomy) {
  return Object.entries(taxonomy.categories)
    .map(([categoryId, category]) => {
      const values = Object.entries(category.values)
        .map(([tagId, tag]) => `${tagId} (${tag.label})`)
        .join(", ");
      return `- ${categoryId}: ${values}`;
    })
    .join("\n");
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
    if (!isAllowedTag(taxonomy, candidate.category, candidate.tag)) {
      rejected.push({ ...candidate, reason: "unknown category/tag pair" });
      continue;
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      rejected.push({ ...candidate, reason: "invalid confidence" });
      continue;
    }
    const normalized = {
      category: candidate.category,
      tag: candidate.tag,
      confidence,
      evidence: typeof candidate.evidence === "string" ? candidate.evidence.trim() : "",
      accepted: confidence >= options.minimumConfidence,
      needsReview: confidence < options.reviewConfidence,
    };
    const pair = `${normalized.category}\u0000${normalized.tag}`;
    if (!byPair.has(pair) || byPair.get(pair).confidence < confidence) byPair.set(pair, normalized);
  }

  const accepted = [];
  const observations = [];
  for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
    const candidates = [...byPair.values()]
      .filter((tag) => tag.category === categoryId)
      .sort((left, right) => right.confidence - left.confidence);
    for (const candidate of candidates.slice(0, category.maximumTags)) {
      (candidate.accepted ? accepted : observations).push(candidate);
    }
  }

  return {
    caption: raw.caption.trim(),
    visibleFeatures: raw.visible_features.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean),
    acceptedTags: accepted,
    observationTags: observations,
    rejectedTags: rejected,
    suggestedTags: Array.isArray(raw.suggested_tags) ? raw.suggested_tags : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}
