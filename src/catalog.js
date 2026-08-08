import { classifyImage } from "./classifier.js";
import { CatalogDatabase } from "./database.js";
import { prepareImage } from "./image.js";
import { buildSearchDocument, documentHash } from "./embeddings.js";
import { exportFoundryCatalog } from "./exporter.js";
import { buildFoundryModule } from "./module-builder.js";
import { OllamaClient } from "./ollama.js";
import { effectiveTags, loadTaxonomy, nextTaxonomyVersion, saveTaxonomy, tagsMatchingFilter, validateTaxonomy } from "./taxonomy.js";

export class CatalogApp {
  constructor(config) {
    this.config = config;
    this.taxonomy = loadTaxonomy(config.classification.taxonomyFile);
    this.database = new CatalogDatabase(config.storage.database);
    this.database.syncTaxonomy(this.taxonomy);
    this.client = new OllamaClient(config.ollama);
  }

  versions() {
    return {
      model: this.config.ollama.visionModel,
      promptVersion: this.config.classification.promptVersion,
      taxonomyVersion: this.taxonomy.version,
    };
  }

  async indexFile(filePath, { force = false } = {}) {
    const prepared = await prepareImage(filePath, this.config);
    const imageId = this.database.upsertPreparedImage(prepared.record);
    const versions = this.versions();

    if (!force && this.database.hasCurrentClassification(imageId, versions)) {
      return { skipped: true, reason: "current classification already exists", image: this.database.getImageSummary(imageId) };
    }

    const metadata = {
      ...versions,
      request: { endpoint: "/chat", imageSha256: prepared.record.sha256 },
    };
    try {
      const result = await classifyImage({
        imageBuffer: prepared.inferenceBuffer,
        taxonomy: this.taxonomy,
        config: this.config,
        client: this.client,
      });
      metadata.request = { ...metadata.request, ...result.requestMetadata };
      this.database.persistClassification(imageId, metadata, result.raw, result.normalized, this.taxonomy, result.durationMs);
      return { skipped: false, image: this.database.getImageSummary(imageId), warnings: result.normalized.warnings };
    } catch (error) {
      this.database.recordFailedInference(imageId, metadata, error.message, error.durationMs ?? null);
      throw error;
    }
  }

  async enqueueFile(filePath, { force = false } = {}) {
    const prepared = await prepareImage(filePath, this.config);
    const imageId = this.database.upsertPreparedImage(prepared.record);
    const versions = this.versions();
    if (!force && this.database.hasCurrentClassification(imageId, versions)) {
      return { enqueued: false, skipped: true, reason: "current classification already exists", imageId };
    }
    const result = this.database.enqueueClassification(imageId, versions, {
      force,
      maxAttempts: this.config.classification.maxAttempts,
    });
    return { ...result, skipped: !result.enqueued, imageId };
  }

  async processNextJob() {
    const job = this.database.claimNextClassificationJob(this.versions());
    if (!job) return null;
    try {
      const result = await this.indexFile(job.current_path, { force: true });
      const completed = this.database.completeClassificationJob(job.id);
      return { job: completed, result, outcome: "completed" };
    } catch (error) {
      const failed = this.database.failClassificationJob(job.id, error.message);
      return { job: failed, error: error.message, outcome: failed.status === "failed" ? "failed" : "retry_scheduled" };
    }
  }

  async embedCatalog({ force = false, onProgress = null } = {}) {
    const model = this.config.embedding.model;
    const pending = [];
    let skipped = 0;
    for (const imageId of this.database.listEmbeddableImageIds()) {
      const image = this.database.getImageSummary(imageId);
      image.effective_tags = effectiveTags(this.taxonomy, image.tags);
      const document = buildSearchDocument(image);
      const hash = documentHash(document);
      const existing = this.database.getImageEmbedding(imageId, model);
      if (!force && existing?.document_hash === hash) {
        skipped += 1;
        continue;
      }
      pending.push({ imageId, document, hash, filename: image.filename });
    }

    let embedded = 0;
    const batchSize = this.config.embedding.batchSize;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const vectors = await this.client.embed(batch.map((item) => item.document), model);
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index];
        this.database.upsertImageEmbedding(item.imageId, model, item.hash, vectors[index]);
        embedded += 1;
        onProgress?.({ embedded, total: pending.length, filename: item.filename });
      }
    }
    return { model, embedded, skipped, total: embedded + skipped };
  }

  async searchImages(options = {}) {
    options = {
      ...options,
      tags: (options.tags ?? []).map((item) => ({ ...item, matches: tagsMatchingFilter(this.taxonomy, item.category, item.tag) })),
    };
    const mode = options.mode ?? "keyword";
    if (mode !== "semantic" || !options.query?.trim()) return this.database.listImages(options);
    const [queryVector] = await this.client.embed(options.query.trim(), this.config.embedding.model);
    const matches = this.database.semanticMatches(
      queryVector,
      this.config.embedding.model,
      this.config.embedding.semanticCandidateLimit,
    );
    const scores = new Map(matches.map((match) => [match.imageId, match.score]));
    return this.database.listImages({
      ...options,
      query: "",
      rankedIds: matches.map((match) => match.imageId),
      scores,
    });
  }

  updateTaxonomy(mutator) {
    const updated = structuredClone(this.taxonomy);
    mutator(updated);
    updated.version = nextTaxonomyVersion(this.taxonomy.version);
    validateTaxonomy(updated);
    saveTaxonomy(this.config.classification.taxonomyFile, updated);
    this.taxonomy = updated;
    this.database.syncTaxonomy(updated);
    return updated;
  }

  createCategory({ id, label, maximumTags }) {
    return this.updateTaxonomy((taxonomy) => {
      if (taxonomy.categories[id]) throw new Error(`Category ${id} already exists`);
      taxonomy.categories[id] = { label: String(label ?? "").trim(), maximumTags: Number(maximumTags), values: {} };
    });
  }

  updateCategory(categoryId, { label, maximumTags }) {
    return this.updateTaxonomy((taxonomy) => {
      const category = taxonomy.categories[categoryId];
      if (!category) throw new Error(`Category ${categoryId} does not exist`);
      if (label != null) category.label = String(label).trim();
      if (maximumTags != null) category.maximumTags = Number(maximumTags);
    });
  }

  createTag(categoryId, { id, label, aliases = [], description = "", implies = [] }) {
    return this.updateTaxonomy((taxonomy) => {
      const category = taxonomy.categories[categoryId];
      if (!category) throw new Error(`Category ${categoryId} does not exist`);
      if (category.values[id]) throw new Error(`Tag ${categoryId}:${id} already exists`);
      category.values[id] = { label: String(label ?? "").trim(), aliases, ...(String(description).trim() ? { description: String(description).trim() } : {}), implies };
    });
  }

  updateTag(categoryId, tagId, { label, aliases, description, implies }) {
    return this.updateTaxonomy((taxonomy) => {
      const tag = taxonomy.categories[categoryId]?.values?.[tagId];
      if (!tag) throw new Error(`Tag ${categoryId}:${tagId} does not exist`);
      if (label != null) tag.label = String(label).trim();
      if (aliases != null) tag.aliases = aliases;
      if (description != null) {
        if (String(description).trim()) tag.description = String(description).trim();
        else delete tag.description;
      }
      if (implies != null) tag.implies = implies;
    });
  }

  deleteTag(categoryId, tagId) {
    const key = `${categoryId}:${tagId}`;
    if ((this.database.taxonomyUsage()[key] ?? 0) > 0) throw new Error(`Tag ${key} is assigned to images; merge it instead`);
    return this.updateTaxonomy((taxonomy) => {
      if (!taxonomy.categories[categoryId]?.values?.[tagId]) throw new Error(`Tag ${key} does not exist`);
      for (const category of Object.values(taxonomy.categories)) {
        for (const tag of Object.values(category.values)) {
          if (tag.implies?.includes(key)) throw new Error(`Tag ${key} is implied by another tag; remove that relationship first`);
        }
      }
      delete taxonomy.categories[categoryId].values[tagId];
    });
  }

  mergeTag(sourceCategory, sourceTag, targetCategory, targetTag) {
    const sourceKey = `${sourceCategory}:${sourceTag}`;
    const targetKey = `${targetCategory}:${targetTag}`;
    if (sourceKey === targetKey) throw new Error("A tag cannot be merged into itself");
    if (!this.taxonomy.categories[targetCategory]?.values?.[targetTag]) throw new Error(`Target tag ${targetKey} does not exist`);
    const sourceDefinition = this.taxonomy.categories[sourceCategory]?.values?.[sourceTag];
    if (!sourceDefinition) throw new Error(`Source tag ${sourceKey} does not exist`);
    const updated = this.updateTaxonomy((taxonomy) => {
      for (const category of Object.values(taxonomy.categories)) {
        for (const tag of Object.values(category.values)) {
          if (tag.implies?.includes(sourceKey)) tag.implies = [...new Set(tag.implies.map((key) => key === sourceKey ? targetKey : key))];
        }
      }
      const target = taxonomy.categories[targetCategory].values[targetTag];
      const aliases = [...(target.aliases ?? []), sourceDefinition.label, ...(sourceDefinition.aliases ?? [])];
      target.aliases = aliases.filter((alias, index) => alias.toLocaleLowerCase() !== target.label.toLocaleLowerCase()
        && aliases.findIndex((candidate) => candidate.toLocaleLowerCase() === alias.toLocaleLowerCase()) === index);
      delete taxonomy.categories[sourceCategory].values[sourceTag];
    });
    const affectedImages = this.database.mergeTag(sourceCategory, sourceTag, targetCategory, targetTag);
    return { taxonomy: updated, affectedImages };
  }

  exportFoundry(options = {}) {
    return exportFoundryCatalog({
      database: this.database,
      taxonomy: this.taxonomy,
      config: this.config,
      ...options,
    });
  }

  packageFoundry(options = {}) {
    const exportResult = this.exportFoundry(options);
    return buildFoundryModule({config: this.config, exportResult});
  }

  close() {
    this.database.close();
  }
}
