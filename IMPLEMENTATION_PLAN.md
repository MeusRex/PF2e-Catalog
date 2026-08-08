# Self-Hosted Fantasy Image Catalog

## 1. Objective

Build a local-first application that scans a collection of fantasy artwork, uses an Ollama-hosted vision model to describe each image, maps the description into a controlled Pathfinder-oriented taxonomy, and provides fast filtering and natural-language search.

The first release will be a standalone catalog. A later Foundry VTT module will consume an exported catalog and allow selected artwork to be assigned to actors and prototype tokens.

## 2. Success Criteria

The initial application is successful when it can:

1. Scan one or more configured image directories without modifying the originals.
2. Detect new, changed, moved, and duplicate images.
3. Generate a factual caption and controlled tags using a local Ollama vision model.
4. Reject tags that are not present in the configured taxonomy.
5. Preserve confidence, model, prompt, and taxonomy-version metadata.
6. Resume an interrupted indexing run without repeating completed work.
7. Display a thumbnail gallery with tag filters and full-text search.
8. Let a user correct captions and tags.
9. Export a stable, Foundry-readable JSON catalog.
10. Keep all images and derived metadata on the local machine unless explicitly configured otherwise.

Suggested quality targets for a representative validation set:

- At least 90% of images receive a useful subject, role, and framing classification.
- Fewer than 5% of accepted tags are obvious hallucinations after human review.
- Zero unknown tags enter the canonical tag tables.
- An interrupted batch can restart without losing work.
- Exact tag searches over 10,000 records return in under 500 ms on the target machine.

## 3. Scope

### Included in the MVP

- Directory scanning
- Content and perceptual hashing
- Thumbnail generation
- Ollama vision inference
- Schema-constrained responses
- Controlled taxonomy and aliases
- SQLite persistence
- Resumable processing queue
- Caption and exact-tag search
- Review and correction interface
- Catalog JSON export

### Deferred until after the MVP

- Semantic search with embeddings
- Automatic filesystem watching
- Foundry VTT module
- Actor creation and token assignment
- Token-ring generation
- Multi-user permissions
- Remote or cloud inference
- Training or fine-tuning a model
- Automatic creation of canonical tags from model suggestions

### Explicit non-goals

- Determining mechanically correct PF2e statistics from artwork
- Treating inferred ancestry, class, gender identity, or magical tradition as fact
- Reorganizing or renaming source images automatically
- Replacing a digital asset management system for licensing and provenance

## 4. Architectural Decisions

### 4.1 Separate observations from canonical tags

Every indexed image has two layers of metadata:

- **Observation layer:** an open-ended factual caption, visible objects, and model suggestions.
- **Catalog layer:** validated tag IDs selected exclusively from the controlled taxonomy.

The observation layer can be regenerated as models improve. The catalog layer remains stable for search and Foundry integration.

### 4.2 Keep inference and normalization logically separate

The MVP may perform both operations in one schema-constrained vision request, but the stored data must preserve the distinction. This makes it possible to introduce a separate text-based normalization step later without migrating image records.

### 4.3 Never modify source images

Metadata lives in SQLite. Optional JSON sidecars may be added later for portability. Images are identified by SHA-256 content hash rather than filename alone.

### 4.4 Use SQLite before adding a vector database

SQLite is sufficient for thousands of images, relational tag filtering, queue state, and full-text search. Semantic embeddings can initially be compared in application code. A dedicated vector database should only be introduced after measurements demonstrate a need.

### 4.5 Keep Foundry integration file-based

The standalone application exports a static `catalog.json` and thumbnails into a Foundry-accessible directory. The Foundry module reads those assets rather than depending on a separate local HTTP service. This works more reliably for remote Foundry servers and avoids browser CORS and local-path limitations.

## 5. Proposed Technology Stack

### Backend

The implementation uses Node.js 20 because it is already installed on the target machine while Python is not. This is an implementation-level change; the architecture and persisted formats remain unchanged.

- Node.js 20+ using ECMAScript modules
- Native Node HTTP server or a small web framework for later HTTP endpoints
- JSON Schema for configuration and inference contracts
- `better-sqlite3` for persistence and migrations
- `sharp` for image inspection, resizing, hashes, and thumbnails
- Native `fetch` for Ollama requests
- SQLite with WAL mode and FTS5

### Frontend

Start with server-rendered HTML using Jinja2 and HTMX. This keeps the MVP small while supporting interactive filters, review forms, and paginated galleries. Move to React, Vue, or Svelte only if the Foundry and standalone interfaces later need to share substantial client-side components.

### AI services

- Ollama native API at `http://localhost:11434/api`
- Configurable vision model; begin evaluation with `qwen3-vl:4b` and `qwen3-vl:8b`
- Temperature `0` for tagging
- Optional embedding model after MVP; begin evaluation with `embeddinggemma`

Open WebUI is not a runtime dependency. It can be used to test prompts and models or act as an authenticated proxy when desired.

## 6. Suggested Repository Layout

```text
fantasy-image-catalog/
  README.md
  package.json
  package-lock.json
  catalog.config.example.json
  src/
    cli.js
    catalog.js
    config.js
    database.js
    image.js
    ollama.js
    classifier.js
    taxonomy.js
    search.js
    exporter.js
    templates/
    static/
  migrations/
  taxonomy/
    taxonomy.json
  prompts/
    vision-v1.txt
    normalization-v1.txt
  test/
    fixtures/
    evaluation/
  data/
    .gitkeep
  foundry-module/
    module.json
    scripts/
    styles/
    templates/
```

Do not store personal image collections or generated thumbnails in source control.

## 7. Configuration

Use a checked schema loaded from environment variables and a local configuration file.

Example:

```json
{
  "library": {
    "roots": ["D:/Fantasy Art"],
    "extensions": [".png", ".jpg", ".jpeg", ".webp"],
    "followSymlinks": false
  },
  "storage": {
    "database": "./data/catalog.sqlite3",
    "thumbnails": "./data/thumbnails",
    "thumbnailMaxSize": 384
  },
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434/api",
    "visionModel": "qwen3-vl:8b",
    "requestTimeoutSeconds": 300,
    "keepAlive": "10m"
  },
  "classification": {
    "promptVersion": "vision-v1",
    "taxonomyFile": "./taxonomy/taxonomy.json",
    "minimumConfidence": 0.55,
    "reviewConfidence": 0.75,
    "maximumInferenceDimension": 1280,
    "maxAttempts": 3
  }
}
```

Paths, URLs, and API credentials must never be hard-coded.

## 8. Taxonomy Design

### 8.1 Initial categories

Begin with approximately 100–200 useful values distributed across:

- `subject_type`
- `ancestry_candidate`
- `morphology`
- `apparent_role`
- `equipment`
- `armor`
- `clothing`
- `magic_theme`
- `element`
- `pose`
- `framing`
- `background`
- `environment`
- `mood`
- `age_presentation`
- `gender_presentation`
- `dominant_color`

Potentially sensitive or uncertain categories must be clearly marked as visual presentation or candidate inference.

### 8.2 Canonical tag format

```yaml
version: "1.0.0"
categories:
  apparent_role:
    label: "Apparent Role"
    maximum_tags: 3
    values:
      martial_artist:
        label: "Martial Artist"
        parents: [martial]
      priest:
        label: "Priest"
        parents: [spellcaster]
  morphology:
    label: "Morphology"
    maximum_tags: 8
    values:
      canine:
        label: "Canine"
      wings:
        label: "Wings"
```

Tag IDs are stable machine identifiers. Labels can change without breaking searches or exports.

### 8.3 Aliases

```yaml
martial_artist:
  - monk
  - brawler
  - unarmed fighter
canine:
  - wolf-like
  - dog-like
  - lupine
```

Aliases influence normalization and query parsing but are not stored as additional image tags.

### 8.4 Taxonomy governance

- Never add a canonical tag automatically.
- Store unsupported concepts as suggestions.
- Review suggestions after representative batches.
- Record taxonomy changes in version control.
- Provide migrations for renamed or merged tag IDs.
- Prefer broad reusable visual concepts over campaign-specific names.

## 9. Inference Contract

Use a Pydantic model to generate the JSON Schema passed to Ollama.

Conceptual response:

```json
{
  "caption": "A wolf-like humanoid martial artist in red robes...",
  "visible_features": ["gray fur", "canine head", "red robes"],
  "tags": [
    {
      "category": "morphology",
      "tag": "canine",
      "confidence": 0.98,
      "evidence": "The figure has a visibly canine head and muzzle."
    },
    {
      "category": "apparent_role",
      "tag": "martial_artist",
      "confidence": 0.88,
      "evidence": "Unarmed combat pose and loose fighting robes."
    }
  ],
  "suggested_tags": [],
  "warnings": []
}
```

Validation rules:

1. Caption is required and has a configured maximum length.
2. Category and tag must form a valid taxonomy pair.
3. Confidence must be between 0 and 1.
4. Category maximums are enforced after sorting by confidence.
5. Duplicate tags are collapsed.
6. Tags below the minimum confidence are stored only as observations.
7. Tags below the review threshold enter the review queue.
8. Invalid responses are retried with validation errors included in the repair prompt.
9. After the final failed attempt, the job becomes `failed`; it must not silently create partial catalog data.

## 10. Database Model

### `images`

- `id`
- `sha256` — unique content identity
- `perceptual_hash`
- `current_path`
- `filename`
- `extension`
- `width`
- `height`
- `file_size`
- `modified_at`
- `thumbnail_path`
- `caption`
- `review_status`
- `created_at`
- `updated_at`

### `image_locations`

Tracks multiple paths for duplicates and path history.

- `id`
- `image_id`
- `path`
- `is_current`
- `last_seen_at`

### `tags`

- `id`
- `category`
- `canonical_name`
- `display_name`
- `taxonomy_version`
- unique constraint on `(category, canonical_name)`

### `image_tags`

- `image_id`
- `tag_id`
- `confidence`
- `evidence`
- `source` — `model`, `rule`, or `human`
- `reviewed`
- `created_at`
- unique constraint on `(image_id, tag_id)`

### `inference_runs`

- `id`
- `image_id`
- `model`
- `model_digest`, when available
- `prompt_version`
- `taxonomy_version`
- `request_json`
- `response_json`
- `duration_ms`
- `status`
- `error`
- `created_at`

### `jobs`

- `id`
- `image_id`
- `kind`
- `status` — `pending`, `running`, `completed`, `failed`, `cancelled`
- `attempts`
- `available_at`
- `started_at`
- `completed_at`
- `last_error`

### `tag_suggestions`

- `id`
- `image_id`
- `label`
- `suggested_category`
- `reason`
- `occurrence_count`
- `status` — `pending`, `accepted`, `mapped`, `rejected`

### `image_search` FTS5 table

Index captions, filenames, visible features, reviewed tag labels, and aliases needed for text search.

## 11. Processing Pipeline

### 11.1 Discovery

1. Enumerate supported files beneath configured roots.
2. Read file metadata.
3. Compute SHA-256 when the file is new or appears changed.
4. Create or update the image and location records.
5. Mark locations not seen during a complete scan as missing without deleting metadata.

### 11.2 Image preparation

1. Validate that the file can be decoded.
2. Apply EXIF orientation.
3. Record dimensions and format.
4. Generate a thumbnail using a deterministic name based on the content hash.
5. Calculate a perceptual hash for near-duplicate review.
6. Create a bounded inference copy, preserving aspect ratio, if the source is unnecessarily large.

### 11.3 Classification

1. Claim one pending job transactionally.
2. Load the current taxonomy and prompt.
3. Submit the image and JSON Schema to Ollama.
4. Parse and validate the response.
5. Persist the raw inference run before applying accepted tags.
6. Normalize, deduplicate, and threshold tags.
7. Rebuild the image's FTS document.
8. Mark the job complete or schedule a retry with backoff.

Only one inference worker should be enabled by default. Configurable concurrency can be added after measuring GPU and memory behavior.

### 11.4 Reprocessing

An image requires reprocessing when any of the following changes:

- Content hash
- Vision model or model digest
- Prompt version
- Taxonomy version
- Classification algorithm version

Human-reviewed tags must not be overwritten. Reprocessing should replace only model-generated tags and retain an audit history.

## 12. Backend API

Initial endpoints:

```text
GET    /api/health
GET    /api/models
POST   /api/scans
GET    /api/scans/{id}
POST   /api/jobs/run
GET    /api/jobs
POST   /api/jobs/{id}/retry

GET    /api/images
GET    /api/images/{id}
PATCH  /api/images/{id}
POST   /api/images/{id}/reclassify
GET    /api/images/{id}/thumbnail

GET    /api/taxonomy
GET    /api/tag-suggestions
PATCH  /api/tag-suggestions/{id}

GET    /api/search
POST   /api/exports/foundry
```

Important `GET /api/images` parameters:

- `query`
- `tags`
- `exclude_tags`
- `categories`
- `review_status`
- `path_prefix`
- `duplicate_group`
- `sort`
- `page`
- `page_size`

## 13. User Interface

### Gallery

- Responsive thumbnail grid
- Search box
- Collapsible tag-category filters
- Active-filter chips
- Result count
- Sort by filename, added date, modified date, confidence, or random
- Multi-select for bulk tagging

### Image detail

- Large preview
- Original path and metadata
- Editable caption
- Accepted tags grouped by category
- Confidence and evidence display
- Add/remove canonical tags
- Model and prompt provenance
- Reclassify button
- Nearby perceptual duplicates

### Review queue

- Low-confidence tags
- Conflicting classifications
- Failed jobs
- Suggested unknown tags
- Images missing important categories
- Random quality-control samples

### Job dashboard

- Pending, running, completed, and failed counts
- Current image and elapsed time
- Average inference duration
- Pause after current image
- Retry failed jobs
- Model availability status

## 14. Search Roadmap

### MVP search

- Exact intersection and union of canonical tags
- Tag exclusion
- Category filters
- FTS5 over caption, visible features, filename, and tag labels

### Semantic-search extension

1. Construct a stable search document from the caption and canonical tag labels.
2. Generate an embedding using Ollama `/api/embed`.
3. Store the embedding with its model and document version.
4. Embed the user's natural-language query with the same model.
5. Rank candidates using cosine similarity.
6. Combine semantic score with exact tag filters and text-match score.

For the initial collection size, embeddings can be loaded and compared in memory. Introduce FAISS, sqlite-vec, or Qdrant only after measuring unacceptable latency.

## 15. Foundry VTT Integration

### 15.1 Export format

Generate a versioned catalog:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-07T12:00:00Z",
  "taxonomyVersion": "1.0.0",
  "images": [
    {
      "id": "sha256-prefix-or-stable-uuid",
      "portrait": "modules/my-character-gallery/assets/example.webp",
      "thumbnail": "modules/my-character-gallery/thumbnails/example.webp",
      "caption": "A stern dwarven priest in red robes.",
      "tags": {
        "ancestry_candidate": ["dwarf"],
        "apparent_role": ["priest"],
        "clothing": ["robes"]
      }
    }
  ]
}
```

The exporter must convert operating-system paths into Foundry-relative, forward-slash paths and verify that every exported asset is inside a configured Foundry-served directory.

### 15.2 Foundry module features

Phase one:

- Sidebar button to open the gallery
- Thumbnail grid and canonical tag filters
- Text search over the exported catalog
- Set selected actor portrait
- Set prototype-token texture
- Copy Foundry asset path

Phase two:

- Create a blank PF2e NPC actor using selected art
- Optional Tokenizer integration
- Favorites and campaign-specific collections stored in Foundry settings
- Configurable player access

### 15.3 Foundry safety

- Do not expose arbitrary filesystem paths to clients.
- Never assume the Foundry server and browser run on the same machine.
- Require GM permission for actor changes.
- Update only the selected actor fields.
- Keep generated catalogs and user overrides outside directories that module updates replace.

## 16. Implementation Milestones

### Milestone 0: evaluation fixture and taxonomy draft

Deliverables:

- A manually selected set of approximately 50 representative images
- Expected high-level tags for those images
- Taxonomy v1 draft
- Prompt v1
- Benchmark script for candidate vision models

Acceptance criteria:

- The evaluation set covers portraits, full-body art, groups, monsters, unusual ancestries, weapons, armor, spell effects, and varied backgrounds.
- Results from at least two model sizes can be compared for accuracy and processing time.

### Milestone 1: project foundation

Deliverables:

- Python project and dependency management
- Configuration loader
- Database connection and migrations
- Health endpoint
- Structured logging
- Basic test infrastructure

Acceptance criteria:

- A fresh checkout can initialize the database with one command.
- Invalid configuration fails with a clear message.
- Health output reports database and Ollama reachability separately.

### Milestone 2: scanner and asset preparation

Deliverables:

- Recursive scanner
- SHA-256 and perceptual hashing
- Image metadata extraction
- Deterministic thumbnails
- Duplicate and missing-location tracking

Acceptance criteria:

- Repeated scans do not create duplicate image records.
- Renaming an image adds a location without losing metadata.
- Corrupt images are recorded as actionable errors.
- Originals remain byte-for-byte unchanged.

### Milestone 3: Ollama classification pipeline

Deliverables:

- Ollama client
- Pydantic inference schema
- Prompt and taxonomy loading
- Persistent job queue
- Retry and validation behavior
- Raw inference audit records

Acceptance criteria:

- The worker resumes after application restart.
- Unknown tags cannot enter `image_tags`.
- A failed response is preserved for diagnosis.
- Human tags survive reclassification.

Implementation status: **Complete for the current scope.** Classification jobs are durable and versioned, enqueueing is idempotent, workers claim jobs transactionally, interrupted work is recovered, retry backoff is bounded, and terminal failures remain visible in the review dashboard.

### Milestone 4: gallery and review UI

Deliverables:

- Paginated gallery
- Exact tag and caption search
- Image detail view
- Tag/caption editing
- Review queue
- Job dashboard

Acceptance criteria:

- A user can locate an image using two or more tag categories.
- Corrections are durable and identified as human-originated.
- Failed and low-confidence records are visible without database access.

Implementation status: **Complete for the current scope.** The local gallery, FTS5 search, exact tag filters, image detail view, authoritative caption/tag review, catalog-health dashboard, failed-inference retry, and tag-suggestion triage are implemented. Bulk editing remains a later enhancement.

### Milestone 5: quality pass and batch indexing

Deliverables:

- Evaluation report
- Revised prompt and taxonomy
- Batch-control UI
- Backup and restore instructions
- Full collection indexing run

Acceptance criteria:

- Quality targets in Section 2 are measured and documented.
- The database can be backed up while the application is stopped and restored successfully.
- The entire collection finishes without manual database repair.

### Milestone 6: semantic search

Deliverables:

- Embedding job type
- Versioned embedding storage
- Natural-language query endpoint
- Hybrid ranking

Acceptance criteria:

- Semantic search finds useful images when the query contains no exact canonical tag label.
- Re-embedding can resume and does not overwrite tags or captions.
- Query latency is measured before any vector-database dependency is added.

Implementation status: **Complete for semantic mode.** Versioned vectors are stored as compact SQLite blobs, unchanged search documents are skipped, metadata edits invalidate stale vectors, cosine ranking runs locally, and exact taxonomy filters remain applicable. Reciprocal-rank fusion with keyword results is reserved for a later relevance-tuning pass.

### Milestone 7: Foundry catalog export

Deliverables:

- Versioned JSON export
- Asset-path validation
- Optional thumbnail and image copying
- Incremental export behavior

Acceptance criteria:

- Every exported image URL is resolvable by the configured Foundry server.
- The export is deterministic apart from its generation timestamp.
- Missing or out-of-root assets produce explicit errors.

Implementation status: **Complete.** The exporter validates assets, copies portraits and thumbnails under content-hash names, emits only Foundry-safe relative URLs, sorts records deterministically, avoids redundant copies, writes a versioned schema alongside the catalog, and replaces the manifest through a temporary file.

### Milestone 8: Foundry module

Deliverables:

- Module manifest
- Character-gallery application
- Filters and text search
- Actor portrait and prototype-token assignment
- GM-only write permissions

Acceptance criteria:

- The module works without the standalone indexer running.
- Selecting art updates only the intended actor.
- The gallery remains responsive with at least 10,000 catalog entries.

Implementation status: **Functional module complete; large-catalog performance validation remains.** The Foundry V14/PF2e module manifest, ApplicationV2 gallery, text and tri-state taxonomy filtering, permission-aware actor selection, confirmed portrait/prototype-token assignment, GM actor creation, settings, and deterministic module packaging are implemented. It runs entirely from packaged static assets and does not require Ollama or the standalone server. Manifest/catalog/build behavior has automated coverage; the 10,000-entry browser benchmark and live Foundry interaction matrix remain before declaring the milestone fully complete.

## 17. Testing Strategy

### Unit tests

- Taxonomy loading and validation
- Alias normalization
- Tag thresholds and category limits
- Path normalization
- Content-hash identity
- Foundry export serialization
- Search query parsing

### Integration tests

- SQLite migrations
- Scan, rename, modify, and missing-file scenarios
- Thumbnail generation for supported formats
- Mocked Ollama success, malformed JSON, timeout, and retry responses
- Job recovery after simulated interruption
- Human-tag preservation during reclassification

### Model evaluation tests

Model responses are nondeterministic external behavior even at temperature zero. Keep these separate from the ordinary automated test suite.

Track for the curated fixture set:

- Precision per tag category
- Recall for required high-level categories
- Unsupported-tag rate
- Average tags per image
- Mean and percentile inference time
- Peak memory/VRAM observed externally
- Human review time per 100 images

### Foundry tests

- Catalog loading on supported Foundry versions
- Path resolution
- GM and player permissions
- Linked and unlinked tokens
- Actor portrait-only and portrait-plus-token updates
- Large-catalog rendering and filtering

## 18. Operations and Data Safety

- Enable SQLite WAL mode.
- Use database transactions when claiming and completing jobs.
- Back up the database before taxonomy migrations or bulk reprocessing.
- Use atomic replacement when writing `catalog.json`.
- Store structured logs without base64 image data.
- Do not log Open WebUI or proxy credentials.
- Bind the application to loopback by default.
- Require authentication before binding to a LAN interface.
- Keep source-image deletion outside application capabilities for the MVP.

## 19. Risks and Mitigations

### Hallucinated lore or mechanics

**Risk:** The model assigns an exact ancestry, class, deity, or tradition based on ambiguous visual cues.

**Mitigation:** Prefer visual categories, mark interpretations as candidates, retain confidence and evidence, and route uncertain tags to review.

### Taxonomy grows without control

**Risk:** Synonyms and extremely specific concepts become separate tags.

**Mitigation:** Closed vocabulary, aliases, category limits, suggestion review, and versioned governance.

### Model or prompt changes invalidate results

**Risk:** Metadata becomes inconsistent across indexing runs.

**Mitigation:** Persist model, prompt, taxonomy, and algorithm versions; support selective reprocessing; never overwrite human corrections.

### Slow batch processing

**Risk:** Full-resolution input and oversized models make indexing impractical.

**Mitigation:** Benchmark representative images, resize inference copies, default to one worker, and choose the model using measured quality per second.

### Foundry cannot access image paths

**Risk:** Images are stored outside the server's user-data directories or Foundry runs on another machine.

**Mitigation:** Validate paths during export and optionally copy assets into a configured Foundry-served directory.

### Copyright and provenance are lost

**Risk:** A large collection cannot later be audited for source or permitted use.

**Mitigation:** Add optional source URL, creator, license, and notes fields early even if most initially remain empty.

## 20. Decisions to Make Before Implementation

1. Confirm the directories containing the artwork and the approximate image count.
2. Record CPU, system RAM, GPU, and VRAM to choose benchmark models.
3. Decide whether Foundry is local or hosted on another machine.
4. Decide whether images will be copied into Foundry data or maintained in an already served directory.
5. Review taxonomy v1, particularly demographic-presentation categories.
6. Select the evaluation fixture set before tuning the prompt.
7. Decide whether JSON sidecars are required for portability in the first release.

None of these decisions blocks building the scanner, data model, or model-evaluation harness.

## 21. Recommended First Development Slice

Implement a vertical proof of concept before building the full UI:

1. Load a small taxonomy.
2. Accept one image path from the command line.
3. Generate a thumbnail and hashes.
4. Submit the image to Ollama with the structured schema.
5. Validate and normalize the response.
6. Save the image, inference run, and accepted tags to SQLite.
7. Print a human-readable result.
8. Repeat the command and prove it does not duplicate the image or repeat inference unnecessarily.

This slice tests the highest-risk assumptions—vision quality, structured output, taxonomy behavior, and local performance—before significant interface work begins.

## 22. Reference Documentation

- Ollama vision: <https://docs.ollama.com/capabilities/vision>
- Ollama structured outputs: <https://docs.ollama.com/capabilities/structured-outputs>
- Ollama embeddings: <https://docs.ollama.com/capabilities/embeddings>
- Ollama API: <https://docs.ollama.com/api/introduction>
- Open WebUI API endpoints: <https://docs.openwebui.com/reference/api-endpoints/>
- Qwen3-VL model library: <https://ollama.com/library/qwen3-vl>
- Pathfinder Tokens: Character Gallery: <https://foundryvtt.com/packages/pf2e-tokens-characters>
