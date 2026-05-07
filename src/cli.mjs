/**
 * CLI argument parsing — extracted for testability.
 */

const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
 *
 * @param {string[]} argv  Typically process.argv.
 * @returns {{ driveFolderId: string|null, model: string, skipExisting: boolean,
 *             concurrency: number, outputDir: string|null, dryRun: boolean }}
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};

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
    }
  }

  // Env-var fallback and defaults
  opts.driveFolderId ??= process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  opts.model         ??= process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  opts.skipExisting  ??= false;
  opts.concurrency   ??= 3;
  opts.outputDir     ??= null;   // null → use the default output/ path in index.mjs
  opts.dryRun        ??= false;

  return opts;
}
