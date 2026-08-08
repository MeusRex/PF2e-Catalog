# Fantasy Image Catalog

Local-first proof of concept for indexing fantasy artwork with an Ollama-hosted vision model and a controlled Pathfinder-oriented taxonomy.

For setup, day-to-day indexing, review, and Foundry installation instructions, see [USAGE.md](USAGE.md).

The current slice provides:

- SHA-256 identity and average-hash duplicate hints
- Deterministic WebP thumbnails
- Structured Ollama vision requests
- Closed-vocabulary tag validation and confidence thresholds
- SQLite persistence with inference provenance
- Idempotent single-image and recursive-directory indexing
- FTS5 caption, filename, visible-feature, and tag search
- Browser gallery with tag and review-status filters
- Human-reviewed caption and tag editing
- Review dashboard for low-confidence, unclassified, and failed images
- Failed-classification retry and unknown-tag suggestion triage
- Optional semantic search over versioned caption/tag embeddings
- A standalone Foundry VTT 14 / PF2e gallery module
- Confirmed actor portrait and prototype-token artwork assignment
- A deterministic unit-test suite that does not require Ollama

## Requirements

- Node.js 20 or newer
- A running Ollama service
- A vision model such as `qwen3-vl:4b` or `qwen3-vl:8b`

## Setup

```powershell
npm install
Copy-Item catalog.config.example.json catalog.config.json
npm run catalog -- init
```

Edit `catalog.config.json` to select the image directories and installed Ollama model. Start Ollama separately, then check connectivity:

```powershell
npm run catalog -- check
```

## Index one image

```powershell
npm run catalog -- index "D:\Fantasy Art\example.webp"
```

Running the command again skips vision inference if the image already has a successful result for the configured model, prompt, and taxonomy versions. Use `--force` to reclassify it:

```powershell
npm run catalog -- index "D:\Fantasy Art\example.webp" --force
```

## Scan a directory

```powershell
npm run catalog -- scan "D:\Fantasy Art"
```

With no directory argument, `scan` uses the roots in `catalog.config.json`.

For a large collection, prefer the durable queue instead of immediate `scan` processing:

```powershell
npm run catalog -- queue "D:\Fantasy Art"
npm run catalog -- work
```

`queue` hashes images, creates thumbnails, and records persistent classification jobs without calling Ollama. `work` processes all jobs that are currently ready and exits when the queue is drained or remaining retries are waiting for their backoff time. Running `work` again resumes from the stored state.

Process at most one job when testing a model or prompt:

```powershell
npm run catalog -- work --once
```

Queue behavior:

- Jobs are tied to the configured model, prompt version, and taxonomy version.
- Repeated discovery does not duplicate pending or completed jobs.
- `queue --force` resets the matching job for deliberate reprocessing.
- Failed attempts use bounded exponential backoff and stop at `classification.maxAttempts`.
- Jobs left running by an interrupted worker are recovered after 30 minutes.
- A worker never claims an older job created for different model or taxonomy versions.

## Inspect catalog status

```powershell
npm run catalog -- status
```

## Open the local gallery

```powershell
npm run catalog -- serve
```

Open <http://127.0.0.1:8787> in a browser. The gallery provides:

- Full-text search over filenames, captions, visible features, and tags
- Exact intersection filtering across controlled taxonomy tags
- Review-status and sorting controls
- Original-image previews served only for cataloged files
- Caption and tag correction

The **Review queue** page shows catalog health, images whose latest Ollama request failed, and model-suggested concepts that are not in the controlled taxonomy. Failed items can be retried after Ollama is available. Suggestions can be marked handled or rejected, but they never become canonical tags automatically.

It also displays persistent batch jobs. The **Process one ready job** control is useful for supervised testing; use `npm run catalog -- work` for unattended batches.

## Semantic search

After images have captions and tags, install the configured embedding model and build the semantic index:

```powershell
ollama pull embeddinggemma
npm run catalog -- embed
```

The command batches all classified images, skips records whose search document has not changed, and stores compact vectors in SQLite. Use `--force` to rebuild every vector deliberately:

```powershell
npm run catalog -- embed --force
```

Choose **Semantic** beside the gallery search box for meaning-based queries such as `weathered wilderness healer with an animal companion`. Exact taxonomy filters remain active during semantic search.

Important behavior:

- Keyword search remains the default and does not require Ollama.
- Semantic queries require Ollama and the configured `embedding.model` to be available.
- Caption or tag corrections invalidate that image's stale vector automatically.
- Re-running `embed` refreshes only missing or invalidated vectors.
- Embeddings from different models are stored separately and never compared.
- Similarity is calculated locally; no image or vector data leaves the machine.

## Foundry module

Build the complete module from the current catalog with:

```powershell
npm run catalog -- package-foundry
```

The ready-to-install directory is written to:

```text
data/module-build/fantasy-image-catalog/
```

Copy that whole directory into the Foundry user-data modules directory while Foundry is stopped. For the portable installation used during development, the destination is:

```text
C:\Users\cedis\Downloads\FoundryVTT-WindowsPortable-14.365\Data\modules\fantasy-image-catalog
```

Start Foundry, enable **Fantasy Image Catalog** in the PF2e world, and open it using **Image Catalog** in the Actor sidebar or an actor-sheet header. The gallery supports text search, include/exclude tag filters, a target-actor selector, full-image inspection, portrait-only assignment, portrait-and-prototype-token assignment, and GM-only NPC creation. Artwork changes require confirmation and actor update permission.

`package-foundry` first refreshes the generated catalog, then assembles module code and data in one replaceable staging directory. The standalone catalog server and Ollama do not need to be running while Foundry uses it. Re-run the command and replace the installed module directory whenever catalog metadata or images change.

By default the module uses the same image for an actor portrait and prototype token. It does not alter tokens already placed on scenes. Gallery access, the sheet-header button, new actor type, and catalog path are world settings.

To generate only the data payload, without assembling the module, run:

```powershell
npm run catalog -- export-foundry
```

By default, the export is written beneath `data/foundry-export`:

```text
data/foundry-export/
  catalog.json
  catalog.schema.json
  assets/
  thumbnails/
```

Portraits and thumbnails are copied under stable SHA-256-based filenames. The catalog contains forward-slash Foundry URLs such as:

```text
modules/fantasy-image-catalog/generated/assets/<sha256>.webp
```

Configure `foundry.outputDirectory` when a different staging location is required. `foundry.assetBasePath` must describe the URL at which the staged directory will eventually be served by Foundry. The default assumes the staged contents will be deployed as:

```text
Data/modules/fantasy-image-catalog/generated/
```

The export command:

- Includes no absolute Windows source paths.
- Sorts entries by content identity for stable output.
- Validates every source portrait and thumbnail before replacing the catalog.
- Avoids recopying identical staged assets.
- Writes `catalog.json` through a temporary file.
- Aborts the manifest update if any required asset is missing.

Configure `foundry.buildDirectory` to change where the complete module is assembled. Keep `foundry.moduleId`, `foundry.assetBasePath`, and the manifest id aligned; packaging refuses a mismatched manifest id.

Saving an entry in the review editor replaces its model tags with an authoritative human-reviewed set. Later AI reclassification attempts remain in the inference audit history but do not overwrite reviewed metadata.

## Tests

```powershell
npm test
```

## Data safety

The indexer reads but never modifies source images. Generated thumbnails and SQLite files are written under the configured storage paths. Model responses, prompt version, taxonomy version, timing, and failures are retained for diagnosis and selective reprocessing.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full roadmap.
