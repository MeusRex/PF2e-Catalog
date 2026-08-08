const state = {
  taxonomy: null,
  selectedTags: new Set(),
  query: "",
  reviewStatus: "",
  sort: "updated",
  searchMode: "keyword",
  page: 1,
  pages: 0,
  currentImage: null,
};

const elements = {
  search: document.querySelector("#search"),
  searchMode: document.querySelector("#search-mode"),
  reviewStatus: document.querySelector("#review-status"),
  sort: document.querySelector("#sort"),
  taxonomyFilters: document.querySelector("#taxonomy-filters"),
  activeFilters: document.querySelector("#active-filters"),
  clearFilters: document.querySelector("#clear-filters"),
  resultCount: document.querySelector("#result-count"),
  message: document.querySelector("#message"),
  gallery: document.querySelector("#gallery"),
  previousPage: document.querySelector("#previous-page"),
  nextPage: document.querySelector("#next-page"),
  pageLabel: document.querySelector("#page-label"),
  editor: document.querySelector("#editor"),
  editorForm: document.querySelector("#editor-form"),
  editorImage: document.querySelector("#editor-image"),
  editorFile: document.querySelector("#editor-file"),
  caption: document.querySelector("#caption"),
  editorTags: document.querySelector("#editor-tags"),
  closeEditor: document.querySelector("#close-editor"),
  saveStatus: document.querySelector("#save-status"),
  queueReevaluation: document.querySelector("#queue-reevaluation"),
};

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function checkbox(categoryId, tagId, tag, checked, name, onChange) {
  const label = document.createElement("label");
  label.className = "check-label";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = `${categoryId}:${tagId}`;
  input.checked = checked;
  input.addEventListener("change", onChange);
  label.append(input, document.createTextNode(tag.label));
  return label;
}

function renderTaxonomyFilters() {
  elements.taxonomyFilters.replaceChildren();
  let index = 0;
  for (const [categoryId, category] of Object.entries(state.taxonomy.categories)) {
    const details = document.createElement("details");
    details.open = index < 4;
    const summary = document.createElement("summary");
    summary.textContent = category.label;
    const options = document.createElement("div");
    options.className = "filter-options";
    for (const [tagId, tag] of Object.entries(category.values)) {
      const key = `${categoryId}:${tagId}`;
      options.append(checkbox(categoryId, tagId, tag, state.selectedTags.has(key), "filter-tag", (event) => {
        if (event.target.checked) state.selectedTags.add(key);
        else state.selectedTags.delete(key);
        state.page = 1;
        renderActiveFilters();
        loadImages();
      }));
    }
    details.append(summary, options);
    elements.taxonomyFilters.append(details);
    index += 1;
  }
}

function tagLabel(key) {
  const [categoryId, tagId] = key.split(":");
  return state.taxonomy.categories[categoryId]?.values[tagId]?.label ?? key;
}

function renderActiveFilters() {
  elements.activeFilters.replaceChildren();
  for (const key of state.selectedTags) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.textContent = tagLabel(key);
    button.addEventListener("click", () => {
      state.selectedTags.delete(key);
      const filter = elements.taxonomyFilters.querySelector(`input[value="${CSS.escape(key)}"]`);
      if (filter) filter.checked = false;
      state.page = 1;
      renderActiveFilters();
      loadImages();
    });
    elements.activeFilters.append(button);
  }
}

function showMessage(text, error = false) {
  elements.message.hidden = !text;
  elements.message.textContent = text;
  elements.message.classList.toggle("error", error);
}

function renderCard(image) {
  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  const preview = document.createElement("img");
  preview.src = image.thumbnailUrl;
  preview.alt = image.caption || image.filename;
  preview.loading = "lazy";
  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("h3");
  title.title = image.filename;
  const dot = document.createElement("span");
  dot.className = `status-dot status-${image.review_status}`;
  title.append(dot, document.createTextNode(image.filename));
  const caption = document.createElement("p");
  caption.className = "card-caption";
  caption.textContent = image.caption || "Not classified yet";
  const tags = document.createElement("div");
  tags.className = "card-tags";
  for (const item of image.tags.slice(0, 5)) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = item.display_name;
    tags.append(chip);
  }
  body.append(title, caption, tags);
  card.append(preview, body);
  const open = () => openEditor(image.id);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return card;
}

async function loadImages() {
  showMessage("");
  const params = new URLSearchParams({ page: String(state.page), pageSize: "48", sort: state.sort });
  if (state.query) params.set("q", state.query);
  if (state.searchMode === "semantic") params.set("mode", "semantic");
  if (state.reviewStatus) params.set("reviewStatus", state.reviewStatus);
  for (const tag of state.selectedTags) params.append("tag", tag);
  try {
    const result = await api(`/api/images?${params}`);
    state.pages = result.pages;
    elements.resultCount.textContent = `${result.total.toLocaleString()} image${result.total === 1 ? "" : "s"}`;
    elements.gallery.replaceChildren(...result.items.map(renderCard));
    if (!result.items.length) showMessage("No images match these filters.");
    elements.pageLabel.textContent = result.pages ? `Page ${result.page} of ${result.pages}` : "";
    elements.previousPage.disabled = result.page <= 1;
    elements.nextPage.disabled = result.page >= result.pages;
  } catch (error) {
    showMessage(error.message, true);
  }
}

function renderEditorTags(image) {
  const selected = new Set(image.tags.map((item) => `${item.category}:${item.tag}`));
  elements.editorTags.replaceChildren();
  for (const [categoryId, category] of Object.entries(state.taxonomy.categories)) {
    const details = document.createElement("details");
    if ([...selected].some((key) => key.startsWith(`${categoryId}:`))) details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = category.label;
    const grid = document.createElement("div");
    grid.className = "editor-tags-grid";
    for (const [tagId, tag] of Object.entries(category.values)) {
      grid.append(checkbox(categoryId, tagId, tag, selected.has(`${categoryId}:${tagId}`), "editor-tag", () => {}));
    }
    details.append(summary, grid);
    elements.editorTags.append(details);
  }
}

async function openEditor(imageId) {
  try {
    const image = await api(`/api/images/${imageId}`);
    state.currentImage = image;
    elements.editorImage.src = image.originalUrl;
    elements.editorFile.textContent = image.filename;
    elements.caption.value = image.caption || "";
    elements.saveStatus.textContent = image.review_status === "reviewed" ? "Human reviewed" : "";
    renderEditorTags(image);
    elements.editor.showModal();
  } catch (error) {
    showMessage(error.message, true);
  }
}

elements.editorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.currentImage) return;
  const tags = [...elements.editorTags.querySelectorAll('input[name="editor-tag"]:checked')].map((input) => {
    const [category, tag] = input.value.split(":");
    return { category, tag };
  });
  elements.saveStatus.textContent = "Saving…";
  try {
    await api(`/api/images/${state.currentImage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caption: elements.caption.value, tags }),
    });
    elements.saveStatus.textContent = "Saved";
    await loadImages();
    setTimeout(() => elements.editor.close(), 350);
  } catch (error) {
    elements.saveStatus.textContent = error.message;
  }
});

let searchTimer;
elements.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = elements.search.value.trim();
    state.page = 1;
    loadImages();
  }, 250);
});
elements.reviewStatus.addEventListener("change", () => { state.reviewStatus = elements.reviewStatus.value; state.page = 1; loadImages(); });
elements.searchMode.addEventListener("change", () => { state.searchMode = elements.searchMode.value; state.page = 1; loadImages(); });
elements.sort.addEventListener("change", () => { state.sort = elements.sort.value; state.page = 1; loadImages(); });
elements.clearFilters.addEventListener("click", () => {
  state.selectedTags.clear();
  state.reviewStatus = "";
  elements.reviewStatus.value = "";
  for (const input of elements.taxonomyFilters.querySelectorAll("input")) input.checked = false;
  state.page = 1;
  renderActiveFilters();
  loadImages();
});
elements.previousPage.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; loadImages(); } });
elements.nextPage.addEventListener("click", () => { if (state.page < state.pages) { state.page += 1; loadImages(); } });
elements.closeEditor.addEventListener("click", () => elements.editor.close());
elements.queueReevaluation.addEventListener("click", async () => {
  if (!state.currentImage) return;
  elements.queueReevaluation.disabled = true;
  elements.saveStatus.textContent = "Queuing…";
  try {
    const result = await api(`/api/images/${state.currentImage.id}/re-evaluate`, { method: "POST" });
    elements.saveStatus.textContent = result.enqueued ? "AI re-evaluation queued" : (result.reason ?? "Re-evaluation already queued");
  } catch (error) {
    elements.saveStatus.textContent = error.message;
  } finally {
    elements.queueReevaluation.disabled = false;
  }
});

async function initialize() {
  try {
    state.taxonomy = await api("/api/taxonomy");
    const initial = new URLSearchParams(location.search);
    state.query = initial.get("q") ?? "";
    state.reviewStatus = initial.get("reviewStatus") ?? "";
    elements.search.value = state.query;
    elements.reviewStatus.value = state.reviewStatus;
    for (const tag of initial.getAll("tag")) state.selectedTags.add(tag);
    renderTaxonomyFilters();
    renderActiveFilters();
    await loadImages();
  } catch (error) {
    showMessage(error.message, true);
  }
}

initialize();
