const elements = {
  message: document.querySelector("#review-message"),
  refresh: document.querySelector("#refresh-review"),
  summary: document.querySelector("#summary-cards"),
  jobStatus: document.querySelector("#job-status"),
  runOneJob: document.querySelector("#run-one-job"),
  jobs: document.querySelector("#job-list"),
  failureCount: document.querySelector("#failure-count"),
  failures: document.querySelector("#failure-list"),
  suggestionStatus: document.querySelector("#suggestion-status"),
  suggestions: document.querySelector("#suggestion-list"),
  suggestionDialog: document.querySelector("#suggestion-dialog"),
  suggestionForm: document.querySelector("#suggestion-form"),
  suggestionAction: document.querySelector("#suggestion-action"),
  suggestionTarget: document.querySelector("#suggestion-target"),
  suggestionCategory: document.querySelector("#suggestion-category"),
  suggestionImplies: document.querySelector("#suggestion-implies"),
};
let taxonomy = null;
let activeSuggestion = null;

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function showMessage(text, error = false) {
  elements.message.hidden = !text;
  elements.message.textContent = text;
  elements.message.classList.toggle("error", error);
}

function summaryCard(label, value, href, tone = "") {
  const card = document.createElement(href ? "a" : "div");
  card.className = `summary-card ${tone}`;
  if (href) card.href = href;
  const count = document.createElement("strong");
  count.textContent = Number(value).toLocaleString();
  const text = document.createElement("span");
  text.textContent = label;
  card.append(count, text);
  return card;
}

async function loadSummary() {
  const health = await api("/api/health");
  const status = health.database;
  elements.summary.replaceChildren(
    summaryCard("Total images", status.images, "/"),
    summaryCard("Unclassified", status.unclassified, "/?reviewStatus=unclassified", status.unclassified ? "warning" : ""),
    summaryCard("Needs review", status.needsReview, "/?reviewStatus=needs_review", status.needsReview ? "warning" : ""),
    summaryCard("Human reviewed", status.reviewed, "/?reviewStatus=reviewed", "success"),
    summaryCard("Failed", status.failedRuns, null, status.failedRuns ? "danger" : ""),
    summaryCard("Tag suggestions", status.pendingSuggestions, null, status.pendingSuggestions ? "warning" : ""),
    summaryCard("Semantic vectors", status.embeddings, null),
    summaryCard("Jobs pending", status.queue.pending, null, status.queue.pending ? "warning" : ""),
    summaryCard("Jobs running", status.queue.running, null),
    summaryCard("Jobs failed", status.queue.failed, null, status.queue.failed ? "danger" : ""),
  );
}

function queueImage(item) {
  const image = document.createElement("img");
  image.src = item.thumbnailUrl;
  image.alt = item.filename;
  image.loading = "lazy";
  return image;
}

function jobRow(item) {
  const row = document.createElement("article");
  row.className = "queue-row";
  const content = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = item.filename;
  const metadata = document.createElement("p");
  metadata.className = "queue-meta";
  metadata.textContent = `${item.status} · attempt ${item.attempts}/${item.max_attempts} · ${item.model}`;
  const detail = document.createElement("p");
  detail.textContent = item.last_error || `Available ${new Date(`${item.available_at}Z`).toLocaleString()}`;
  content.append(title, metadata, detail);
  const actions = document.createElement("div");
  actions.className = "queue-actions";
  const open = document.createElement("a");
  open.href = `/?q=${encodeURIComponent(item.filename)}`;
  open.textContent = "View image";
  actions.append(open);
  row.append(queueImage(item), content, actions);
  return row;
}

async function loadJobs() {
  const status = elements.jobStatus.value;
  const params = new URLSearchParams({ pageSize: "100" });
  if (status) params.set("status", status);
  const result = await api(`/api/jobs?${params}`);
  if (!result.items.length) {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = "No classification jobs match this filter.";
    elements.jobs.replaceChildren(empty);
  } else {
    elements.jobs.replaceChildren(...result.items.map(jobRow));
  }
}

async function runOneJob() {
  elements.runOneJob.disabled = true;
  elements.runOneJob.textContent = "Processing…";
  showMessage("");
  try {
    const response = await api("/api/jobs/run-one", { method: "POST" });
    if (!response.result) showMessage("No ready job matches the current model, prompt, and taxonomy versions.");
    else if (response.result.outcome === "completed") showMessage(`${response.result.job.filename} completed successfully.`);
    else showMessage(`${response.result.job.filename}: ${response.result.error}`, true);
    await loadAll();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    elements.runOneJob.disabled = false;
    elements.runOneJob.textContent = "Process one ready job";
  }
}

async function retryImage(button, item) {
  button.disabled = true;
  button.textContent = "Retrying…";
  try {
    await api(`/api/images/${item.image_id}/reclassify`, { method: "POST" });
    showMessage(`${item.filename} was classified successfully.`);
    await loadAll();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Retry classification";
    showMessage(error.message, true);
  }
}

function failureRow(item) {
  const row = document.createElement("article");
  row.className = "queue-row";
  const content = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = item.filename;
  const metadata = document.createElement("p");
  metadata.className = "queue-meta";
  metadata.textContent = `${item.model} · ${new Date(`${item.created_at}Z`).toLocaleString()}`;
  const error = document.createElement("p");
  error.className = "queue-error";
  error.textContent = item.error || "Unknown inference error";
  content.append(title, metadata, error);
  const actions = document.createElement("div");
  actions.className = "queue-actions";
  const open = document.createElement("a");
  open.href = `/?q=${encodeURIComponent(item.filename)}`;
  open.textContent = "Open in gallery";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry classification";
  retry.addEventListener("click", () => retryImage(retry, item));
  actions.append(open, retry);
  row.append(queueImage(item), content, actions);
  return row;
}

async function loadFailures() {
  const result = await api("/api/review/failures?pageSize=100");
  elements.failureCount.textContent = result.total.toLocaleString();
  if (!result.items.length) {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = "No images currently have a failed latest inference run.";
    elements.failures.replaceChildren(empty);
  } else {
    elements.failures.replaceChildren(...result.items.map(failureRow));
  }
}

async function setSuggestionStatus(item, status) {
  try {
    await api(`/api/review/suggestions/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await Promise.all([loadSummary(), loadSuggestions()]);
  } catch (error) {
    showMessage(error.message, true);
  }
}

function suggestionRow(item) {
  const row = document.createElement("article");
  row.className = "queue-row";
  const content = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = item.label;
  const metadata = document.createElement("p");
  metadata.className = "queue-meta";
  metadata.textContent = `${item.filename}${item.suggested_category ? ` · Suggested category: ${item.suggested_category}` : ""}`;
  const reason = document.createElement("p");
  reason.textContent = item.reason || "No reason supplied.";
  content.append(title, metadata, reason);
  const actions = document.createElement("div");
  actions.className = "queue-actions";
  const open = document.createElement("a");
  open.href = `/?q=${encodeURIComponent(item.filename)}`;
  open.textContent = "View image";
  actions.append(open);
  if (item.status === "pending") {
    const handled = document.createElement("button");
    handled.type = "button";
    handled.textContent = "Handle suggestion";
    handled.addEventListener("click", () => openSuggestion(item));
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "danger-button";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => setSuggestionStatus(item, "rejected"));
    actions.append(handled, reject);
  } else {
    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.textContent = "Reopen";
    reopen.addEventListener("click", () => setSuggestionStatus(item, "pending"));
    actions.append(reopen);
  }
  row.append(queueImage(item), content, actions);
  return row;
}

function taxonomyTagOptions() {
  return Object.entries(taxonomy.categories).flatMap(([categoryId, category]) =>
    Object.entries(category.values).map(([tagId, tag]) => ({ value: `${categoryId}:${tagId}`, label: `${category.label} · ${tag.label}`,
      names: [tagId.replaceAll("_", " "), tag.label, ...(tag.aliases ?? [])].map((name) => name.toLocaleLowerCase()) })));
}

function slug(value) {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function openSuggestion(item) {
  activeSuggestion = item;
  if (!taxonomy) taxonomy = await api("/api/taxonomy");
  const options = taxonomyTagOptions();
  const makeOption = (entry) => { const option = document.createElement("option"); option.value = entry.value; option.textContent = entry.label; return option; };
  elements.suggestionTarget.replaceChildren(...options.map(makeOption));
  const suggestedName = item.label.trim().toLocaleLowerCase();
  const preferred = options.find((entry) => entry.names.includes(suggestedName))
    ?? options.find((entry) => entry.names.some((name) => name.includes(suggestedName) || suggestedName.includes(name)));
  if (preferred) elements.suggestionTarget.value = preferred.value;
  elements.suggestionImplies.replaceChildren(...options.map(makeOption));
  elements.suggestionCategory.replaceChildren(...Object.entries(taxonomy.categories).map(([id, category]) => {
    const option = document.createElement("option"); option.value = id; option.textContent = category.label; return option;
  }));
  if (taxonomy.categories[item.suggested_category]) elements.suggestionCategory.value = item.suggested_category;
  document.querySelector("#suggestion-dialog-title").textContent = item.label;
  document.querySelector("#suggestion-id").value = slug(item.label);
  document.querySelector("#suggestion-label").value = item.label;
  document.querySelector("#suggestion-aliases").value = "";
  elements.suggestionAction.value = "existing";
  toggleSuggestionAction();
  elements.suggestionDialog.showModal();
}

function toggleSuggestionAction() {
  const create = elements.suggestionAction.value === "create";
  document.querySelector("#existing-tag-fields").hidden = create;
  document.querySelector("#new-tag-fields").hidden = !create;
}

async function mapSuggestion(event) {
  event.preventDefault();
  const create = elements.suggestionAction.value === "create";
  let body;
  if (create) {
    body = { create: { category: elements.suggestionCategory.value, id: document.querySelector("#suggestion-id").value,
      label: document.querySelector("#suggestion-label").value,
      aliases: document.querySelector("#suggestion-aliases").value.split(",").map((value) => value.trim()).filter(Boolean),
      implies: [...elements.suggestionImplies.selectedOptions].map((option) => option.value) } };
  } else {
    const [category, tag] = elements.suggestionTarget.value.split(":");
    body = { category, tag, addAlias: document.querySelector("#suggestion-alias").checked };
  }
  body.applyToImage = document.querySelector("#suggestion-apply").checked;
  try {
    await api(`/api/review/suggestions/${activeSuggestion.id}/map`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    taxonomy = null;
    elements.suggestionDialog.close();
    showMessage(`Mapped “${activeSuggestion.label}” successfully.`);
    await Promise.all([loadSummary(), loadSuggestions()]);
  } catch (error) { showMessage(error.message, true); }
}

async function loadSuggestions() {
  const status = elements.suggestionStatus.value;
  const result = await api(`/api/review/suggestions?status=${encodeURIComponent(status)}&pageSize=200`);
  if (!result.items.length) {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = `No ${status} tag suggestions.`;
    elements.suggestions.replaceChildren(empty);
  } else {
    elements.suggestions.replaceChildren(...result.items.map(suggestionRow));
  }
}

async function loadAll() {
  showMessage("");
  try {
    await Promise.all([loadSummary(), loadJobs(), loadFailures(), loadSuggestions()]);
  } catch (error) {
    showMessage(error.message, true);
  }
}

elements.refresh.addEventListener("click", loadAll);
elements.jobStatus.addEventListener("change", loadJobs);
elements.runOneJob.addEventListener("click", runOneJob);
elements.suggestionStatus.addEventListener("change", loadSuggestions);
elements.suggestionAction.addEventListener("change", toggleSuggestionAction);
elements.suggestionForm.addEventListener("submit", mapSuggestion);
document.querySelector("#close-suggestion-dialog").addEventListener("click", () => elements.suggestionDialog.close());
loadAll();
