#!/usr/bin/env node
/**
 * Upload a video to YouTube using YouTube Data API v3 (OAuth2 Desktop flow).
 * Zero external npm dependencies — uses built-in Node.js http/https/fs/crypto.
 *
 * Usage:
 *   node scripts/upload-youtube.mjs [videoPath] [--privacy public|unlisted|private]
 *
 * Credentials search order:
 *   1. $YOUTUBE_CLIENT_SECRET_PATH
 *   2. ~/.config/yddd-youtube/client_secret.json
 *   3. ./client_secret.json
 *   4. ~/Downloads/client_secret*.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'yddd-youtube');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');
const LOGIN_HINT = 'ydddmodel@gmail.com';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

const DEFAULT_TITLE = 'How to Model a Bird House in YDDD — Step-by-Step 3D CAD Tutorial';
const DEFAULT_DESCRIPTION = `Step-by-step walkthrough of the "Help → Bird House" interactive tutorial in YDDD, a simple direct-modeling 3D CAD app for Linux.

0:00 Open Help → Bird House Menu
0:02 Step 1/11: Create House Body (Box 2 × 2.5 × 2)
0:06 Step 2/11: Split Roof Ridge (Face Mode + Divide along X)
0:09 Step 3/11: Raise the Roof Peak (Edge Mode + Move up Y)
0:12 Step 4/11: Hollow the Interior (Select bottom face + Hollow 0.2)
0:15 Step 5/11: Create Entrance Cutter Cylinder (R=0.35, H=2, S=16)
0:19 Step 6/11: Rotate & Position Cutter on Front Wall
0:22 Step 7/11: Subtract Entrance Hole (Boolean Subtract '-')
0:25 Step 8/11: Create & Position the Perch Peg
0:28 Step 9/11: Union Perch to House (Boolean Union '+')
0:30 Step 10/11: Smooth Shade (O)
0:32 Step 11/11: Wood Color (P) & 360° + X-Ray Showcase (Shift+X)

GitHub Repository: https://github.com/canoon-gmail/yddd
Built with Electron, TypeScript, Three.js, and OpenCascade (replicad).`;

const DEFAULT_TAGS = [
  'YDDD',
  '3D CAD',
  'Linux CAD',
  '3D Modeling Tutorial',
  'Bird House 3D Model',
  '3D Printing',
  'OpenCascade',
  'Direct Modeling',
];

function findClientSecretFile() {
  const candidates = [];
  if (process.env.YOUTUBE_CLIENT_SECRET_PATH) {
    candidates.push(process.env.YOUTUBE_CLIENT_SECRET_PATH);
  }
  candidates.push(path.join(CONFIG_DIR, 'client_secret.json'));
  candidates.push(path.resolve('client_secret.json'));

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  if (fs.existsSync(downloadsDir)) {
    const files = fs
      .readdirSync(downloadsDir)
      .filter((f) => f.startsWith('client_secret') && f.endsWith('.json'))
      .map((f) => path.join(downloadsDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    candidates.push(...files);
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function loadClientCredentials(secretPath) {
  const raw = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  const block = raw.installed || raw.web;
  if (!block || !block.client_id || !block.client_secret) {
    throw new Error(`Invalid client_secret JSON in ${secretPath}. Expected "installed" or "web" OAuth client.`);
  }
  return {
    clientId: block.client_id,
    clientSecret: block.client_secret,
    tokenUri: block.token_uri || 'https://oauth2.googleapis.com/token',
    authUri: block.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
  };
}

function httpsRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function exchangeCodeForToken(creds, code, redirectUri) {
  const params = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await httpsRequest(
    creds.tokenUri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
    params.toString()
  );
  if (res.status !== 200) {
    throw new Error(`Token exchange failed (${res.status}): ${res.text}`);
  }
  return JSON.parse(res.text);
}

async function refreshAccessToken(creds, refreshToken) {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await httpsRequest(
    creds.tokenUri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
    params.toString()
  );
  if (res.status !== 200) {
    throw new Error(`Token refresh failed (${res.status}): ${res.text}`);
  }
  return JSON.parse(res.text);
}

async function authorizeInteractive(creds) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const authUrl = new URL(creds.authUri);
      authUrl.searchParams.set('client_id', creds.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES.join(' '));
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('login_hint', LOGIN_HINT);

      console.log(`\nOpening browser for Google OAuth (${LOGIN_HINT})...`);
      console.log(`If it does not open automatically, visit:\n  ${authUrl.toString()}\n`);

      execFile('xdg-open', [authUrl.toString()], () => {});

      server.on('request', async (req, res) => {
        try {
          const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
          if (reqUrl.pathname !== '/oauth2callback') {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const code = reqUrl.searchParams.get('code');
          const err = reqUrl.searchParams.get('error');
          if (err || !code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>Authorization failed: ${err || 'missing code'}</h2>`);
            server.close();
            reject(new Error(`OAuth error: ${err || 'missing code'}`));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>YDDD YouTube authorization succeeded! You can close this tab and return to the terminal.</h2>');
          server.close();

          const tokenData = await exchangeCodeForToken(creds, code, redirectUri);
          tokenData.expiry_date = Date.now() + (tokenData.expires_in || 3600) * 1000;
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
          resolve(tokenData.access_token);
        } catch (e) {
          server.close();
          reject(e);
        }
      });
    });
  });
}

async function getAccessToken(creds) {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      if (saved.access_token && saved.expiry_date && saved.expiry_date > Date.now() + 60_000) {
        return saved.access_token;
      }
      if (saved.refresh_token) {
        const refreshed = await refreshAccessToken(creds, saved.refresh_token);
        const merged = {
          ...saved,
          ...refreshed,
          expiry_date: Date.now() + (refreshed.expires_in || 3600) * 1000,
        };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
        return merged.access_token;
      }
    } catch (e) {
      console.warn('Saved token invalid or expired, re-authenticating...', e.message);
    }
  }
  return authorizeInteractive(creds);
}

async function initiateResumableUpload(accessToken, metadata, fileSize) {
  const initUrl =
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
  const body = JSON.stringify(metadata);
  const res = await httpsRequest(
    initUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Upload-Content-Length': String(fileSize),
        'X-Upload-Content-Type': 'video/mp4',
      },
    },
    body
  );

  if (res.status !== 200 || !res.headers.location) {
    throw new Error(`Failed to initiate YouTube resumable upload (${res.status}): ${res.text}`);
  }
  return res.headers.location;
}

function uploadVideoStream(uploadUrl, filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(fileSize),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve(JSON.parse(text));
          } else {
            reject(new Error(`Video upload failed (${res.statusCode}): ${text}`));
          }
        });
      }
    );
    req.on('error', reject);

    const stream = fs.createReadStream(filePath);
    let uploaded = 0;
    stream.on('data', (chunk) => {
      uploaded += chunk.length;
      const pct = ((uploaded / fileSize) * 100).toFixed(1);
      process.stdout.write(`\rUploading: ${pct}% (${(uploaded / 1024 / 1024).toFixed(2)} / ${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
    });
    stream.on('end', () => process.stdout.write('\n'));
    stream.pipe(req);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let videoPath = path.resolve('birdhouse-tutorial.mp4');
  let privacyStatus = 'public';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--privacy' && args[i + 1]) {
      privacyStatus = args[++i];
    } else if (!args[i].startsWith('--')) {
      videoPath = path.resolve(args[i]);
    }
  }

  if (!fs.existsSync(videoPath)) {
    console.error(`Error: Video file not found at ${videoPath}`);
    process.exit(1);
  }

  const secretPath = findClientSecretFile();
  if (!secretPath) {
    console.error(`
================================================================================
Missing Google OAuth Desktop Client Secret (client_secret.json)
================================================================================
To upload automatically to YouTube (${LOGIN_HINT}) via the API:

1. Open Google Cloud Console (signed in as ${LOGIN_HINT}):
   https://console.cloud.google.com/apis/library/youtube.googleapis.com
   -> Click "Enable" on YouTube Data API v3.

2. Configure OAuth Consent Screen (if not already done):
   https://console.cloud.google.com/apis/credentials/consent
   -> Add "${LOGIN_HINT}" under "Test users".

3. Create OAuth 2.0 Desktop Client ID:
   https://console.cloud.google.com/apis/credentials
   -> Click "+ CREATE CREDENTIALS" -> "OAuth client ID"
   -> Application type: "Desktop app"
   -> Click "DOWNLOAD JSON" (saves to ~/Downloads/client_secret_....json)

Once downloaded to ~/Downloads (or saved as ${path.join(CONFIG_DIR, 'client_secret.json')}),
re-run:
   node scripts/upload-youtube.mjs
================================================================================
`);
    process.exit(2);
  }

  console.log(`Using OAuth client secret: ${secretPath}`);
  const creds = loadClientCredentials(secretPath);
  const accessToken = await getAccessToken(creds);

  const fileSize = fs.statSync(videoPath).size;
  const metadata = {
    snippet: {
      title: DEFAULT_TITLE,
      description: DEFAULT_DESCRIPTION,
      tags: DEFAULT_TAGS,
      categoryId: '28', // Science & Technology
      defaultLanguage: 'en',
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  console.log(`Initiating YouTube upload for: ${videoPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB, privacy=${privacyStatus})...`);
  const uploadUrl = await initiateResumableUpload(accessToken, metadata, fileSize);
  const result = await uploadVideoStream(uploadUrl, videoPath, fileSize);

  console.log('\nUpload complete!');
  console.log(`  Video ID : ${result.id}`);
  console.log(`  Watch URL: https://youtu.be/${result.id}`);
  console.log(`  Studio   : https://studio.youtube.com/video/${result.id}/edit`);
}

main().catch((err) => {
  console.error('\nError:', err.message || err);
  process.exit(1);
});
