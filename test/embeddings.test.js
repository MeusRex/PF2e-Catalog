import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogApp } from "../src/catalog.js";
import { cosineSimilarity, decodeVector, encodeVector } from "../src/embeddings.js";

test("embedding vectors round-trip and cosine similarity ranks direction", () => {
  const encoded = encodeVector([0.25, -0.5, 1]);
  const decoded = decodeVector(encoded, 3);
  assert.ok(Math.abs(decoded[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(decoded[1] + 0.5) < 1e-6);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("catalog embedding is idempotent, searchable, and invalidated by review edits", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-catalog-embedding-"));
  const config = {
    library: { roots: [], extensions: [".png"], followSymlinks: false },
    storage: {
      database: path.join(directory, "catalog.sqlite3"),
      thumbnails: path.join(directory, "thumbnails"),
      thumbnailMaxSize: 64,
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434/api",
      visionModel: "test-vision",
      requestTimeoutSeconds: 5,
      keepAlive: "0",
    },
    embedding: { model: "test-embedding", batchSize: 8, semanticCandidateLimit: 100 },
    classification: {
      promptVersion: "vision-v1",
      taxonomyFile: path.resolve("taxonomy/taxonomy.json"),
      minimumConfidence: 0.55,
      reviewConfidence: 0.75,
      maximumInferenceDimension: 128,
      maxAttempts: 2,
    },
    web: { host: "127.0.0.1", port: 8787 },
  };
  fs.mkdirSync(config.storage.thumbnails);
  const app = new CatalogApp(config);
  app.client = {
    embed: async (input) => (Array.isArray(input) ? input : [input]).map(() => [1, 0.25, 0]),
  };
  try {
    const imageId = app.database.upsertPreparedImage({
      sha256: "a".repeat(64),
      perceptualHash: "f".repeat(16),
      path: path.join(directory, "blue-mage.png"),
      filename: "blue-mage.png",
      extension: ".png",
      width: 100,
      height: 150,
      fileSize: 1000,
      modifiedAt: new Date(0).toISOString(),
      thumbnailPath: path.join(directory, "thumb.webp"),
    });
    app.database.updateHumanReview(imageId, {
      caption: "A blue-robed mage holding a staff.",
      tags: [
        { category: "apparent_role", tag: "mage" },
        { category: "dominant_color", tag: "blue" },
      ],
    }, app.taxonomy);

    assert.deepEqual(await app.embedCatalog(), { model: "test-embedding", embedded: 1, skipped: 0, total: 1 });
    assert.deepEqual(await app.embedCatalog(), { model: "test-embedding", embedded: 0, skipped: 1, total: 1 });
    const search = await app.searchImages({ mode: "semantic", query: "azure spellcaster", page: 1, pageSize: 10 });
    assert.equal(search.total, 1);
    assert.equal(search.items[0].id, imageId);
    assert.ok(search.items[0].semantic_score > 0.99);

    app.database.updateHumanReview(imageId, {
      caption: "A reviewed blue-robed scholar holding a staff.",
      tags: [{ category: "apparent_role", tag: "scholar" }],
    }, app.taxonomy);
    assert.equal(app.database.getImageEmbedding(imageId, "test-embedding"), null);
    assert.equal((await app.embedCatalog()).embedded, 1);
  } finally {
    app.close();
  }
});
