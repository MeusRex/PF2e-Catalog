import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = {
  library: {
    roots: [],
    extensions: [".png", ".jpg", ".jpeg", ".webp"],
    followSymlinks: false,
  },
  storage: {
    database: "./data/catalog.sqlite3",
    thumbnails: "./data/thumbnails",
    thumbnailMaxSize: 384,
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/api",
    visionModel: "qwen3-vl:8b",
    requestTimeoutSeconds: 300,
    keepAlive: "10m",
  },
  embedding: {
    model: "embeddinggemma",
    batchSize: 32,
    semanticCandidateLimit: 500,
  },
  classification: {
    promptVersion: "vision-v1",
    taxonomyFile: "./taxonomy/taxonomy.json",
    minimumConfidence: 0.55,
    reviewConfidence: 0.75,
    maximumInferenceDimension: 1280,
    maxAttempts: 3,
  },
  web: {
    host: "127.0.0.1",
    port: 8787,
  },
  foundry: {
    outputDirectory: "./data/foundry-export",
    buildDirectory: "./data/module-build",
    moduleId: "fantasy-image-catalog",
    assetBasePath: "modules/fantasy-image-catalog/generated",
    includeUnclassified: true,
  },
};

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    library: { ...base.library, ...override?.library },
    storage: { ...base.storage, ...override?.storage },
    ollama: { ...base.ollama, ...override?.ollama },
    embedding: { ...base.embedding, ...override?.embedding },
    classification: { ...base.classification, ...override?.classification },
    web: { ...base.web, ...override?.web },
    foundry: { ...base.foundry, ...override?.foundry },
  };
}

function resolveFrom(baseDirectory, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDirectory, value);
}

export function loadConfig(configPath = "catalog.config.json") {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  let override = {};

  if (fs.existsSync(absoluteConfigPath)) {
    override = JSON.parse(fs.readFileSync(absoluteConfigPath, "utf8"));
  }

  const config = mergeConfig(DEFAULT_CONFIG, override);
  config.storage.database = resolveFrom(configDirectory, config.storage.database);
  config.storage.thumbnails = resolveFrom(configDirectory, config.storage.thumbnails);
  config.classification.taxonomyFile = resolveFrom(configDirectory, config.classification.taxonomyFile);
  config.foundry.outputDirectory = resolveFrom(configDirectory, config.foundry.outputDirectory);
  config.foundry.buildDirectory = resolveFrom(configDirectory, config.foundry.buildDirectory);
  config.library.roots = config.library.roots.map((root) => resolveFrom(configDirectory, root));
  config.library.extensions = config.library.extensions.map((extension) => extension.toLowerCase());

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!config.ollama.baseUrl.startsWith("http://") && !config.ollama.baseUrl.startsWith("https://")) {
    throw new Error("ollama.baseUrl must be an HTTP(S) URL");
  }
  if (!config.ollama.visionModel) throw new Error("ollama.visionModel is required");
  if (!config.embedding.model) throw new Error("embedding.model is required");
  if (!Number.isInteger(config.embedding.batchSize) || config.embedding.batchSize < 1) {
    throw new Error("embedding.batchSize must be a positive integer");
  }
  if (config.storage.thumbnailMaxSize < 64) throw new Error("storage.thumbnailMaxSize must be at least 64");
  if (config.classification.minimumConfidence < 0 || config.classification.minimumConfidence > 1) {
    throw new Error("classification.minimumConfidence must be between 0 and 1");
  }
  if (config.classification.reviewConfidence < config.classification.minimumConfidence) {
    throw new Error("classification.reviewConfidence must not be below minimumConfidence");
  }
  if (!Number.isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535) {
    throw new Error("web.port must be an integer between 1 and 65535");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.foundry.moduleId)) {
    throw new Error("foundry.moduleId must contain only lowercase letters, digits, and hyphens");
  }
  if (!config.foundry.assetBasePath
    || config.foundry.assetBasePath.startsWith("/")
    || /^[a-z]+:/i.test(config.foundry.assetBasePath)
    || config.foundry.assetBasePath.includes("\\")
    || config.foundry.assetBasePath.split("/").includes("..")) {
    throw new Error("foundry.assetBasePath must be a safe forward-slash relative path");
  }
}

export function ensureStorageDirectories(config) {
  fs.mkdirSync(path.dirname(config.storage.database), { recursive: true });
  fs.mkdirSync(config.storage.thumbnails, { recursive: true });
}
