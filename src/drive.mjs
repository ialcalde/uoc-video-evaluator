/**
 * Google Drive integration — OAuth2 authentication + video discovery + download.
 *
 * First run:
 *   A local HTTP server starts on port 8080 to capture the OAuth2 callback.
 *   The auth URL is printed; open it in a browser, authorise the app, and the
 *   token is saved automatically to .google-token.json.
 *
 * Subsequent runs:
 *   The saved token is reloaded and refreshed silently.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID      — from Google Cloud Console (OAuth2 Desktop client)
 *   GOOGLE_CLIENT_SECRET  — same credentials JSON
 */

import { google }           from 'googleapis';
import { createServer }     from 'http';
import { createWriteStream, existsSync } from 'fs';
import { readFile, writeFile, unlink }   from 'fs/promises';
import { join, extname }    from 'path';
import { fileURLToPath }    from 'url';
import { exec }             from 'child_process';

const __dirname   = fileURLToPath(new URL('.', import.meta.url));
const TOKEN_PATH  = join(__dirname, '..', '.google-token.json');
const OAUTH_PORT  = 8080;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Accepted video MIME types
const VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',          // .mov
  'video/x-matroska',         // .mkv
  'video/x-msvideo',          // .avi
  'video/webm',
  'video/x-ms-wmv',
  'video/mpeg',
];

// ── OAuth2 ────────────────────────────────────────────────────────────────────

function createOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env\n' +
      'Create an OAuth2 "Desktop app" credential at: https://console.cloud.google.com/apis/credentials'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

/**
 * Wait for the OAuth2 callback on a temporary local HTTP server.
 * Returns the authorization code sent by Google.
 */
function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const params = new URL(req.url, REDIRECT_URI).searchParams;
        const code  = params.get('code');
        const error = params.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h2>Authorization denied: ${error}</h2><p>You can close this tab.</p>`);
          server.close();
          reject(new Error(`OAuth2 authorization denied: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<h2 style="color:green">Authorization successful!</h2>' +
            '<p>You can close this tab and return to the terminal.</p>'
          );
          server.close();
          resolve(code);
        }
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(OAUTH_PORT, () => {
      // no-op: URL already printed before this call
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${OAUTH_PORT} is already in use. ` +
          'Stop the process using it and try again.'
        ));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Try to open the URL in the default browser (best-effort).
 */
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32'  ? `start "" "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors — URL is always printed anyway */ });
}

/**
 * Obtain an authenticated OAuth2 client.
 * Loads saved token or runs the interactive auth flow.
 */
export async function authorise(log) {
  const oAuth2 = createOAuth2Client();

  // ── Reuse saved token ─────────────────────────────────────────────────────
  if (existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    oAuth2.setCredentials(saved);

    // Persist refreshed access tokens automatically
    oAuth2.on('tokens', async newTokens => {
      const merged = { ...saved, ...newTokens };
      await writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf8');
    });

    log.info('[Drive] Using saved OAuth2 token.');
    return oAuth2;
  }

  // ── First-time interactive authorisation ──────────────────────────────────
  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope:       SCOPES,
    prompt:      'consent',   // force refresh_token on first grant
  });

  log.info('[Drive] First-time authorisation required.');
  log.info('[Drive] Opening browser…  (if it does not open, visit the URL below)');
  log.info(`\n  ${authUrl}\n`);
  log.info(`[Drive] Waiting for callback on http://localhost:${OAUTH_PORT} …`);

  openBrowser(authUrl);

  const code = await waitForAuthCode();
  const { tokens } = await oAuth2.getToken(code);
  oAuth2.setCredentials(tokens);
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');

  log.ok(`[Drive] Token saved → ${TOKEN_PATH}`);
  return oAuth2;
}

// ── Drive operations ──────────────────────────────────────────────────────────

/**
 * List all video files inside a Drive folder (non-recursive).
 * @param {string} folderId  Google Drive folder ID.
 * @param {object} auth      Authenticated OAuth2 client.
 * @returns {Promise<Array<{id:string, name:string, size:string}>>}
 */
export async function listVideos(folderId, auth) {
  const drive     = google.drive({ version: 'v3', auth });
  const mimeQuery = VIDEO_MIMES.map(m => `mimeType='${m}'`).join(' or ');

  const res = await drive.files.list({
    q: `'${folderId}' in parents and (${mimeQuery}) and trashed=false`,
    fields:                    'files(id,name,size,mimeType)',
    pageSize:                  1000,
    supportsAllDrives:         true,
    includeItemsFromAllDrives: true,
    orderBy:                   'name',
  });

  return res.data.files ?? [];
}

/**
 * Download a single Drive file to destDir.
 * @param {string}   fileId   Drive file ID.
 * @param {string}   fileName Original filename (used for the local copy).
 * @param {string}   destDir  Directory to write the file into.
 * @param {object}   auth     Authenticated OAuth2 client.
 * @param {Function} onProgress  Optional callback: (bytesDownloaded) => void
 * @returns {Promise<string>} Absolute path to the downloaded file.
 */
export async function downloadVideo(fileId, fileName, destDir, auth, onProgress) {
  const drive    = google.drive({ version: 'v3', auth });
  const destPath = join(destDir, fileName);

  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    let bytes = 0;
    const dest = createWriteStream(destPath);

    response.data
      .on('data', chunk => {
        bytes += chunk.length;
        onProgress?.(bytes);
      })
      .on('error', err => {
        dest.destroy();
        unlink(destPath).catch(() => {});
        reject(err);
      })
      .pipe(dest)
      .on('error', err => {
        unlink(destPath).catch(() => {});
        reject(err);
      })
      .on('finish', resolve);
  });

  return destPath;
}
