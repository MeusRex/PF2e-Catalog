import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { CatalogDatabase } from "../src/database.js";
import { prepareImage } from "../src/image.js";
import { createCatalogServer } from "../src/server.js";
import { loadTaxonomy } from "../src/taxonomy.js";

test("gallery API searches, serves cataloged images, and saves review edits", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-catalog-server-"));
  const imagePath = path.join(directory, "server-fixture.png");
  const thumbnails = path.join(directory, "thumbnails");
  fs.mkdirSync(thumbnails);
  await sharp({
    create: {
      width: 40,
      height: 60,
      channels: 4,
      background: { r: 30, g: 90, b: 170, alpha: 1 },
    },
  }).png().toFile(imagePath);

  const imageConfig = {
    library: { extensions: [".png"] },
    storage: { thumbnails, thumbnailMaxSize: 64 },
    classification: { maximumInferenceDimension: 128 },
  };
  const taxonomy = loadTaxonomy(path.resolve("taxonomy/taxonomy.json"));
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite3"));
  const prepared = await prepareImage(imagePath, imageConfig);
  const imageId = database.upsertPreparedImage(prepared.record);
  database.updateHumanReview(imageId, {
    caption: "A blue-robed fantasy character.",
    tags: [
      { category: "subject_type", tag: "character" },
      { category: "dominant_color", tag: "blue" },
    ],
  }, taxonomy);
  const suggestionId = Number(database.db.prepare(`
    INSERT INTO tag_suggestions (image_id, label, suggested_category, reason)
    VALUES (?, 'aura crown', 'magic_theme', 'A recurring luminous crown')
  `).run(imageId).lastInsertRowid);
  const versions = { model: "server-model", promptVersion: "server-prompt", taxonomyVersion: taxonomy.version };
  database.enqueueClassification(imageId, versions);

  let reclassifiedPath = null;
  const server = createCatalogServer({
    database,
    taxonomy,
    indexFile: async (filePath) => {
      reclassifiedPath = filePath;
      return { skipped: false, image: database.getImageSummary(imageId) };
    },
    processNextJob: async () => {
      const job = database.claimNextClassificationJob(versions);
      if (!job) return null;
      return { job: database.completeClassificationJob(job.id), outcome: "completed" };
    },
    searchImages: async (options) => database.listImages(options),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.status, "ok");
    assert.equal(health.database.images, 1);

    const result = await fetch(`${baseUrl}/api/images?q=blue&tag=subject_type:character`).then((response) => response.json());
    assert.equal(result.total, 1);
    assert.equal(result.items[0].current_path, undefined);
    assert.equal(result.items[0].thumbnailUrl, `/api/images/${imageId}/thumbnail`);

    const thumbnail = await fetch(`${baseUrl}/api/images/${imageId}/thumbnail`);
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get("content-type"), "image/webp");
    assert.ok((await thumbnail.arrayBuffer()).byteLength > 0);

    const reviewResponse = await fetch(`${baseUrl}/api/images/${imageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caption: "A reviewed blue martial artist.",
        tags: [
          { category: "subject_type", tag: "character" },
          { category: "apparent_role", tag: "martial_artist" },
        ],
      }),
    });
    assert.equal(reviewResponse.status, 200);
    const reviewed = await reviewResponse.json();
    assert.equal(reviewed.caption, "A reviewed blue martial artist.");
    assert.deepEqual(reviewed.tags.map((tag) => tag.tag).sort(), ["character", "martial_artist"]);

    const suggestions = await fetch(`${baseUrl}/api/review/suggestions`).then((response) => response.json());
    assert.equal(suggestions.total, 1);
    assert.equal(suggestions.items[0].thumbnail_path, undefined);
    const triage = await fetch(`${baseUrl}/api/review/suggestions/${suggestionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "mapped" }),
    });
    assert.equal(triage.status, 200);
    assert.equal((await triage.json()).status, "mapped");

    const jobs = await fetch(`${baseUrl}/api/jobs?status=pending`).then((response) => response.json());
    assert.equal(jobs.total, 1);
    assert.equal(jobs.items[0].thumbnail_path, undefined);
    const runOne = await fetch(`${baseUrl}/api/jobs/run-one`, { method: "POST" });
    assert.equal(runOne.status, 200);
    assert.equal((await runOne.json()).result.outcome, "completed");

    const retry = await fetch(`${baseUrl}/api/images/${imageId}/reclassify`, { method: "POST" });
    assert.equal(retry.status, 200);
    assert.equal(reclassifiedPath, imagePath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
  }
});
