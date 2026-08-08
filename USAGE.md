# Fantasy Image Catalog Usage Guide

This guide covers the normal workflow for indexing fantasy artwork with Ollama, reviewing the generated tags, and using the resulting gallery in Foundry VTT.

## 1. Requirements

- Node.js 20 or newer
- Ollama running locally
- An Ollama vision model, such as `qwen3-vl:8b`
- Foundry VTT 14 with the PF2e system if you want to use the Foundry module

Open WebUI is optional. Fantasy Image Catalog communicates directly with Ollama at `http://127.0.0.1:11434` by default.

Check that Ollama is running and see which models are installed:

```powershell
ollama list
```

Install the default vision model if necessary:

```powershell
ollama pull qwen3-vl:8b
```

## 2. Initial setup

Open PowerShell in the project directory:

```powershell
Set-Location "C:\Users\cedis\Downloads\monster jsons"
```

Install the application dependencies:

```powershell
npm install
```

Create your local configuration:

```powershell
Copy-Item catalog.config.example.json catalog.config.json
```

Open `catalog.config.json` and change `library.roots` to the directories containing your images. For example:

```json
"library": {
  "roots": [
    "C:/Users/cedis/Pictures/Fantasy"
  ]
}
```

JSON paths can use forward slashes. If you use backslashes, each one must be doubled.

Ensure that `ollama.visionModel` names an installed vision model:

```json
"ollama": {
  "baseUrl": "http://127.0.0.1:11434/api",
  "visionModel": "qwen3-vl:8b"
}
```

Initialize the local database and thumbnail directories:

```powershell
npm run catalog -- init
```

Check the configuration, database, taxonomy, Ollama connection, and model availability:

```powershell
npm run catalog -- check
```

The result should report `ollama: "ok"` and `modelInstalled: true`.

## 3. Indexing images

### Recommended batch workflow

Discover the images under every configured `library.roots` directory and add them to the persistent work queue:

```powershell
npm run catalog -- queue
```

Process the queued images with Ollama:

```powershell
npm run catalog -- work
```

You can stop the worker with Ctrl+C and run it again later. Completed jobs remain completed, and unfinished work stays in the database.

To process only one ready job while testing the model:

```powershell
npm run catalog -- work --once
```

### Index one image

To classify a single image immediately:

```powershell
npm run catalog -- index "C:\path\to\example.webp"
```

### Repeated runs and duplicate handling

You do not need to remove processed images from the source folders.

Normal repeated runs of `queue` and `work`:

- Skip images that have already been classified or human-reviewed, regardless of later taxonomy changes.
- Do not create duplicate pending jobs.
- Recognize an image by its SHA-256 content hash, even if it was renamed or moved.
- Treat a genuinely edited image as new content.
- Retry failed jobs up to `classification.maxAttempts`, with a delay between attempts.

Model, prompt, and taxonomy versions remain recorded for auditing. Version changes do not automatically make handled images eligible again; use `--force` or **Queue AI re-evaluation** in the image editor when you intentionally want a fresh current-version classification.

To deliberately reclassify discovered images, use:

```powershell
npm run catalog -- queue --force
npm run catalog -- work
```

Use `--force` only when reprocessing is intentional because it runs the vision model again.

Removing an image from its source directory does not currently remove its existing database record automatically.

## 4. Checking progress

Display catalog and queue counts:

```powershell
npm run catalog -- status
```

The browser review page also displays classification failures and persistent queue status.

## 5. Browser gallery and review

Start the local web application:

```powershell
npm run catalog -- serve
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787) in a browser.

The browser interface supports:

- Filename, caption, visible-feature, and tag search
- Controlled taxonomy filters
- Sorting and review-status filtering
- Original-image previews
- Caption and canonical-tag corrections
- Low-confidence and unclassified review queues
- Failed-classification retry
- Unknown-tag suggestion triage
- Taxonomy editing, aliases, descriptions, and broader-tag relationships
- Suggestion mapping to existing or newly created canonical tags

Saving an image in the review editor makes its corrected caption and tags authoritative. Later AI classifications remain in the audit history but do not overwrite human-reviewed metadata.

The image editor can explicitly queue an AI re-evaluation. The Review queue can remove individual pending jobs or all pending work; it never removes running or completed jobs.

Use the **Taxonomy** page to define aliases and `implies` relationships. An image tagged with a narrow tag automatically matches filters for every broader tag it implies, and inherited tags are included in Foundry exports. Taxonomy changes increment its version and invalidate existing semantic vectors, so run `npm run catalog -- embed` after wrangling changes.

Stop the local server with Ctrl+C.

## 6. Optional semantic search

Install the configured embedding model:

```powershell
ollama pull embeddinggemma
```

Generate embeddings for classified images:

```powershell
npm run catalog -- embed
```

The command skips unchanged search documents. To rebuild all embeddings deliberately:

```powershell
npm run catalog -- embed --force
```

Select **Semantic** in the browser gallery to search by meaning rather than exact words. Ollama must be running for semantic queries, but ordinary keyword search works without it.

## 7. Building the Foundry module

After indexing and reviewing the catalog, assemble the complete module:

```powershell
npm run catalog -- package-foundry
```

The default output is:

```text
C:\Users\cedis\Downloads\monster jsons\data\module-build\fantasy-image-catalog
```

The packaged module contains all gallery code, catalog metadata, portraits, and thumbnails. Foundry does not require Ollama or the standalone browser server to use it.

## 8. Installing the Foundry module

Stop Foundry before replacing module files. Copy the complete packaged directory into the Foundry user-data modules directory:

```powershell
Copy-Item -Recurse -Force `
  ".\data\module-build\fantasy-image-catalog" `
  "C:\Users\cedis\Downloads\FoundryVTT-WindowsPortable-14.365\Data\modules\"
```

Then:

1. Start Foundry.
2. Open the PF2e world.
3. Open **Manage Modules**.
4. Enable **Fantasy Image Catalog**.
5. Open the Actor sidebar and click **Image Catalog**, or use the button in an actor-sheet header.

The Foundry gallery supports:

- Text search and include/exclude tag filters
- Selection of a target actor
- Full-size image inspection
- Actor portrait assignment
- Actor portrait and prototype-token assignment
- GM-only NPC creation

Artwork replacement requires confirmation and permission to update the selected actor. Portrait-and-token assignment updates the actor's prototype token; it does not alter tokens already placed on scenes.

## 9. Updating the Foundry catalog

When new images have been added:

```powershell
npm run catalog -- queue
npm run catalog -- work
npm run catalog -- package-foundry
```

Stop Foundry, copy the rebuilt module directory to `Data\modules` again, and restart Foundry. Repackaging replaces the generated catalog with the current database contents.

If only captions or tags were corrected in the browser, you can skip `queue` and `work`:

```powershell
npm run catalog -- package-foundry
```

## 10. Common problems

### `modelInstalled` is false

The value of `ollama.visionModel` does not exactly match an installed Ollama model. Run `ollama list`, then update the configuration or pull the configured model.

### Ollama connection fails

Start Ollama and confirm that its local API is available. The default configuration expects `http://127.0.0.1:11434/api`.

### The browser gallery is empty

Run `queue`, then `work`, and inspect `npm run catalog -- status`. Images do not appear as classified until Ollama processing succeeds.

### The Foundry gallery is empty after browser review

Run `npm run catalog -- package-foundry` again and replace the installed module directory. The Foundry module reads the static catalog produced at packaging time.

### A failed image is not retried immediately

Failed jobs use delayed retry backoff and stop after `classification.maxAttempts`. Check the review page or `status`. Use `queue --force` only when you intentionally want to reset classification work.

### An image appears only once after being renamed

This is expected. Content hashes identify images independently of filenames and paths.

## 11. Routine command summary

```powershell
# Discover new or changed images
npm run catalog -- queue

# Run AI classification
npm run catalog -- work

# Inspect progress
npm run catalog -- status

# Open the browser interface
npm run catalog -- serve

# Build the static Foundry module
npm run catalog -- package-foundry
```
