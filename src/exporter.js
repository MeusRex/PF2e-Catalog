import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "foundry", "catalog.schema.json");

function foundryPath(...parts) {
  return parts
    .flatMap((part) => String(part).replaceAll("\\", "/").split("/"))
    .filter(Boolean)
    .join("/");
}

function copyStable(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Source asset does not exist: ${source}`);
  if (fs.existsSync(destination)) {
    const sourceStats = fs.statSync(source);
    const destinationStats = fs.statSync(destination);
    if (sourceStats.size === destinationStats.size && fs.readFileSync(source).equals(fs.readFileSync(destination))) return false;
  }
  fs.copyFileSync(source, destination);
  return true;
}

function tagsByCategory(tags) {
  const grouped = {};
  for (const item of tags) {
    grouped[item.category] ??= [];
    if (!grouped[item.category].includes(item.tag)) grouped[item.category].push(item.tag);
  }
  for (const values of Object.values(grouped)) values.sort();
  return grouped;
}

function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    fs.unlinkSync(destination);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function exportFoundryCatalog({ database, taxonomy, config, generatedAt = new Date() }) {
  const outputDirectory = config.foundry.outputDirectory;
  const portraitsDirectory = path.join(outputDirectory, "assets");
  const thumbnailsDirectory = path.join(outputDirectory, "thumbnails");
  fs.mkdirSync(portraitsDirectory, { recursive: true });
  fs.mkdirSync(thumbnailsDirectory, { recursive: true });

  const images = database.listExportImages({ includeUnclassified: config.foundry.includeUnclassified });
  const exported = [];
  let copiedPortraits = 0;
  let copiedThumbnails = 0;
  const errors = [];

  for (const image of images) {
    try {
      const sourceExtension = path.extname(image.current_path).toLowerCase();
      if (!new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]).has(sourceExtension)) {
        throw new Error(`Unsupported export extension ${sourceExtension}`);
      }
      const portraitName = `${image.sha256}${sourceExtension}`;
      const thumbnailName = `${image.sha256}.webp`;
      if (copyStable(image.current_path, path.join(portraitsDirectory, portraitName))) copiedPortraits += 1;
      if (copyStable(image.thumbnail_path, path.join(thumbnailsDirectory, thumbnailName))) copiedThumbnails += 1;
      exported.push({
        id: image.sha256,
        portrait: foundryPath(config.foundry.assetBasePath, "assets", portraitName),
        thumbnail: foundryPath(config.foundry.assetBasePath, "thumbnails", thumbnailName),
        filename: image.filename,
        caption: image.caption ?? "",
        tags: tagsByCategory(image.tags),
        reviewStatus: image.review_status,
        width: image.width,
        height: image.height,
      });
    } catch (error) {
      errors.push({ imageId: image.id, filename: image.filename, error: error.message });
    }
  }

  if (errors.length) {
    const detail = errors.map((item) => `${item.filename}: ${item.error}`).join("\n");
    throw new Error(`Foundry export aborted; ${errors.length} asset(s) failed validation:\n${detail}`);
  }

  const catalog = {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    moduleId: config.foundry.moduleId,
    taxonomyVersion: taxonomy.version,
    imageCount: exported.length,
    images: exported,
  };
  writeJsonAtomic(path.join(outputDirectory, "catalog.json"), catalog);
  copyStable(schemaSource, path.join(outputDirectory, "catalog.schema.json"));
  return {
    outputDirectory,
    catalogPath: path.join(outputDirectory, "catalog.json"),
    imageCount: exported.length,
    copiedPortraits,
    copiedThumbnails,
  };
}

export { foundryPath, tagsByCategory };
