import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { CatalogDatabase } from "../src/database.js";
import { prepareImage } from "../src/image.js";
import { loadTaxonomy } from "../src/taxonomy.js";
import { tagsMatchingFilter } from "../src/taxonomy.js";

test("image preparation and database insertion are idempotent", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-catalog-image-"));
  const imagePath = path.join(directory, "fixture.png");
  const thumbnails = path.join(directory, "thumbnails");
  fs.mkdirSync(thumbnails);
  await sharp({
    create: {
      width: 48,
      height: 32,
      channels: 4,
      background: { r: 130, g: 40, b: 180, alpha: 1 },
    },
  }).png().toFile(imagePath);

  const config = {
    library: { extensions: [".png"] },
    storage: { thumbnails, thumbnailMaxSize: 64 },
    classification: { maximumInferenceDimension: 128 },
  };
  const prepared = await prepareImage(imagePath, config);
  assert.equal(prepared.record.width, 48);
  assert.equal(prepared.record.height, 32);
  assert.equal(prepared.record.sha256.length, 64);
  assert.equal(prepared.record.perceptualHash.length, 16);
  assert.ok(fs.existsSync(prepared.record.thumbnailPath));

  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite3"));
  try {
    const firstId = database.upsertPreparedImage(prepared.record);
    const secondId = database.upsertPreparedImage(prepared.record);
    assert.equal(firstId, secondId);
    assert.equal(database.hasBeenHandled(firstId), false);
    assert.deepEqual(database.getStatus(), {
      images: 1,
      classified: 0,
      unclassified: 1,
      needsReview: 0,
      reviewed: 0,
      failedRuns: 0,
      pendingSuggestions: 0,
      embeddings: 0,
      queue: {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
      },
    });

    const versions = { model: "queue-model", promptVersion: "queue-prompt", taxonomyVersion: "1.0.0" };
    const queued = database.enqueueClassification(firstId, versions, { maxAttempts: 2 });
    assert.equal(queued.enqueued, true);
    assert.equal(database.enqueueClassification(firstId, versions).enqueued, false);
    const firstClaim = database.claimNextClassificationJob(versions);
    assert.equal(firstClaim.status, "running");
    assert.equal(firstClaim.attempts, 1);
    const retry = database.failClassificationJob(firstClaim.id, "Temporary failure", { retryDelaySeconds: 0 });
    assert.equal(retry.status, "pending");
    const secondClaim = database.claimNextClassificationJob(versions);
    assert.equal(secondClaim.attempts, 2);
    assert.equal(database.completeClassificationJob(secondClaim.id).status, "completed");
    assert.equal(database.listClassificationJobs({ status: "completed" }).total, 1);

    database.enqueueClassification(firstId, versions, { force: true, maxAttempts: 2 });
    const stale = database.claimNextClassificationJob(versions);
    database.db.prepare("UPDATE classification_jobs SET started_at = datetime('now', '-2 hours') WHERE id = ?").run(stale.id);
    assert.equal(database.recoverStaleClassificationJobs(30), 1);
    assert.equal(database.getClassificationJob(stale.id).status, "pending");

    const taxonomy = loadTaxonomy(path.resolve("taxonomy/taxonomy.json"));
    const reviewed = database.updateHumanReview(firstId, {
      caption: "A purple humanoid character prepared for a fantasy encounter.",
      tags: [
        { category: "subject_type", tag: "character" },
        { category: "dominant_color", tag: "purple" },
      ],
    }, taxonomy);
    assert.equal(reviewed.review_status, "reviewed");
    assert.equal(reviewed.tags.length, 2);
    assert.ok(reviewed.tags.every((tag) => tag.source === "human"));
    assert.equal(database.hasBeenHandled(firstId), true);

    const textResult = database.listImages({ query: "purple fantasy" });
    assert.equal(textResult.total, 1);
    const tagResult = database.listImages({ tags: [{ category: "dominant_color", tag: "purple" }] });
    assert.equal(tagResult.total, 1);
    const noMatch = database.listImages({ tags: [{ category: "dominant_color", tag: "red" }] });
    assert.equal(noMatch.total, 0);

    database.persistClassification(firstId, {
      model: "test-model",
      promptVersion: "test-prompt",
      taxonomyVersion: taxonomy.version,
      request: {},
    }, {}, {
      caption: "This model caption must not replace human review.",
      visibleFeatures: ["red"],
      acceptedTags: [{ category: "dominant_color", tag: "red", confidence: 0.99, evidence: "Test", needsReview: false }],
      suggestedTags: [],
    }, taxonomy, 1);
    const preserved = database.getImageSummary(firstId);
    assert.equal(preserved.caption, reviewed.caption);
    assert.deepEqual(preserved.tags.map((tag) => tag.tag).sort(), ["character", "purple"]);

    database.persistClassification(firstId, {
      model: "test-model", promptVersion: "test-prompt", taxonomyVersion: taxonomy.version, request: { explicit: true },
    }, {}, {
      caption: "An explicitly re-evaluated red character.", visibleFeatures: ["red"],
      acceptedTags: [{ category: "dominant_color", tag: "red", confidence: 0.99, evidence: "Test", needsReview: false }],
      suggestedTags: [],
    }, taxonomy, 1, { overwriteHumanReview: true });
    assert.equal(database.getImageSummary(firstId).caption, "An explicitly re-evaluated red character.");

    database.recordFailedInference(firstId, {
      model: "test-model",
      promptVersion: "test-prompt",
      taxonomyVersion: taxonomy.version,
      request: {},
    }, "Simulated failure", 2);
    assert.equal(database.listFailedInferences().total, 1);

    database.db.prepare(`
      INSERT INTO tag_suggestions (image_id, label, suggested_category, reason)
      VALUES (?, 'spirit warrior', 'apparent_role', 'Recurring visual concept')
    `).run(firstId);
    const suggestions = database.listTagSuggestions();
    assert.equal(suggestions.total, 1);
    assert.equal(suggestions.items[0].label, "spirit warrior");
    database.updateTagSuggestion(suggestions.items[0].id, "rejected");
    assert.equal(database.listTagSuggestions().total, 0);
    assert.equal(database.listTagSuggestions({ status: "rejected" }).total, 1);

    database.enqueueClassification(firstId, { ...versions, taxonomyVersion: "orphaned-version" });
    const orphaned = database.listClassificationJobs({ status: "pending" }).items.find((job) => job.taxonomy_version === "orphaned-version");
    assert.equal(database.deletePendingClassificationJob(orphaned.id).removed, 1);
    database.enqueueClassification(firstId, { ...versions, taxonomyVersion: "old-a" });
    database.enqueueClassification(firstId, { ...versions, taxonomyVersion: "old-b" });
    assert.ok(database.deletePendingClassificationJobs().removed >= 2);
  } finally {
    database.close();
  }
});

test("aliases, implied parents, and mapped suggestions work without replacing other tags", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-catalog-wrangling-"));
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite3"));
  const taxonomy = loadTaxonomy(path.resolve("taxonomy/taxonomy.json"));
  taxonomy.categories.magic_theme.values.fire_magic = {
    label: "Fire Magic", aliases: ["pyromancy"], implies: ["element:fire"],
  };
  database.syncTaxonomy(taxonomy);
  try {
    const imageId = database.upsertPreparedImage({ sha256: "a".repeat(64), perceptualHash: "b".repeat(16),
      path: path.join(directory, "image.png"), filename: "image.png", extension: ".png", width: 10, height: 10,
      fileSize: 1, modifiedAt: new Date(0).toISOString(), thumbnailPath: path.join(directory, "thumb.webp") });
    database.updateHumanReview(imageId, { caption: "A wizard conjures supernatural flames.", tags: [
      { category: "subject_type", tag: "character" }, { category: "magic_theme", tag: "fire_magic" },
    ] }, taxonomy);
    assert.equal(database.listImages({ query: "pyromancy" }).total, 1);
    const matches = tagsMatchingFilter(taxonomy, "element", "fire");
    assert.equal(database.listImages({ tags: [{ category: "element", tag: "fire", matches }] }).total, 1);

    const suggestionId = Number(database.db.prepare(`INSERT INTO tag_suggestions
      (image_id, label, suggested_category, reason) VALUES (?, 'red hue', 'dominant_color', '')`).run(imageId).lastInsertRowid);
    database.mapTagSuggestion(suggestionId, "dominant_color", "red", taxonomy);
    const image = database.getImageSummary(imageId);
    assert.deepEqual(image.tags.map((item) => item.tag).sort(), ["character", "fire_magic", "red"]);
    assert.equal(database.listTagSuggestions({ status: "mapped" }).items[0].mapped_tag, "red");
  } finally {
    database.close();
  }
});
