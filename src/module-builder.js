import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultModuleSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "foundry-module");

function removeIfPresent(target) {
  if (fs.existsSync(target)) fs.rmSync(target, {recursive: true, force: true});
}

export function buildFoundryModule({config, exportResult, moduleSourceDirectory = defaultModuleSource}) {
  const buildRoot = config.foundry.buildDirectory;
  const target = path.join(buildRoot, config.foundry.moduleId);
  const staging = path.join(buildRoot, `.${config.foundry.moduleId}.staging-${process.pid}-${Date.now()}`);
  const backup = `${target}.previous`;
  fs.mkdirSync(buildRoot, {recursive: true});
  removeIfPresent(staging);
  fs.cpSync(moduleSourceDirectory, staging, {recursive: true});
  fs.cpSync(exportResult.outputDirectory, path.join(staging, "generated"), {recursive: true});

  const manifestPath = path.join(staging, "module.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.id !== config.foundry.moduleId) {
    removeIfPresent(staging);
    throw new Error(`Module manifest id ${manifest.id} does not match configured id ${config.foundry.moduleId}`);
  }
  const catalogPath = path.join(staging, "generated", "catalog.json");
  if (!fs.existsSync(catalogPath)) {
    removeIfPresent(staging);
    throw new Error("Generated catalog.json is missing from module staging directory");
  }

  removeIfPresent(backup);
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(staging, target);
    removeIfPresent(backup);
  } catch (error) {
    removeIfPresent(staging);
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    throw error;
  }
  return {
    moduleDirectory: target,
    manifestPath: path.join(target, "module.json"),
    catalogPath: path.join(target, "generated", "catalog.json"),
    imageCount: exportResult.imageCount,
  };
}
