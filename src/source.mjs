import { readdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { basename, extname, join } from 'path';
import { listVideos, downloadVideo } from './drive.mjs';

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

/**
 * Download all videos from a Google Drive folder into tmpDir.
 * Returns entries with cleanup functions that delete the temp files.
 *
 * @param {string} folderId
 * @param {object} drive          google.drive v3 client
 * @param {object} opts
 * @param {string} opts.tmpDir
 * @param {object} [opts.log]
 * @param {Function} [opts.listVideosFn]
 * @param {Function} [opts.downloadVideoFn]
 * @returns {Promise<Array<{videoPath: string, student: string, cleanup: Function}>>}
 */
export async function collectDriveVideos(folderId, drive, {
  tmpDir,
  log = { info: () => {}, ok: () => {}, warn: () => {}, sep: () => {} },
  listVideosFn    = listVideos,
  downloadVideoFn = downloadVideo,
} = {}) {
  log.info(`[Drive] Listing videos in folder: ${folderId}`);
  const files = await listVideosFn(folderId, drive);

  if (files.length === 0) {
    log.warn('[Drive] No video files found in the specified folder.');
    return [];
  }

  log.info(`[Drive] Found ${files.length} video(s). Downloading to tmp/…`);
  log.sep();

  const entries = [];

  for (const file of files) {
    const student  = basename(file.name, extname(file.name));
    const destPath = join(tmpDir, file.name);
    const sizeMB   = file.size ? (Number(file.size) / 1_048_576).toFixed(1) : '?';

    log.info(`[Drive] Downloading "${file.name}" (${sizeMB} MB)…`);

    let lastLogged = 0;
    await downloadVideoFn(file.id, file.name, tmpDir, drive, bytes => {
      const mb = bytes / 1_048_576;
      if (mb - lastLogged >= 10) {
        log.info(`[Drive]   … ${mb.toFixed(0)} MB received`);
        lastLogged = mb;
      }
    });

    log.ok(`[Drive] "${file.name}" ready.`);

    entries.push({
      videoPath: destPath,
      student,
      cleanup: async () => {
        try { await unlink(destPath); } catch { /* already gone */ }
      },
    });
  }

  log.sep();
  return entries;
}
