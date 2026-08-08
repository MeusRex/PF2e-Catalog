import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function averageHash(pipeline) {
  const { data } = await pipeline.clone().rotate().resize(8, 8, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
  let bits = "";
  for (const value of data) bits += value >= mean ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

export async function prepareImage(filePath, config) {
  const absolutePath = path.resolve(filePath);
  const stats = await fs.promises.stat(absolutePath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absolutePath}`);

  const extension = path.extname(absolutePath).toLowerCase();
  if (!config.library.extensions.includes(extension)) throw new Error(`Unsupported image extension: ${extension}`);

  const sha256 = await sha256File(absolutePath);
  const image = sharp(absolutePath, { failOn: "error" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Could not determine image dimensions: ${absolutePath}`);

  const thumbnailPath = path.join(config.storage.thumbnails, `${sha256}.webp`);
  if (!fs.existsSync(thumbnailPath)) {
    await image.clone().rotate().resize({
      width: config.storage.thumbnailMaxSize,
      height: config.storage.thumbnailMaxSize,
      fit: "inside",
      withoutEnlargement: true,
    }).webp({ quality: 82 }).toFile(thumbnailPath);
  }

  const inferenceBuffer = await image.clone().rotate().resize({
    width: config.classification.maximumInferenceDimension,
    height: config.classification.maximumInferenceDimension,
    fit: "inside",
    withoutEnlargement: true,
  }).png({ compressionLevel: 6 }).toBuffer();

  return {
    record: {
      sha256,
      perceptualHash: await averageHash(image),
      path: absolutePath,
      filename: path.basename(absolutePath),
      extension,
      width: metadata.autoOrient?.width ?? metadata.width,
      height: metadata.autoOrient?.height ?? metadata.height,
      fileSize: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      thumbnailPath,
    },
    inferenceBuffer,
  };
}

export async function* walkImages(rootPath, extensions, followSymlinks = false) {
  const root = path.resolve(rootPath);
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkImages(entryPath, extensions, followSymlinks);
    } else if (entry.isSymbolicLink() && followSymlinks) {
      const stats = await fs.promises.stat(entryPath);
      if (stats.isDirectory()) yield* walkImages(entryPath, extensions, followSymlinks);
      else if (stats.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) yield entryPath;
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      yield entryPath;
    }
  }
}
