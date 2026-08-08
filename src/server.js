import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/review", ["review.html", "text/html; charset=utf-8"]],
  ["/review.js", ["review.js", "text/javascript; charset=utf-8"]],
  ["/taxonomy", ["taxonomy.html", "text/html; charset=utf-8"]],
  ["/taxonomy.js", ["taxonomy.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendStatic(response, fileName, contentType) {
  const body = fs.readFileSync(path.join(staticRoot, fileName));
  response.writeHead(200, { "content-type": contentType, "content-length": body.length });
  response.end(body);
}

function imageContentType(filePath) {
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  }[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function sendImage(response, filePath, cacheControl) {
  if (!filePath || !fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "Image file not found" });
    return;
  }
  const stats = fs.statSync(filePath);
  response.writeHead(200, {
    "content-type": imageContentType(filePath),
    "content-length": stats.size,
    "cache-control": cacheControl,
  });
  fs.createReadStream(filePath).pipe(response);
}

async function readJson(request, maximumBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicImage(image) {
  return {
    ...image,
    current_path: undefined,
    thumbnail_path: undefined,
    thumbnailUrl: `/api/images/${image.id}/thumbnail`,
    originalUrl: `/api/images/${image.id}/original`,
  };
}

function parseTagFilters(searchParams, taxonomy) {
  return searchParams.getAll("tag").map((value) => {
    const separator = value.indexOf(":");
    const category = separator === -1 ? "" : value.slice(0, separator);
    const tag = separator === -1 ? "" : value.slice(separator + 1);
    if (!taxonomy.categories[category]?.values?.[tag]) throw new Error(`Unknown tag filter: ${value}`);
    return { category, tag };
  });
}

export function createCatalogServer(app) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && staticFiles.has(url.pathname)) {
        const [fileName, contentType] = staticFiles.get(url.pathname);
        sendStatic(response, fileName, contentType);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const recovered = app.database.recoverOrphanedClassificationJobs();
        sendJson(response, 200, { status: "ok", recovered, database: app.database.getStatus() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/taxonomy") {
        sendJson(response, 200, { ...app.taxonomy, usage: app.database.taxonomyUsage() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/taxonomy/categories") {
        sendJson(response, 201, app.createCategory(await readJson(request)));
        return;
      }
      const categoryRoute = url.pathname.match(/^\/api\/taxonomy\/categories\/([a-z][a-z0-9_]*)$/);
      if (categoryRoute && request.method === "PATCH") {
        sendJson(response, 200, app.updateCategory(categoryRoute[1], await readJson(request)));
        return;
      }
      const tagRoute = url.pathname.match(/^\/api\/taxonomy\/categories\/([a-z][a-z0-9_]*)\/tags(?:\/([a-z][a-z0-9_]*))?$/);
      if (tagRoute && request.method === "POST" && !tagRoute[2]) {
        sendJson(response, 201, app.createTag(tagRoute[1], await readJson(request)));
        return;
      }
      if (tagRoute && request.method === "PATCH" && tagRoute[2]) {
        sendJson(response, 200, app.updateTag(tagRoute[1], tagRoute[2], await readJson(request)));
        return;
      }
      if (tagRoute && request.method === "DELETE" && tagRoute[2]) {
        sendJson(response, 200, app.deleteTag(tagRoute[1], tagRoute[2]));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/taxonomy/merge") {
        const body = await readJson(request);
        sendJson(response, 200, app.mergeTag(body.sourceCategory, body.sourceTag, body.targetCategory, body.targetTag));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review/failures") {
        const result = app.database.listFailedInferences({
          page: url.searchParams.get("page") ?? 1,
          pageSize: url.searchParams.get("pageSize") ?? 25,
        });
        result.items = result.items.map((item) => ({
          ...item,
          thumbnail_path: undefined,
          thumbnailUrl: `/api/images/${item.image_id}/thumbnail`,
        }));
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review/suggestions") {
        const result = app.database.listTagSuggestions({
          status: url.searchParams.get("status") ?? "pending",
          page: url.searchParams.get("page") ?? 1,
          pageSize: url.searchParams.get("pageSize") ?? 50,
        });
        result.items = result.items.map((item) => ({
          ...item,
          thumbnail_path: undefined,
          thumbnailUrl: `/api/images/${item.image_id}/thumbnail`,
        }));
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        const result = app.database.listClassificationJobs({
          status: url.searchParams.get("status") ?? "",
          page: url.searchParams.get("page") ?? 1,
          pageSize: url.searchParams.get("pageSize") ?? 50,
        });
        result.items = result.items.map((item) => ({
          ...item,
          thumbnail_path: undefined,
          thumbnailUrl: `/api/images/${item.image_id}/thumbnail`,
        }));
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/api/jobs/pending") {
        sendJson(response, 200, app.database.deletePendingClassificationJobs());
        return;
      }
      const jobRoute = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (jobRoute && request.method === "DELETE") {
        sendJson(response, 200, app.database.deletePendingClassificationJob(Number(jobRoute[1])));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/jobs/run-one") {
        const recovered = app.database.recoverStaleClassificationJobs();
        const result = await app.processNextJob();
        sendJson(response, 200, { recovered, result });
        return;
      }

      const suggestionRoute = url.pathname.match(/^\/api\/review\/suggestions\/(\d+)$/);
      if (suggestionRoute && request.method === "PATCH") {
        const body = await readJson(request);
        sendJson(response, 200, app.database.updateTagSuggestion(Number(suggestionRoute[1]), body.status));
        return;
      }
      const suggestionMapRoute = url.pathname.match(/^\/api\/review\/suggestions\/(\d+)\/map$/);
      if (suggestionMapRoute && request.method === "POST") {
        const body = await readJson(request);
        const suggestionId = Number(suggestionMapRoute[1]);
        let { category, tag } = body;
        if (body.create) {
          category = body.create.category;
          tag = body.create.id;
          app.createTag(category, body.create);
        } else if (body.addAlias) {
          const suggestion = app.database.db.prepare("SELECT label FROM tag_suggestions WHERE id = ?").get(suggestionId);
          if (!suggestion) throw new Error(`Suggestion ${suggestionId} does not exist`);
          const definition = app.taxonomy.categories[category]?.values?.[tag];
          if (!definition) throw new Error(`Unknown taxonomy tag: ${category}:${tag}`);
          const aliases = [...(definition.aliases ?? [])];
          if (suggestion.label.toLocaleLowerCase() !== definition.label.toLocaleLowerCase()
            && !aliases.some((alias) => alias.toLocaleLowerCase() === suggestion.label.toLocaleLowerCase())) aliases.push(suggestion.label);
          app.updateTag(category, tag, { aliases });
        }
        sendJson(response, 200, app.database.mapTagSuggestion(suggestionId, category, tag, app.taxonomy, { applyToImage: body.applyToImage !== false }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/images") {
        const result = await app.searchImages({
          query: url.searchParams.get("q") ?? "",
          mode: url.searchParams.get("mode") ?? "keyword",
          tags: parseTagFilters(url.searchParams, app.taxonomy),
          reviewStatus: url.searchParams.get("reviewStatus") ?? "",
          page: url.searchParams.get("page") ?? 1,
          pageSize: url.searchParams.get("pageSize") ?? 48,
          sort: url.searchParams.get("sort") ?? "updated",
        });
        result.items = result.items.map(publicImage);
        sendJson(response, 200, result);
        return;
      }

      const imageRoute = url.pathname.match(/^\/api\/images\/(\d+)(?:\/(thumbnail|original))?$/);
      if (imageRoute) {
        const imageId = Number(imageRoute[1]);
        const image = app.database.getImageSummary(imageId);
        if (!image) {
          sendJson(response, 404, { error: "Image not found" });
          return;
        }
        if (request.method === "GET" && imageRoute[2] === "thumbnail") {
          sendImage(response, image.thumbnail_path, "public, max-age=31536000, immutable");
          return;
        }
        if (request.method === "GET" && imageRoute[2] === "original") {
          sendImage(response, image.current_path, "private, max-age=300");
          return;
        }
        if (request.method === "GET" && !imageRoute[2]) {
          sendJson(response, 200, publicImage(image));
          return;
        }
        if (request.method === "PATCH" && !imageRoute[2]) {
          const body = await readJson(request);
          const updated = app.database.updateHumanReview(imageId, body, app.taxonomy);
          sendJson(response, 200, publicImage(updated));
          return;
        }
      }

      const reclassifyRoute = url.pathname.match(/^\/api\/images\/(\d+)\/reclassify$/);
      if (reclassifyRoute && request.method === "POST") {
        const imageId = Number(reclassifyRoute[1]);
        const image = app.database.getImageSummary(imageId);
        if (!image) {
          sendJson(response, 404, { error: "Image not found" });
          return;
        }
        const result = await app.indexFile(image.current_path, { force: true });
        sendJson(response, 200, { ...result, image: result.image ? publicImage(result.image) : undefined });
        return;
      }

      const reevaluateRoute = url.pathname.match(/^\/api\/images\/(\d+)\/re-evaluate$/);
      if (reevaluateRoute && request.method === "POST") {
        const result = await app.enqueueReevaluation(Number(reevaluateRoute[1]));
        sendJson(response, 202, { ...result, image: result.image ? publicImage(result.image) : undefined });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 400;
      sendJson(response, status, { error: error.message });
    }
  });
}

export async function startCatalogServer(app) {
  const server = createCatalogServer(app);
  const { host, port } = app.config.web;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}
