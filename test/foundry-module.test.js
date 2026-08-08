import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {collectTagGroups, titleCase, validateCatalog} from "../foundry-module/scripts/catalog.mjs";

const moduleRoot = path.resolve("foundry-module");

test("Foundry manifest references files shipped by the module", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleRoot, "module.json"), "utf8"));
  assert.equal(manifest.id, "fantasy-image-catalog");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.ok(manifest.relationships.systems.some((system) => system.id === "pf2e"));

  const references = [
    ...manifest.esmodules,
    ...manifest.styles,
    ...manifest.languages.map((language) => language.path),
  ];
  for (const reference of references) {
    assert.ok(fs.existsSync(path.join(moduleRoot, reference)), `missing manifest file: ${reference}`);
  }

  for (const template of ["search.hbs", "tags.hbs", "grid.hbs", "details.hbs"]) {
    assert.ok(fs.existsSync(path.join(moduleRoot, "templates", template)), `missing template: ${template}`);
  }
});

test("catalog validation normalizes optional display fields", () => {
  const catalog = validateCatalog({
    schemaVersion: 1,
    images: [{id: "abc", portrait: "modules/example/a.webp", thumbnail: "modules/example/t.webp"}],
  });
  assert.equal(catalog.images[0].caption, "");
  assert.deepEqual(catalog.images[0].tags, {});
  assert.throws(() => validateCatalog({schemaVersion: 2, images: []}), /malformed/i);
  assert.throws(() => validateCatalog({schemaVersion: 1, images: [{id: 7}]}), /malformed/i);
});

test("tag groups are deduplicated and deterministically sorted", () => {
  const groups = collectTagGroups([
    {tags: {mood: ["stern", "calm"], apparent_role: ["mage"]}},
    {tags: {mood: ["calm"], apparent_role: ["warrior"]}},
  ]);
  assert.deepEqual(groups, [
    {
      id: "apparent_role",
      label: "Apparent Role",
      values: [{id: "mage", label: "Mage"}, {id: "warrior", label: "Warrior"}],
    },
    {
      id: "mood",
      label: "Mood",
      values: [{id: "calm", label: "Calm"}, {id: "stern", label: "Stern"}],
    },
  ]);
  assert.equal(titleCase("body_plan"), "Body Plan");
});
