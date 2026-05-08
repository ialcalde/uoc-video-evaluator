# UOC Video Evaluator — Codebase guide for Claude

## What this project does

Batch-evaluates student video presentations:
1. Extracts audio with **ffmpeg** → `src/audio.mjs`
2. Transcribes with **OpenAI Whisper** → `src/transcribe.mjs`
3. Grades with **Claude** against a rubric → `src/evaluate.mjs`
4. Writes per-student files + CSV → `src/report.mjs`

Entry point: `index.mjs`. CLI parsing: `src/cli.mjs`.

## Key architecture decisions

- **All source modules export pure functions** with injected dependencies (drive client, ffmpeg spawner, API clients). This makes them 100% unit-testable without mocks of the module system.
- **`evaluate.mjs` uses prompt caching** (`cache_control: ephemeral`) on the system prompt and rubric block — these are identical across all students in a batch, saving significant input tokens.
- **Streaming** (`anthropic.messages.stream().finalMessage()`) is used for all Claude calls to avoid HTTP timeouts on long transcripts.
- **Bounded concurrency** via `src/batch.mjs` `runBatch()` — a simple worker-pool that processes N students in parallel.
- **`src/drive.mjs`** exports `waitForAuthCode(port)` and accepts injection params (`waitForCodeFn`, `openBrowserFn`, `_oAuth2`) in `authorise()` so the OAuth2 flow is testable.

## Test suite

```bash
npm test                   # 259 pass, 1 skip (ffmpeg), 0 fail
npm run test:coverage      # 99.2% line / 98.9% branch / 99.0% function
```

Tests use Node's built-in `node:test` + `node:assert/strict`. No Jest, no Mocha, no external test dependencies.

Coverage gaps that are **genuinely irreducible**:
- `drive.mjs` lines 89-91, 105-106 — defensive catch/else inside `waitForAuthCode` that can't be triggered with valid HTTP inputs
- `audio.test.mjs` 57-90 — happy-path test body, skipped because `ffmpeg` is not installed
- `cli.test.mjs` / `drive.test.mjs` — a handful of mutually-exclusive V8 branch pairs in `after()` cleanup hooks
- `openBrowser` darwin/win32 branches — unreachable on Linux CI

## Rubric format

See README.md. Key constraints validated at startup by `validateRubric()`:
- `criteria[].weight` must sum to 1.0 ± 0.01
- `gradingScale` must cover [0, 10] with no gaps > 0.11 and no overlaps > 0.01
- `feedbackLanguage` controls localisation of feedback headings (`"ca"`, `"es"`, `"en"`)

## Commands to know

```bash
node index.mjs --help              # full flag reference
node index.mjs --dry-run           # list videos without calling any API
node index.mjs --rebuild-csv       # regenerate CSV from existing evaluation.json files
node index.mjs --skip-existing     # skip already-evaluated students
node index.mjs --rubric <path>     # use a custom rubric file
node index.mjs --input-dir <path>  # use a custom local video directory
```

## Default paths (all overrideable via flags)

| Resource | Default | Flag |
|---|---|---|
| Input videos | `input_videos/` | `--input-dir` |
| Rubric | `rubric.json` | `--rubric` |
| Output | `output/` | `--output-dir` |
| Temp audio | `tmp/` | — |
| OAuth token | `.google-token.json` | `authorise({tokenPath})` |
