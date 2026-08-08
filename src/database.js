import path from "node:path";
import Database from "better-sqlite3";
import { cosineSimilarity, decodeVector, encodeVector } from "./embeddings.js";
import { effectiveTags } from "./taxonomy.js";

export class CatalogDatabase {
  constructor(databasePath) {
    this.databasePath = path.resolve(databasePath);
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        perceptual_hash TEXT,
        current_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        extension TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        thumbnail_path TEXT NOT NULL,
        caption TEXT,
        visible_features_json TEXT NOT NULL DEFAULT '[]',
        review_status TEXT NOT NULL DEFAULT 'unclassified',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS image_locations (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        is_current INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY,
        category TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        taxonomy_version TEXT NOT NULL,
        UNIQUE(category, canonical_name)
      );

      CREATE TABLE IF NOT EXISTS image_tags (
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        confidence REAL NOT NULL,
        evidence TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        reviewed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(image_id, tag_id, source)
      );

      CREATE TABLE IF NOT EXISTS inference_runs (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        taxonomy_version TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tag_suggestions (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        suggested_category TEXT,
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS classification_jobs (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        taxonomy_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        re_evaluation INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(image_id, model, prompt_version, taxonomy_version)
      );

      CREATE TABLE IF NOT EXISTS image_embeddings (
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(image_id, model)
      );

      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_image_tags_image ON image_tags(image_id);
      CREATE INDEX IF NOT EXISTS idx_inference_lookup ON inference_runs(image_id, model, prompt_version, taxonomy_version, status);
      CREATE INDEX IF NOT EXISTS idx_classification_jobs_claim ON classification_jobs(status, available_at, id);

      CREATE VIRTUAL TABLE IF NOT EXISTS image_search USING fts5(
        image_id UNINDEXED,
        filename,
        caption,
        visible_features,
        tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    const suggestionColumns = new Set(this.db.prepare("PRAGMA table_info(tag_suggestions)").all().map((column) => column.name));
    if (!suggestionColumns.has("mapped_category")) this.db.exec("ALTER TABLE tag_suggestions ADD COLUMN mapped_category TEXT");
    if (!suggestionColumns.has("mapped_tag")) this.db.exec("ALTER TABLE tag_suggestions ADD COLUMN mapped_tag TEXT");
    const jobColumns = new Set(this.db.prepare("PRAGMA table_info(classification_jobs)").all().map((column) => column.name));
    if (!jobColumns.has("re_evaluation")) this.db.exec("ALTER TABLE classification_jobs ADD COLUMN re_evaluation INTEGER NOT NULL DEFAULT 0");
  }

  upsertPreparedImage(image) {
    const existing = this.db.prepare("SELECT id FROM images WHERE sha256 = ?").get(image.sha256);
    let imageId;
    if (existing) {
      imageId = existing.id;
      this.db.prepare(`
        UPDATE images SET current_path = ?, filename = ?, extension = ?, width = ?, height = ?,
          file_size = ?, modified_at = ?, thumbnail_path = ?, perceptual_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(image.path, image.filename, image.extension, image.width, image.height, image.fileSize,
        image.modifiedAt, image.thumbnailPath, image.perceptualHash, imageId);
    } else {
      const result = this.db.prepare(`
        INSERT INTO images
          (sha256, perceptual_hash, current_path, filename, extension, width, height, file_size, modified_at, thumbnail_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(image.sha256, image.perceptualHash, image.path, image.filename, image.extension,
        image.width, image.height, image.fileSize, image.modifiedAt, image.thumbnailPath);
      imageId = Number(result.lastInsertRowid);
    }

    this.db.prepare(`
      INSERT INTO image_locations (image_id, path, is_current, last_seen_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(path) DO UPDATE SET image_id = excluded.image_id, is_current = 1, last_seen_at = CURRENT_TIMESTAMP
    `).run(imageId, image.path);
    this.refreshSearchDocument(imageId);
    return imageId;
  }

  hasCurrentClassification(imageId, versions) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM inference_runs
      WHERE image_id = ? AND model = ? AND prompt_version = ? AND taxonomy_version = ? AND status = 'completed'
      LIMIT 1
    `).get(imageId, versions.model, versions.promptVersion, versions.taxonomyVersion));
  }

  hasBeenHandled(imageId) {
    const image = this.db.prepare("SELECT review_status FROM images WHERE id = ?").get(imageId);
    return Boolean(image && image.review_status !== "unclassified");
  }

  recordFailedInference(imageId, metadata, error, durationMs) {
    this.db.prepare(`
      INSERT INTO inference_runs
        (image_id, model, prompt_version, taxonomy_version, request_json, duration_ms, status, error)
      VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)
    `).run(imageId, metadata.model, metadata.promptVersion, metadata.taxonomyVersion,
      JSON.stringify(metadata.request), durationMs, String(error));
  }

  persistClassification(imageId, metadata, rawResponse, normalized, taxonomy, durationMs, { overwriteHumanReview = false } = {}) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO inference_runs
          (image_id, model, prompt_version, taxonomy_version, request_json, response_json, duration_ms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(imageId, metadata.model, metadata.promptVersion, metadata.taxonomyVersion,
        JSON.stringify(metadata.request), JSON.stringify(rawResponse), durationMs);

      const current = this.db.prepare("SELECT review_status FROM images WHERE id = ?").get(imageId);
      if (current?.review_status === "reviewed" && !overwriteHumanReview) {
        this.refreshSearchDocument(imageId);
        return;
      }

      this.db.prepare(`
        UPDATE images SET caption = ?, visible_features_json = ?, review_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(normalized.caption, JSON.stringify(normalized.visibleFeatures),
        normalized.acceptedTags.some((tag) => tag.needsReview) ? "needs_review" : "classified", imageId);
      this.db.prepare("DELETE FROM image_embeddings WHERE image_id = ?").run(imageId);

      this.db.prepare("DELETE FROM image_tags WHERE image_id = ? AND source = 'model'").run(imageId);
      const upsertTag = this.db.prepare(`
        INSERT INTO tags (category, canonical_name, display_name, taxonomy_version)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(category, canonical_name) DO UPDATE SET display_name = excluded.display_name,
          taxonomy_version = excluded.taxonomy_version
        RETURNING id
      `);
      const insertImageTag = this.db.prepare(`
        INSERT INTO image_tags (image_id, tag_id, confidence, evidence, source, reviewed)
        VALUES (?, ?, ?, ?, 'model', ?)
      `);
      for (const tag of normalized.acceptedTags) {
        const displayName = taxonomy.categories[tag.category].values[tag.tag].label;
        const tagId = upsertTag.get(tag.category, tag.tag, displayName, taxonomy.version).id;
        insertImageTag.run(imageId, tagId, tag.confidence, tag.evidence, tag.needsReview ? 0 : 1);
      }

      this.db.prepare("DELETE FROM tag_suggestions WHERE image_id = ? AND status = 'pending'").run(imageId);
      const insertSuggestion = this.db.prepare(`
        INSERT INTO tag_suggestions (image_id, label, suggested_category, reason)
        VALUES (?, ?, ?, ?)
      `);
      for (const suggestion of normalized.suggestedTags) {
        if (suggestion?.label) insertSuggestion.run(imageId, suggestion.label, suggestion.suggested_category ?? null, suggestion.reason ?? "");
      }
      this.refreshSearchDocument(imageId);
    });
    transaction();
  }

  refreshSearchDocument(imageId, taxonomy = this.taxonomy) {
    const image = this.db.prepare(`
      SELECT filename, COALESCE(caption, '') AS caption, visible_features_json
      FROM images WHERE id = ?
    `).get(imageId);
    if (!image) return;
    const tags = this.db.prepare(`
      SELECT tags.category, tags.canonical_name, tags.display_name
      FROM image_tags JOIN tags ON tags.id = image_tags.tag_id
      WHERE image_tags.image_id = ?
    `).all(imageId);
    let visibleFeatures = [];
    try {
      visibleFeatures = JSON.parse(image.visible_features_json);
    } catch {
      visibleFeatures = [];
    }
    const indexedTags = taxonomy
      ? effectiveTags(taxonomy, tags.map((tag) => ({ category: tag.category, tag: tag.canonical_name })))
      : tags.map((tag) => ({ category: tag.category, tag: tag.canonical_name, display_name: tag.display_name }));
    const tagText = indexedTags.flatMap((tag) => {
      const definition = taxonomy?.categories[tag.category]?.values?.[tag.tag];
      return [tag.tag.replaceAll("_", " "), tag.display_name, ...(definition?.aliases ?? [])];
    }).join(" ");
    this.db.prepare("DELETE FROM image_search WHERE image_id = ?").run(String(imageId));
    this.db.prepare(`
      INSERT INTO image_search (image_id, filename, caption, visible_features, tags)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(imageId), image.filename, image.caption, visibleFeatures.join(" "), tagText);
  }

  rebuildSearchIndex(taxonomy = this.taxonomy) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM image_search").run();
      const ids = this.db.prepare("SELECT id FROM images ORDER BY id").all();
      for (const { id } of ids) this.refreshSearchDocument(id, taxonomy);
    });
    transaction();
  }

  syncTaxonomy(taxonomy) {
    this.taxonomy = taxonomy;
    const signature = JSON.stringify(taxonomy);
    const existingSignature = this.db.prepare("SELECT value FROM app_metadata WHERE key = 'taxonomy_search_signature'").get()?.value;
    const update = this.db.prepare(`
      INSERT INTO tags (display_name, taxonomy_version, category, canonical_name) VALUES (?, ?, ?, ?)
      ON CONFLICT(category, canonical_name) DO UPDATE SET display_name = excluded.display_name,
        taxonomy_version = excluded.taxonomy_version
    `);
    const transaction = this.db.transaction(() => {
      for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
        for (const [tagId, tag] of Object.entries(category.values)) update.run(tag.label, taxonomy.version, categoryId, tagId);
      }
      if (existingSignature !== signature) {
        this.rebuildSearchIndex(taxonomy);
        this.db.prepare("DELETE FROM image_embeddings").run();
        this.db.prepare(`INSERT INTO app_metadata (key, value) VALUES ('taxonomy_search_signature', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(signature);
      }
    });
    transaction();
  }

  updateHumanReview(imageId, { caption, tags }, taxonomy) {
    if (typeof caption !== "string" || !caption.trim()) throw new Error("A reviewed caption is required");
    if (!Array.isArray(tags)) throw new Error("Reviewed tags must be an array");
    const uniqueTags = new Map();
    for (const item of tags) {
      if (!item || !taxonomy.categories[item.category]?.values?.[item.tag]) {
        throw new Error(`Unknown taxonomy tag: ${item?.category ?? "?"}:${item?.tag ?? "?"}`);
      }
      uniqueTags.set(`${item.category}\u0000${item.tag}`, item);
    }

    const transaction = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM images WHERE id = ?").get(imageId)) throw new Error(`Image ${imageId} does not exist`);
      this.db.prepare("DELETE FROM image_tags WHERE image_id = ?").run(imageId);
      const upsertTag = this.db.prepare(`
        INSERT INTO tags (category, canonical_name, display_name, taxonomy_version)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(category, canonical_name) DO UPDATE SET display_name = excluded.display_name,
          taxonomy_version = excluded.taxonomy_version
        RETURNING id
      `);
      const insertImageTag = this.db.prepare(`
        INSERT INTO image_tags (image_id, tag_id, confidence, evidence, source, reviewed)
        VALUES (?, ?, 1, 'Human-reviewed', 'human', 1)
      `);
      for (const item of uniqueTags.values()) {
        const displayName = taxonomy.categories[item.category].values[item.tag].label;
        const tagId = upsertTag.get(item.category, item.tag, displayName, taxonomy.version).id;
        insertImageTag.run(imageId, tagId);
      }
      this.db.prepare(`
        UPDATE images SET caption = ?, review_status = 'reviewed', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(caption.trim(), imageId);
      this.db.prepare("DELETE FROM image_embeddings WHERE image_id = ?").run(imageId);
      this.refreshSearchDocument(imageId);
    });
    transaction();
    return this.getImageSummary(imageId);
  }

  listImages({ query = "", tags = [], reviewStatus = "", page = 1, pageSize = 48, sort = "updated", rankedIds = null, scores = null } = {}) {
    const conditions = [];
    const parameters = [];
    const tokens = query.trim().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (tokens.length) {
      const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
      conditions.push("i.id IN (SELECT CAST(image_id AS INTEGER) FROM image_search WHERE image_search MATCH ?)");
      parameters.push(ftsQuery);
    }
    if (reviewStatus) {
      conditions.push("i.review_status = ?");
      parameters.push(reviewStatus);
    }
    if (rankedIds) {
      const safeIds = rankedIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
      if (!safeIds.length) return { items: [], total: 0, page: 1, pageSize: Math.max(1, Math.min(200, Number(pageSize) || 48)), pages: 0 };
      conditions.push(`i.id IN (${safeIds.map(() => "?").join(",")})`);
      parameters.push(...safeIds);
    }
    for (const item of tags) {
      const matches = item.matches?.length ? item.matches : [item];
      conditions.push(`EXISTS (
        SELECT 1 FROM image_tags it_filter JOIN tags t_filter ON t_filter.id = it_filter.tag_id
        WHERE it_filter.image_id = i.id AND (${matches.map(() => "(t_filter.category = ? AND t_filter.canonical_name = ?)").join(" OR ")})
      )`);
      for (const match of matches) parameters.push(match.category, match.tag);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const semanticOrder = rankedIds
      ? `CASE i.id ${rankedIds.map((id, index) => `WHEN ${Number(id)} THEN ${index}`).join(" ")} ELSE ${rankedIds.length} END`
      : null;
    const orderBy = semanticOrder ?? ({
      filename: "i.filename COLLATE NOCASE ASC",
      created: "i.created_at DESC",
      updated: "i.updated_at DESC",
      random: "RANDOM()",
    }[sort] ?? "i.updated_at DESC");
    const safePageSize = Math.max(1, Math.min(200, Number(pageSize) || 48));
    const safePage = Math.max(1, Number(page) || 1);
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM images i ${where}`).get(...parameters).count;
    const rows = this.db.prepare(`
      SELECT i.id, i.sha256, i.filename, i.width, i.height, i.caption, i.review_status,
        i.thumbnail_path, i.current_path, i.created_at, i.updated_at
      FROM images i ${where}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...parameters, safePageSize, (safePage - 1) * safePageSize);
    for (const image of rows) {
      image.tags = this.db.prepare(`
        SELECT tags.category, tags.canonical_name AS tag, tags.display_name, image_tags.confidence,
          image_tags.source, image_tags.reviewed
        FROM image_tags JOIN tags ON tags.id = image_tags.tag_id
        WHERE image_tags.image_id = ? ORDER BY tags.category, image_tags.confidence DESC
      `).all(image.id);
      if (scores?.has(image.id)) image.semantic_score = scores.get(image.id);
    }
    return { items: rows, total, page: safePage, pageSize: safePageSize, pages: Math.ceil(total / safePageSize) };
  }

  listEmbeddableImageIds() {
    return this.db.prepare("SELECT id FROM images WHERE caption IS NOT NULL AND trim(caption) <> '' ORDER BY id").all().map((row) => row.id);
  }

  getImageEmbedding(imageId, model) {
    return this.db.prepare(`
      SELECT image_id, model, document_hash, dimensions, created_at, updated_at
      FROM image_embeddings WHERE image_id = ? AND model = ?
    `).get(imageId, model) ?? null;
  }

  upsertImageEmbedding(imageId, model, documentHash, vector) {
    const encoded = encodeVector(vector);
    this.db.prepare(`
      INSERT INTO image_embeddings (image_id, model, document_hash, dimensions, vector)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(image_id, model) DO UPDATE SET document_hash = excluded.document_hash,
        dimensions = excluded.dimensions, vector = excluded.vector, updated_at = CURRENT_TIMESTAMP
    `).run(imageId, model, documentHash, vector.length, encoded);
    return this.getImageEmbedding(imageId, model);
  }

  semanticMatches(queryVector, model, limit = 500) {
    const safeLimit = Math.max(1, Math.min(10_000, Number(limit) || 500));
    const rows = this.db.prepare(`
      SELECT image_id, dimensions, vector FROM image_embeddings WHERE model = ?
    `).all(model);
    return rows
      .map((row) => ({
        imageId: row.image_id,
        score: cosineSimilarity(queryVector, decodeVector(row.vector, row.dimensions)),
      }))
      .filter((match) => Number.isFinite(match.score))
      .sort((left, right) => right.score - left.score)
      .slice(0, safeLimit);
  }

  listExportImages({ includeUnclassified = true } = {}) {
    const rows = this.db.prepare(`
      SELECT id FROM images ${includeUnclassified ? "" : "WHERE caption IS NOT NULL"}
      ORDER BY sha256
    `).all();
    return rows.map((row) => this.getImageSummary(row.id));
  }

  taxonomyUsage() {
    return Object.fromEntries(this.db.prepare(`
      SELECT tags.category || ':' || tags.canonical_name AS key, COUNT(DISTINCT image_tags.image_id) AS count
      FROM tags LEFT JOIN image_tags ON image_tags.tag_id = tags.id GROUP BY tags.id
    `).all().map((row) => [row.key, row.count]));
  }

  mergeTag(sourceCategory, sourceTag, targetCategory, targetTag) {
    const source = this.db.prepare("SELECT id FROM tags WHERE category = ? AND canonical_name = ?").get(sourceCategory, sourceTag);
    if (!source) return 0;
    const target = this.db.prepare("SELECT id FROM tags WHERE category = ? AND canonical_name = ?").get(targetCategory, targetTag);
    const transaction = this.db.transaction(() => {
      let targetId = target?.id;
      if (!targetId) throw new Error(`Target tag ${targetCategory}:${targetTag} has never been synchronized`);
      const rows = this.db.prepare("SELECT * FROM image_tags WHERE tag_id = ?").all(source.id);
      const insert = this.db.prepare(`INSERT OR IGNORE INTO image_tags
        (image_id, tag_id, confidence, evidence, source, reviewed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) insert.run(row.image_id, targetId, row.confidence, row.evidence, row.source, row.reviewed, row.created_at);
      this.db.prepare("DELETE FROM image_tags WHERE tag_id = ?").run(source.id);
      this.db.prepare("DELETE FROM tags WHERE id = ?").run(source.id);
      return new Set(rows.map((row) => row.image_id));
    });
    const affected = transaction();
    for (const imageId of affected) this.refreshSearchDocument(imageId);
    return affected.size;
  }

  getImageSummary(imageId) {
    const image = this.db.prepare("SELECT * FROM images WHERE id = ?").get(imageId);
    if (!image) return null;
    image.tags = this.db.prepare(`
      SELECT tags.category, tags.canonical_name AS tag, tags.display_name, image_tags.confidence,
        image_tags.evidence, image_tags.source, image_tags.reviewed
      FROM image_tags JOIN tags ON tags.id = image_tags.tag_id
      WHERE image_tags.image_id = ? ORDER BY tags.category, image_tags.confidence DESC
    `).all(imageId);
    image.visible_features = JSON.parse(image.visible_features_json);
    delete image.visible_features_json;
    return image;
  }

  getStatus() {
    const images = this.db.prepare("SELECT COUNT(*) AS count FROM images").get().count;
    const classified = this.db.prepare("SELECT COUNT(*) AS count FROM images WHERE caption IS NOT NULL").get().count;
    const needsReview = this.db.prepare("SELECT COUNT(*) AS count FROM images WHERE review_status = 'needs_review'").get().count;
    const reviewed = this.db.prepare("SELECT COUNT(*) AS count FROM images WHERE review_status = 'reviewed'").get().count;
    const failedRuns = this.db.prepare(`
      SELECT COUNT(*) AS count FROM inference_runs run
      WHERE run.status = 'failed' AND run.id = (
        SELECT MAX(latest.id) FROM inference_runs latest WHERE latest.image_id = run.image_id
      )
    `).get().count;
    const pendingSuggestions = this.db.prepare("SELECT COUNT(*) AS count FROM tag_suggestions WHERE status = 'pending'").get().count;
    const embeddings = this.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings").get().count;
    const queue = Object.fromEntries(this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM classification_jobs GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    return {
      images,
      classified,
      unclassified: images - classified,
      needsReview,
      reviewed,
      failedRuns,
      pendingSuggestions,
      embeddings,
      queue: {
        pending: queue.pending ?? 0,
        running: queue.running ?? 0,
        completed: queue.completed ?? 0,
        failed: queue.failed ?? 0,
      },
    };
  }

  enqueueClassification(imageId, versions, { force = false, maxAttempts = 3, reEvaluation = false } = {}) {
    const existing = this.db.prepare(`
      SELECT * FROM classification_jobs
      WHERE image_id = ? AND model = ? AND prompt_version = ? AND taxonomy_version = ?
    `).get(imageId, versions.model, versions.promptVersion, versions.taxonomyVersion);
    if (existing?.status === "running") {
      return { job: existing, enqueued: false, reason: "classification is already running" };
    }
    if (existing && !force && ["pending", "completed"].includes(existing.status)) {
      return { job: existing, enqueued: false };
    }
    if (existing) {
      this.db.prepare(`
        UPDATE classification_jobs SET status = 'pending', attempts = 0, max_attempts = ?, re_evaluation = ?,
          available_at = CURRENT_TIMESTAMP, started_at = NULL, completed_at = NULL,
          last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(maxAttempts, reEvaluation ? 1 : 0, existing.id);
      return { job: this.getClassificationJob(existing.id), enqueued: true };
    }
    const result = this.db.prepare(`
      INSERT INTO classification_jobs
        (image_id, model, prompt_version, taxonomy_version, max_attempts, re_evaluation)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(imageId, versions.model, versions.promptVersion, versions.taxonomyVersion, maxAttempts, reEvaluation ? 1 : 0);
    return { job: this.getClassificationJob(Number(result.lastInsertRowid)), enqueued: true };
  }

  getClassificationJob(jobId) {
    return this.db.prepare(`
      SELECT job.*, images.filename, images.current_path, images.thumbnail_path
      FROM classification_jobs job JOIN images ON images.id = job.image_id WHERE job.id = ?
    `).get(jobId);
  }

  claimNextClassificationJob(versions = null) {
    const transaction = this.db.transaction(() => {
      const versionClause = versions
        ? "AND model = ? AND prompt_version = ? AND taxonomy_version = ?"
        : "";
      const versionParameters = versions
        ? [versions.model, versions.promptVersion, versions.taxonomyVersion]
        : [];
      const candidate = this.db.prepare(`
        SELECT id FROM classification_jobs
        WHERE status = 'pending' AND datetime(available_at) <= datetime('now')
          ${versionClause}
        ORDER BY available_at, id LIMIT 1
      `).get(...versionParameters);
      if (!candidate) return null;
      this.db.prepare(`
        UPDATE classification_jobs SET status = 'running', attempts = attempts + 1,
          started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'
      `).run(candidate.id);
      return this.getClassificationJob(candidate.id);
    });
    return transaction.immediate();
  }

  completeClassificationJob(jobId) {
    const result = this.db.prepare(`
      UPDATE classification_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
        last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'
    `).run(jobId);
    if (!result.changes) throw new Error(`Running classification job ${jobId} does not exist`);
    return this.getClassificationJob(jobId);
  }

  failClassificationJob(jobId, error, { retryDelaySeconds } = {}) {
    const job = this.getClassificationJob(jobId);
    if (!job || job.status !== "running") throw new Error(`Running classification job ${jobId} does not exist`);
    const shouldRetry = job.attempts < job.max_attempts;
    const delay = retryDelaySeconds ?? Math.min(300, 5 * (2 ** Math.max(0, job.attempts - 1)));
    if (shouldRetry) {
      this.db.prepare(`
        UPDATE classification_jobs SET status = 'pending', available_at = datetime('now', ?),
          last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(`+${delay} seconds`, String(error), jobId);
    } else {
      this.db.prepare(`
        UPDATE classification_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
          last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(String(error), jobId);
    }
    return this.getClassificationJob(jobId);
  }

  recoverStaleClassificationJobs(staleAfterMinutes = 30) {
    const safeMinutes = Math.max(1, Math.min(1440, Number(staleAfterMinutes) || 30));
    return this.db.prepare(`
      UPDATE classification_jobs SET status = 'pending', available_at = CURRENT_TIMESTAMP,
        started_at = NULL, last_error = 'Recovered after interrupted worker', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running' AND datetime(started_at) <= datetime('now', ?)
    `).run(`-${safeMinutes} minutes`).changes;
  }

  listClassificationJobs({ status = "", page = 1, pageSize = 50 } = {}) {
    const allowedStatuses = new Set(["", "pending", "running", "completed", "failed"]);
    if (!allowedStatuses.has(status)) throw new Error(`Invalid job status: ${status}`);
    const safePageSize = Math.max(1, Math.min(200, Number(pageSize) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const where = status ? "WHERE job.status = ?" : "";
    const parameters = status ? [status] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM classification_jobs job ${where}`).get(...parameters).count;
    const items = this.db.prepare(`
      SELECT job.*, images.filename, images.thumbnail_path
      FROM classification_jobs job JOIN images ON images.id = job.image_id ${where}
      ORDER BY job.updated_at DESC, job.id DESC LIMIT ? OFFSET ?
    `).all(...parameters, safePageSize, (safePage - 1) * safePageSize);
    return { items, total, page: safePage, pageSize: safePageSize, pages: Math.ceil(total / safePageSize) };
  }

  deletePendingClassificationJob(jobId) {
    const job = this.getClassificationJob(jobId);
    if (!job) throw new Error(`Classification job ${jobId} does not exist`);
    if (job.status !== "pending") throw new Error(`Only pending jobs can be removed; job ${jobId} is ${job.status}`);
    this.db.prepare("DELETE FROM classification_jobs WHERE id = ? AND status = 'pending'").run(jobId);
    return { removed: 1, id: jobId };
  }

  deletePendingClassificationJobs() {
    return { removed: this.db.prepare("DELETE FROM classification_jobs WHERE status = 'pending'").run().changes };
  }

  listFailedInferences({ page = 1, pageSize = 25 } = {}) {
    const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
    const safePage = Math.max(1, Number(page) || 1);
    const latestFailureWhere = `run.status = 'failed' AND run.id = (
      SELECT MAX(latest.id) FROM inference_runs latest WHERE latest.image_id = run.image_id
    )`;
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM inference_runs run WHERE ${latestFailureWhere}`).get().count;
    const items = this.db.prepare(`
      SELECT run.id, run.image_id, run.model, run.prompt_version, run.taxonomy_version,
        run.error, run.duration_ms, run.created_at, images.filename, images.thumbnail_path
      FROM inference_runs run JOIN images ON images.id = run.image_id
      WHERE ${latestFailureWhere}
      ORDER BY run.created_at DESC LIMIT ? OFFSET ?
    `).all(safePageSize, (safePage - 1) * safePageSize);
    return { items, total, page: safePage, pageSize: safePageSize, pages: Math.ceil(total / safePageSize) };
  }

  listTagSuggestions({ status = "pending", page = 1, pageSize = 50 } = {}) {
    const allowedStatuses = new Set(["pending", "mapped", "rejected"]);
    if (!allowedStatuses.has(status)) throw new Error(`Invalid suggestion status: ${status}`);
    const safePageSize = Math.max(1, Math.min(200, Number(pageSize) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM tag_suggestions WHERE status = ?").get(status).count;
    const items = this.db.prepare(`
      SELECT suggestion.id, suggestion.image_id, suggestion.label, suggestion.suggested_category,
        suggestion.reason, suggestion.status, suggestion.mapped_category, suggestion.mapped_tag,
        suggestion.created_at, images.filename, images.thumbnail_path
      FROM tag_suggestions suggestion JOIN images ON images.id = suggestion.image_id
      WHERE suggestion.status = ? ORDER BY suggestion.created_at DESC LIMIT ? OFFSET ?
    `).all(status, safePageSize, (safePage - 1) * safePageSize);
    return { items, total, page: safePage, pageSize: safePageSize, pages: Math.ceil(total / safePageSize) };
  }

  updateTagSuggestion(suggestionId, status) {
    if (!new Set(["pending", "mapped", "rejected"]).has(status)) throw new Error(`Invalid suggestion status: ${status}`);
    const result = this.db.prepare("UPDATE tag_suggestions SET status = ? WHERE id = ?").run(status, suggestionId);
    if (!result.changes) throw new Error(`Suggestion ${suggestionId} does not exist`);
    return this.db.prepare(`
      SELECT id, image_id, label, suggested_category, reason, status, created_at
      FROM tag_suggestions WHERE id = ?
    `).get(suggestionId);
  }

  mapTagSuggestion(suggestionId, category, tag, taxonomy, { applyToImage = true } = {}) {
    if (!taxonomy.categories[category]?.values?.[tag]) throw new Error(`Unknown taxonomy tag: ${category}:${tag}`);
    const suggestion = this.db.prepare("SELECT * FROM tag_suggestions WHERE id = ?").get(suggestionId);
    if (!suggestion) throw new Error(`Suggestion ${suggestionId} does not exist`);
    const transaction = this.db.transaction(() => {
      if (applyToImage) {
        const definition = taxonomy.categories[category].values[tag];
        const tagId = this.db.prepare(`INSERT INTO tags (category, canonical_name, display_name, taxonomy_version)
          VALUES (?, ?, ?, ?) ON CONFLICT(category, canonical_name) DO UPDATE SET display_name = excluded.display_name,
          taxonomy_version = excluded.taxonomy_version RETURNING id`).get(category, tag, definition.label, taxonomy.version).id;
        this.db.prepare("DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?").run(suggestion.image_id, tagId);
        this.db.prepare(`INSERT INTO image_tags
          (image_id, tag_id, confidence, evidence, source, reviewed) VALUES (?, ?, 1, 'Mapped tag suggestion', 'human', 1)`)
          .run(suggestion.image_id, tagId);
      }
      this.db.prepare(`UPDATE tag_suggestions SET status = 'mapped', mapped_category = ?, mapped_tag = ? WHERE id = ?`)
        .run(category, tag, suggestionId);
      this.db.prepare("DELETE FROM image_embeddings WHERE image_id = ?").run(suggestion.image_id);
      this.refreshSearchDocument(suggestion.image_id, taxonomy);
    });
    transaction();
    return this.db.prepare("SELECT * FROM tag_suggestions WHERE id = ?").get(suggestionId);
  }

  close() {
    this.db.close();
  }
}
