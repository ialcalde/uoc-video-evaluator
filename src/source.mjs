import { readdirSync } from 'fs';
import { basename, extname, join } from 'path';

export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);

/**
 * Collect all video files from a local directory.
 * Returns entries sorted alphabetically by filename.
 *
 * @param {string} inputDir  Directory to scan.
 * @returns {Array<{videoPath: string, student: string, cleanup: null}>}
 */
export function collectLocalVideos(inputDir) {
  const files = readdirSync(inputDir)
    .filter(f => VIDEO_EXTS.has(extname(f).toLowerCase()))
    .sort();

  return files.map(f => ({
    videoPath: join(inputDir, f),
    student:   basename(f, extname(f)),
    cleanup:   null,
  }));
}
