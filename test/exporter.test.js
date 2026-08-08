import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { CatalogDatabase } from "../src/database.js";
import { exportFoundryCatalog, foundryPath, tagsByCategory } from "../src/exporter.js";
import { prepareImage } from "../src/image.js";
import { loadTaxonomy } from "../src/taxonomy.js";

test("Foundry paths and tag groups are stable", () => {
  assert.equal(foundryPath("modules\\fantasy-gallery", "/generated/", "assets", "portrait.webp"),
    "modules/fantasy-gallery/generated/assets/portrait.webp");
  assert.deepEqual(tagsByCategory([
    { category: "mood", tag: "stern" },
    { category: "mood", tag: "friendly" },
    { category: "mood", tag: "stern" },
  ]), { mood: ["friendly", "stern"] });
});

test("Foundry export copies hash-named assets and writes a repeatable catalog", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-catalog-export-"));
  const sourceDirectory = path.join(directory, "source");
  const thumbnails = path.join(directory, "source-thumbnails");
  const outputDirectory = path.join(directory, "foundry-output");
  fs.mkdirSync(sourceDirectory);
  fs.mkdirSync(thumbnails);
  const imagePath = path.join(sourceDirectory, "Knight Portrait.PNG");
  await sharp({
    create: {
      width: 80,
      height: 120,
      channels: 4,
      background: { r: 90, g: 100, b: 115, alpha: 1 },
    },
  }).png().toFile(imagePath);

  const imageConfig = {
    library: { extensions: [".png"] },
    storage: { thumbnails, thumbnailMaxSize: 64 },
    classification: { maximumInferenceDimension: 128 },
  };
  const prepared = await prepareImage(imagePath, imageConfig);
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite3"));
  const taxonomy = loadTaxonomy(path.resolve("taxonomy/taxonomy.json"));
  try {
    const imageId = database.upsertPreparedImage(prepared.record);
    database.updateHumanReview(imageId, {
      caption: "A stern armored knight prepared for battle.",
      tags: [
        { category: "apparent_role", tag: "warrior" },
        { category: "mood", tag: "stern" },
      ],
    }, taxonomy);
    const config = {
      foundry: {
        outputDirectory,
        moduleId: "fantasy-image-catalog",
        assetBasePath: "modules/fantasy-image-catalog/generated",
        includeUnclassified: true,
      },
    };
    const generatedAt = new Date("2026-08-07T12:00:00.000Z");
    const first = exportFoundryCatalog({ database, taxonomy, config, generatedAt });
    assert.equal(first.imageCount, 1);
    assert.equal(first.copiedPortraits, 1);
    assert.equal(first.copiedThumbnails, 1);
    const firstJson = fs.readFileSync(first.catalogPath, "utf8");
    const catalog = JSON.parse(firstJson);
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.generatedAt, generatedAt.toISOString());
    assert.equal(catalog.images[0].id, prepared.record.sha256);
    assert.equal(catalog.images[0].portrait,
      `modules/fantasy-image-catalog/generated/assets/${prepared.record.sha256}.png`);
    assert.equal(catalog.images[0].thumbnail,
      `modules/fantasy-image-catalog/generated/thumbnails/${prepared.record.sha256}.webp`);
    assert.deepEqual(catalog.images[0].tags, { apparent_role: ["warrior"], mood: ["stern"] });
    assert.ok(fs.existsSync(path.join(outputDirectory, "catalog.schema.json")));

    const second = exportFoundryCatalog({ database, taxonomy, config, generatedAt });
    assert.equal(second.copiedPortraits, 0);
    assert.equal(second.copiedThumbnails, 0);
    assert.equal(fs.readFileSync(second.catalogPath, "utf8"), firstJson);
  } finally {
    database.close();
  }
});
