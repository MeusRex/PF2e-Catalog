#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { CatalogApp } from "./catalog.js";
import { ensureStorageDirectories, loadConfig } from "./config.js";
import { walkImages } from "./image.js";
import { startCatalogServer } from "./server.js";

function usage() {
  console.log(`Fantasy Image Catalog

Usage:
  npm run catalog -- init [--config FILE]
  npm run catalog -- check [--config FILE]
  npm run catalog -- index IMAGE [--force] [--config FILE]
  npm run catalog -- scan [DIRECTORY] [--force] [--config FILE]
  npm run catalog -- queue [DIRECTORY] [--force] [--config FILE]
  npm run catalog -- work [--once] [--config FILE]
  npm run catalog -- embed [--force] [--config FILE]
  npm run catalog -- export-foundry [--config FILE]
  npm run catalog -- package-foundry [--config FILE]
  npm run catalog -- status [--config FILE]
  npm run catalog -- serve [--config FILE]

Commands:
  init    Create storage directories and initialize the SQLite database.
  check   Check configuration, taxonomy, database, and Ollama connectivity.
  index   Prepare and classify one image.
  scan    Recursively classify supported images in a directory or configured roots.
  queue   Discover images and add durable classification jobs without calling Ollama.
  work    Process queued jobs; use --once to process at most one ready job.
  embed   Generate or refresh semantic-search vectors for classified images.
  export-foundry  Stage catalog JSON, portraits, and thumbnails for Foundry.
  package-foundry Assemble an installable module directory with the staged catalog.
  status  Print catalog counts.
  serve   Start the local gallery and review interface.
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  let configPath = "catalog.config.json";
  let force = false;
  let once = false;
  const positional = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--config") {
      configPath = args.shift();
      if (!configPath) throw new Error("--config requires a file path");
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--once") {
      once = true;
    } else {
      positional.push(arg);
    }
  }
  return { command, configPath, force, once, positional };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help") {
    usage();
    return;
  }

  const config = loadConfig(parsed.configPath);
  ensureStorageDirectories(config);
  const app = new CatalogApp(config);
  try {
    if (parsed.command === "init") {
      console.log(JSON.stringify({ database: config.storage.database, thumbnails: config.storage.thumbnails }, null, 2));
    } else if (parsed.command === "status") {
      console.log(JSON.stringify(app.database.getStatus(), null, 2));
    } else if (parsed.command === "check") {
      const models = await app.client.models();
      const names = (models.models ?? []).map((model) => model.name ?? model.model);
      console.log(JSON.stringify({
        database: "ok",
        taxonomyVersion: app.taxonomy.version,
        ollama: "ok",
        configuredModel: config.ollama.visionModel,
        modelInstalled: names.some((name) => name === config.ollama.visionModel || name?.startsWith(`${config.ollama.visionModel}:`)),
        availableModels: names,
      }, null, 2));
    } else if (parsed.command === "index") {
      const imagePath = parsed.positional[0];
      if (!imagePath) throw new Error("index requires an image path");
      console.log(JSON.stringify(await app.indexFile(imagePath, { force: parsed.force }), null, 2));
    } else if (parsed.command === "scan" || parsed.command === "queue") {
      const roots = parsed.positional.length ? [path.resolve(parsed.positional[0])] : config.library.roots;
      if (!roots.length) throw new Error(`${parsed.command} requires a directory or at least one configured library root`);
      let completed = 0;
      let skipped = 0;
      let failed = 0;
      for (const root of roots) {
        if (!fs.existsSync(root)) {
          console.error(`Missing root: ${root}`);
          failed += 1;
          continue;
        }
        for await (const imagePath of walkImages(root, config.library.extensions, config.library.followSymlinks)) {
          try {
            const result = parsed.command === "queue"
              ? await app.enqueueFile(imagePath, { force: parsed.force })
              : await app.indexFile(imagePath, { force: parsed.force });
            if (result.skipped) skipped += 1;
            else completed += 1;
            console.error(`${result.skipped ? "SKIP" : parsed.command === "queue" ? "QUEUE" : "DONE"} ${imagePath}`);
          } catch (error) {
            failed += 1;
            console.error(`FAIL ${imagePath}: ${error.message}`);
          }
        }
      }
      const summary = parsed.command === "queue"
        ? { enqueued: completed, skipped, failed }
        : { completed, skipped, failed };
      console.log(JSON.stringify(summary, null, 2));
      if (failed) process.exitCode = 2;
    } else if (parsed.command === "work") {
      const recovered = app.database.recoverStaleClassificationJobs();
      let completed = 0;
      let failed = 0;
      let retryScheduled = 0;
      while (true) {
        const result = await app.processNextJob();
        if (!result) break;
        if (result.outcome === "completed") completed += 1;
        else if (result.outcome === "failed") failed += 1;
        else retryScheduled += 1;
        console.error(`${result.outcome.toUpperCase()} #${result.job.id} ${result.job.filename}${result.error ? `: ${result.error}` : ""}`);
        if (parsed.once) break;
      }
      const queue = app.database.getStatus().queue;
      console.log(JSON.stringify({ recovered, completed, retryScheduled, failed, queue }, null, 2));
      if (failed) process.exitCode = 2;
    } else if (parsed.command === "embed") {
      const result = await app.embedCatalog({
        force: parsed.force,
        onProgress: ({ embedded, total, filename }) => console.error(`EMBED ${embedded}/${total} ${filename}`),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (parsed.command === "export-foundry") {
      console.log(JSON.stringify(app.exportFoundry(), null, 2));
    } else if (parsed.command === "package-foundry") {
      console.log(JSON.stringify(app.packageFoundry(), null, 2));
    } else if (parsed.command === "serve") {
      const server = await startCatalogServer(app);
      console.log(`Fantasy Image Catalog: http://${config.web.host}:${config.web.port}`);
      await new Promise((resolve) => {
        const shutdown = () => server.close(resolve);
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    } else {
      throw new Error(`Unknown command: ${parsed.command}`);
    }
  } finally {
    app.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
