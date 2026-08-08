export const MODULE_ID = "fantasy-image-catalog";

export function validateCatalog(data) {
  if (!data || typeof data !== "object" || data.schemaVersion !== 1 || !Array.isArray(data.images)) {
    throw new Error("Unsupported or malformed catalog.json");
  }
  for (const entry of data.images) {
    if (typeof entry.id !== "string" || typeof entry.portrait !== "string" || typeof entry.thumbnail !== "string") {
      throw new Error("Catalog contains a malformed image entry");
    }
    entry.caption ??= "";
    entry.tags ??= {};
  }
  return data;
}

export async function loadCatalog() {
  const configured = game.settings.get(MODULE_ID, "catalogPath");
  const response = await fetch(configured, {cache: "no-store"});
  if (!response.ok) throw new Error(`Catalog request returned HTTP ${response.status}`);
  return validateCatalog(await response.json());
}

export function collectTagGroups(images) {
  const groups = new Map();
  for (const image of images) {
    for (const [category, tags] of Object.entries(image.tags ?? {})) {
      const values = groups.get(category) ?? new Set();
      for (const tag of tags) values.add(tag);
      groups.set(category, values);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, values]) => ({
      id,
      label: titleCase(id),
      values: [...values].sort().map((id) => ({id, label: titleCase(id)})),
    }));
}

export function titleCase(value) {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
