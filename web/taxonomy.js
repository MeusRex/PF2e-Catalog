const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let taxonomy;
let editingTag = null;
let editingCategory = null;
let mergingTag = null;
let implicationSelection = new Set();

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
function json(method, body) { return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
function showMessage(text, error = false) {
  elements["taxonomy-message"].hidden = !text;
  elements["taxonomy-message"].textContent = text;
  elements["taxonomy-message"].classList.toggle("error", error);
}
function tagEntries() {
  return Object.entries(taxonomy.categories).flatMap(([category, group]) =>
    Object.entries(group.values).map(([tag, definition]) => ({ category, tag, definition, group, key: `${category}:${tag}` })));
}
function option(entry) {
  const item = document.createElement("option"); item.value = entry.key; item.textContent = `${entry.group.label} · ${entry.definition.label} (${entry.key})`; return item;
}

function render() {
  elements["taxonomy-version"].textContent = `v${taxonomy.version}`;
  const query = elements["taxonomy-search"].value.trim().toLocaleLowerCase();
  const sections = [];
  for (const [categoryId, category] of Object.entries(taxonomy.categories)) {
    const matches = Object.entries(category.values).filter(([tagId, tag]) =>
      !query || `${categoryId} ${category.label} ${tagId} ${tag.label} ${(tag.aliases ?? []).join(" ")} ${tag.description ?? ""}`.toLocaleLowerCase().includes(query));
    if (query && !matches.length) continue;
    const section = document.createElement("section"); section.className = "taxonomy-category";
    const heading = document.createElement("div"); heading.className = "section-heading";
    const title = document.createElement("h3"); title.textContent = `${category.label} (${categoryId})`;
    const meta = document.createElement("span"); meta.className = "queue-meta"; meta.textContent = `${Object.keys(category.values).length} tags · maximum ${category.maximumTags}`;
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit category"; edit.addEventListener("click", () => openCategory(categoryId));
    const headingText = document.createElement("div"); headingText.append(title, meta); heading.append(headingText, edit);
    const grid = document.createElement("div"); grid.className = "taxonomy-grid";
    for (const [tagId, tag] of matches) {
      const card = document.createElement("button"); card.type = "button"; card.className = "taxonomy-tag";
      const usage = taxonomy.usage?.[`${categoryId}:${tagId}`] ?? 0;
      const name = document.createElement("strong"); name.textContent = tag.label;
      const id = document.createElement("span"); id.textContent = `${categoryId}:${tagId} · ${usage} image${usage === 1 ? "" : "s"}`;
      const aliases = document.createElement("small"); aliases.textContent = tag.aliases?.length ? `Aliases: ${tag.aliases.join(", ")}` : "No aliases";
      const implies = document.createElement("small"); implies.textContent = tag.implies?.length ? `Implies: ${tag.implies.join(", ")}` : "No broader tags";
      card.append(name, id, aliases, implies); card.addEventListener("click", () => openTag(categoryId, tagId)); grid.append(card);
    }
    section.append(heading, grid); sections.push(section);
  }
  elements["taxonomy-list"].replaceChildren(...sections);
}

async function reload(message = "") {
  taxonomy = await api("/api/taxonomy"); render(); if (message) showMessage(message);
}
function fillCategories(selected) {
  elements["tag-category"].replaceChildren(...Object.entries(taxonomy.categories).map(([id, category]) => {
    const item = document.createElement("option"); item.value = id; item.textContent = category.label; return item;
  }));
  if (selected) elements["tag-category"].value = selected;
}
function renderImplications() {
  const query = elements["implies-search"].value.trim().toLocaleLowerCase();
  const rows = tagEntries().filter((entry) => entry.key !== (editingTag && `${editingTag.category}:${editingTag.tag}`))
    .filter((entry) => !query || `${entry.key} ${entry.definition.label}`.toLocaleLowerCase().includes(query));
  elements["tag-implies"].replaceChildren(...rows.map((entry) => {
    const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.value = entry.key; input.checked = implicationSelection.has(entry.key);
    input.addEventListener("change", () => input.checked ? implicationSelection.add(entry.key) : implicationSelection.delete(entry.key));
    label.append(input, document.createTextNode(`${entry.definition.label} (${entry.key})`)); return label;
  }));
}
function openTag(category = Object.keys(taxonomy.categories)[0], tag = null) {
  editingTag = tag ? { category, tag } : null; const definition = tag ? taxonomy.categories[category].values[tag] : null;
  elements["tag-dialog-title"].textContent = tag ? "Edit tag" : "Add tag"; fillCategories(category);
  elements["tag-category"].disabled = Boolean(tag); elements["tag-id"].disabled = Boolean(tag); elements["tag-id"].value = tag ?? "";
  elements["tag-label"].value = definition?.label ?? ""; elements["tag-aliases"].value = (definition?.aliases ?? []).join(", ");
  elements["tag-description"].value = definition?.description ?? ""; elements["tag-implies"].replaceChildren(); elements["implies-search"].value = "";
  implicationSelection = new Set(definition?.implies ?? []);
  elements["delete-tag"].hidden = !tag; renderImplications(); elements["tag-dialog"].showModal();
}
function openCategory(categoryId = null) {
  editingCategory = categoryId; const category = categoryId ? taxonomy.categories[categoryId] : null;
  elements["category-dialog-title"].textContent = category ? "Edit category" : "Add category";
  elements["category-id"].disabled = Boolean(category); elements["category-id"].value = categoryId ?? "";
  elements["category-label"].value = category?.label ?? ""; elements["category-maximum"].value = category?.maximumTags ?? 3;
  elements["category-dialog"].showModal();
}
async function saveTag(event) {
  event.preventDefault(); const category = elements["tag-category"].value; const id = elements["tag-id"].value;
  const body = { id, label: elements["tag-label"].value, aliases: elements["tag-aliases"].value.split(",").map((v) => v.trim()).filter(Boolean),
    description: elements["tag-description"].value, implies: [...implicationSelection] };
  try {
    if (editingTag) await api(`/api/taxonomy/categories/${editingTag.category}/tags/${editingTag.tag}`, json("PATCH", body));
    else await api(`/api/taxonomy/categories/${category}/tags`, json("POST", body));
    elements["tag-dialog"].close(); await reload(`Tag ${category}:${id} saved.`);
  } catch (error) { showMessage(error.message, true); }
}
async function saveCategory(event) {
  event.preventDefault(); const id = elements["category-id"].value; const body = { id, label: elements["category-label"].value, maximumTags: Number(elements["category-maximum"].value) };
  try { await api(editingCategory ? `/api/taxonomy/categories/${editingCategory}` : "/api/taxonomy/categories", json(editingCategory ? "PATCH" : "POST", body));
    elements["category-dialog"].close(); await reload(`Category ${id} saved.`); } catch (error) { showMessage(error.message, true); }
}
function openMerge() {
  mergingTag = editingTag; const source = `${editingTag.category}:${editingTag.tag}`;
  elements["merge-help"].textContent = `Merge ${source} into another canonical tag.`;
  elements["merge-target"].replaceChildren(...tagEntries().filter((entry) => entry.key !== source).map(option));
  elements["tag-dialog"].close(); elements["merge-dialog"].showModal();
}
async function deleteOrMerge() {
  const key = `${editingTag.category}:${editingTag.tag}`; const usage = taxonomy.usage?.[key] ?? 0;
  if (usage) { openMerge(); return; }
  if (!confirm(`Delete ${key}? This cannot be undone.`)) return;
  try { await api(`/api/taxonomy/categories/${editingTag.category}/tags/${editingTag.tag}`, { method: "DELETE" }); elements["tag-dialog"].close(); await reload(`Deleted ${key}.`); }
  catch (error) { showMessage(error.message, true); }
}
async function merge(event) {
  event.preventDefault(); const [targetCategory, targetTag] = elements["merge-target"].value.split(":");
  if (!confirm("Move every assignment and permanently remove the old canonical tag?")) return;
  try { const result = await api("/api/taxonomy/merge", json("POST", { sourceCategory: mergingTag.category, sourceTag: mergingTag.tag, targetCategory, targetTag }));
    elements["merge-dialog"].close(); await reload(`Merged tag; ${result.affectedImages} image(s) updated.`); } catch (error) { showMessage(error.message, true); }
}

elements["taxonomy-search"].addEventListener("input", render); elements["add-category"].addEventListener("click", () => openCategory());
elements["add-tag"].addEventListener("click", () => openTag()); elements["tag-form"].addEventListener("submit", saveTag);
elements["category-form"].addEventListener("submit", saveCategory); elements["merge-form"].addEventListener("submit", merge);
elements["delete-tag"].addEventListener("click", deleteOrMerge); elements["implies-search"].addEventListener("input", renderImplications);
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
reload().catch((error) => showMessage(error.message, true));
