import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("configuration resolves paths relative to its own file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-catalog-"));
  const configPath = path.join(directory, "catalog.json");
  fs.writeFileSync(configPath, JSON.stringify({
    storage: { database: "store/test.sqlite3", thumbnails: "thumbs" },
    classification: { taxonomyFile: "taxonomy.json" },
    library: { roots: ["images"] },
    foundry: {outputDirectory: "foundry/export", buildDirectory: "foundry/build"},
  }));

  const config = loadConfig(configPath);
  assert.equal(config.storage.database, path.join(directory, "store", "test.sqlite3"));
  assert.equal(config.storage.thumbnails, path.join(directory, "thumbs"));
  assert.equal(config.library.roots[0], path.join(directory, "images"));
  assert.equal(config.foundry.outputDirectory, path.join(directory, "foundry", "export"));
  assert.equal(config.foundry.buildDirectory, path.join(directory, "foundry", "build"));
});
