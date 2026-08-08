import { classifyImage } from "./classifier.js";
import { CatalogDatabase } from "./database.js";
import { prepareImage } from "./image.js";
import { buildSearchDocument, documentHash } from "./embeddings.js";
import { exportFoundryCatalog } from "./exporter.js";
import { buildFoundryModule } from "./module-builder.js";
import { OllamaClient } from "./ollama.js";
import { loadTaxonomy } from "./taxonomy.js";

export class CatalogApp {
  constructor(config) {
    this.config = config;
    this.taxonomy = loadTaxonomy(config.classification.taxonomyFile);
    this.database = new CatalogDatabase(config.storage.database);
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
