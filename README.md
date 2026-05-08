# UOC Video Evaluator

Automatically evaluates student video presentations against a rubric using **Claude** (grading) and **OpenAI Whisper** (transcription). Outputs per-student feedback files and a consolidated CSV report.

## Requirements

- Node.js ≥ 20
- [ffmpeg](https://ffmpeg.org/download.html) — audio extraction (`sudo apt-get install ffmpeg` / `brew install ffmpeg`)
- Anthropic API key
- OpenAI API key
- _(Optional)_ Google OAuth2 credentials — only needed for the `--drive-folder` feature

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in your API keys
cp .env.example .env
$EDITOR .env

# 3. Drop student video files into input_videos/
#    Accepted formats: .mp4  .mov  .mkv  .avi  .webm  .wmv
#    File name = student identifier (e.g. pau_garcia.mp4)

# 4. Run
node index.mjs
```

Results are written to `output/<student>/`:
- `transcript_ca.txt` — Whisper transcript
- `evaluation.json` — structured scores per criterion
- `feedback_ca.txt` — human-readable feedback letter
- `output/results.csv` — summary of all students

## CLI options

```
--drive-folder <id>   Read videos from Google Drive (overrides GOOGLE_DRIVE_FOLDER_ID)
--input-dir <path>    Local video directory (default: input_videos/)
--rubric <path>       Rubric JSON file (default: rubric.json in project root)
--model <id>          Claude model (default: claude-opus-4-7, overrides ANTHROPIC_MODEL)
--skip-existing       Skip students whose evaluation.json already exists
--concurrency <n>     Parallel processing limit (default: 3)
--output-dir <path>   Output directory (default: output/)
--dry-run             List videos found without calling any API
--rebuild-csv         Regenerate results.csv from existing evaluation.json files
--thinking            Enable adaptive thinking for deeper reasoning
--version             Print version and exit
--help, -h            Show this help message
```

### Examples

```bash
# Process everything in input_videos/ with defaults
node index.mjs

# Custom paths (useful when running multiple courses)
node index.mjs \
  --rubric ~/rubrics/advanced-presentation.json \
  --input-dir /media/usb/course-a \
  --output-dir ~/results/course-a

# Google Drive source
node index.mjs --drive-folder 1AbCdEfGhIjKlMnOpQrStUvWxYz

# Re-process only students not yet evaluated, 5 at a time
node index.mjs --skip-existing --concurrency 5

# Regenerate CSV after a partial run without re-calling any API
node index.mjs --rebuild-csv
```

## Rubric format

The rubric is a JSON file with the following structure:

```jsonc
{
  "title": "UOC Video Presentation",
  "language": "ca",           // Whisper transcription language (BCP-47)
  "feedbackLanguage": "ca",   // Language for Claude's justifications and feedback
  "criteria": [
    {
      "id": "content_accuracy",
      "name": "Contingut i precisió",   // name shown in feedback (any language)
      "nameEn": "Content & Accuracy",   // English name (used internally)
      "weight": 0.30,                   // must sum to 1.0 across all criteria
      "description": "...",
      "levels": [
        { "score": 10, "label": "Excel·lent", "description": "..." },
        { "score": 7,  "label": "Notable",    "description": "..." },
        { "score": 5,  "label": "Aprovat",    "description": "..." },
        { "score": 0,  "label": "Suspès",     "description": "..." }
      ]
    }
    // ... more criteria
  ],
  "gradingScale": [
    { "min": 9.0, "max": 10.0, "label": "Excel·lent (A)" },
    { "min": 7.0, "max":  8.9, "label": "Notable (B)"    },
    { "min": 5.0, "max":  6.9, "label": "Aprovat (C)"    },
    { "min": 0.0, "max":  4.9, "label": "Suspès (D)"     }
  ]
}
```

`feedbackLanguage` supports `"ca"` (Catalan), `"es"` (Spanish), and `"en"` (English). Structural labels in the feedback file are localised automatically; other codes fall back to English.

## Google Drive setup

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth2 client → Application type: **Desktop app**
3. Copy `client_id` and `client_secret` to `.env`
4. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
5. On first run the browser opens for authorisation; the token is saved to `.google-token.json`

## Running tests

```bash
npm test                   # run all tests
npm run test:coverage      # with line/branch/function coverage report
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `OPENAI_API_KEY` | Yes | OpenAI API key (Whisper) |
| `GOOGLE_CLIENT_ID` | Drive only | OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Drive only | OAuth2 client secret |
| `GOOGLE_DRIVE_FOLDER_ID` | Optional | Default Drive folder (overridden by `--drive-folder`) |
| `ANTHROPIC_MODEL` | Optional | Claude model override (overridden by `--model`) |
