/**
 * CLI argument parsing — extracted for testability.
 */

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export const USAGE = `
UOC Video Evaluator

Evaluate student video presentations against a rubric using Claude AI.

Usage:
  node index.mjs [options]

Options:
  --drive-folder <id>   Read videos from Google Drive (overrides GOOGLE_DRIVE_FOLDER_ID).
  --model <id>          Claude model to use (default: ${DEFAULT_MODEL}, overrides ANTHROPIC_MODEL).
  --skip-existing       Skip students whose evaluation.json already exists.
  --concurrency <n>     Process up to N students in parallel (default: 3).
  --output-dir <path>   Write results to a custom directory (default: output/).
  --dry-run             List found videos without calling any API.
  --rebuild-csv         Regenerate results.csv from existing evaluation.json files (no API calls).
  --thinking            Enable adaptive thinking for deeper reasoning (needs claude-opus-4-7).
  --version             Print the package version and exit.
  --help, -h            Show this help message.

Environment variables:
  ANTHROPIC_API_KEY       Required. Your Anthropic API key.
  OPENAI_API_KEY          Required. Your OpenAI API key (Whisper transcription).
  GOOGLE_DRIVE_FOLDER_ID  Optional. Google Drive folder ID (can also use --drive-folder).
  ANTHROPIC_MODEL         Optional. Claude model override (can also use --model).

Examples:
  node index.mjs
  node index.mjs --drive-folder 1AbCdEfGhIjKlMnOpQrStUvWxYz
  node index.mjs --skip-existing --concurrency 5
  node index.mjs --model claude-opus-4-7 --dry-run
`.trim();

/**
 * Parse process.argv (or a custom array) into an options object.
 *
 * Supported flags:
 *   --drive-folder <id>   Google Drive folder ID (overrides GOOGLE_DRIVE_FOLDER_ID).
 *   --model <id>          Claude model to use (overrides ANTHROPIC_MODEL, default claude-sonnet-4-6).
 *   --skip-existing       Skip students with an existing evaluation.json.
 *   --concurrency <n>     Max parallel video processing tasks (default 3).
 *   --output-dir <path>   Custom output directory (default: output/).
 *   --dry-run             List what would be processed, without calling any API.
 *   --rebuild-csv         Regenerate CSV from existing evaluation.json files, then exit.
 *   --thinking            Enable adaptive thinking for the Claude evaluation call.
 *   --help, -h            Print usage and exit.
 *
 * @param {string[]} argv         Typically process.argv.
 * @param {Function} [onUnknown]  Called with each unrecognised flag string (default: console.warn).
 * @returns {{ driveFolderId: string|null, model: string, skipExisting: boolean,
 *             concurrency: number, outputDir: string|null, dryRun: boolean,
 *             rebuildCsv: boolean, thinking: boolean, help: boolean }}
 */
export function parseArgs(argv, onUnknown = flag => console.warn(`[WARN]  Unknown flag: ${flag}`)) {
  const args = argv.slice(2);
  const opts = {};

  // Flags that consume the next argument as their value
  const VALUE_FLAGS = new Set(['--drive-folder', '--model', '--concurrency', '--output-dir']);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--drive-folder' && args[i + 1]) {
      opts.driveFolderId = args[++i];
    } else if (args[i] === '--model' && args[i + 1]) {
      opts.model = args[++i];
    } else if (args[i] === '--skip-existing') {
      opts.skipExisting = true;
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      opts.concurrency = Math.max(1, parseInt(args[++i], 10) || 1);
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      opts.outputDir = args[++i];
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--rebuild-csv') {
      opts.rebuildCsv = true;
    } else if (args[i] === '--version') {
      opts.version = true;
    } else if (args[i] === '--thinking') {
      opts.thinking = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      opts.help = true;
    } else if (args[i].startsWith('-')) {
      onUnknown(args[i]);
    }
  }

  // Env-var fallback and defaults
  opts.driveFolderId ??= process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  opts.model         ??= process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  opts.skipExisting  ??= false;
  opts.concurrency   ??= 3;
  opts.outputDir     ??= null;   // null → use the default output/ path in index.mjs
  opts.dryRun        ??= false;
  opts.rebuildCsv    ??= false;
  opts.version       ??= false;
  opts.thinking      ??= false;
  opts.help          ??= false;

  return opts;
}
