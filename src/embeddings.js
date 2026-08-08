import crypto from "node:crypto";

export function buildSearchDocument(image) {
  const tagText = image.tags
    .map((item) => `${item.category.replaceAll("_", " ")}: ${item.display_name}`)
    .join(". ");
  const features = Array.isArray(image.visible_features) ? image.visible_features.join(", ") : "";
  return [
    image.caption?.trim(),
    features ? `Visible features: ${features}` : "",
    tagText ? `Tags: ${tagText}` : "",
  ].filter(Boolean).join("\n");
}

export function documentHash(document) {
  return crypto.createHash("sha256").update(document, "utf8").digest("hex");
}

export function encodeVector(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding vector must be a non-empty array of finite numbers");
  }
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function decodeVector(buffer, dimensions) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== dimensions * 4) throw new Error("Stored embedding has invalid dimensions");
  const vector = new Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) vector[index] = buffer.readFloatLE(index * 4);
  return vector;
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length || !left.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
