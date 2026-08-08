import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildFoundryModule} from "../src/module-builder.js";

test("module packaging replaces an old build with module code and generated data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-module-build-"));
  const source = path.join(directory, "source");
  const exported = path.join(directory, "exported");
  const buildDirectory = path.join(directory, "build");
  fs.mkdirSync(path.join(source, "scripts"), {recursive: true});
  fs.mkdirSync(exported, {recursive: true});
  fs.writeFileSync(path.join(source, "module.json"), JSON.stringify({id: "fantasy-image-catalog"}));
  fs.writeFileSync(path.join(source, "scripts", "main.mjs"), "export {};\n");
  fs.writeFileSync(path.join(exported, "catalog.json"), JSON.stringify({schemaVersion: 1, images: []}));
  fs.writeFileSync(path.join(exported, "catalog.schema.json"), "{}\n");

  const staleDirectory = path.join(buildDirectory, "fantasy-image-catalog");
  fs.mkdirSync(staleDirectory, {recursive: true});
  fs.writeFileSync(path.join(staleDirectory, "stale.txt"), "remove me");

  const result = buildFoundryModule({
    config: {foundry: {buildDirectory, moduleId: "fantasy-image-catalog"}},
    exportResult: {outputDirectory: exported, imageCount: 0},
    moduleSourceDirectory: source,
  });

  assert.equal(result.moduleDirectory, staleDirectory);
  assert.equal(result.imageCount, 0);
  assert.ok(fs.existsSync(path.join(staleDirectory, "scripts", "main.mjs")));
  assert.ok(fs.existsSync(path.join(staleDirectory, "generated", "catalog.json")));
  assert.equal(fs.existsSync(path.join(staleDirectory, "stale.txt")), false);
  assert.equal(fs.existsSync(`${staleDirectory}.previous`), false);
});

test("module packaging rejects a manifest id mismatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-module-invalid-"));
  const source = path.join(directory, "source");
  const exported = path.join(directory, "exported");
  fs.mkdirSync(source);
  fs.mkdirSync(exported);
  fs.writeFileSync(path.join(source, "module.json"), JSON.stringify({id: "wrong-id"}));
  fs.writeFileSync(path.join(exported, "catalog.json"), "{}\n");

  assert.throws(() => buildFoundryModule({
    config: {foundry: {buildDirectory: path.join(directory, "build"), moduleId: "fantasy-image-catalog"}},
    exportResult: {outputDirectory: exported, imageCount: 0},
    moduleSourceDirectory: source,
  }), /does not match/);
});
