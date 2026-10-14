/**
 * Minimal Google Cloud Storage client (JSON API, no extra dependencies).
 * On Cloud Run the access token comes from the metadata server (the service's own account).
 * GCS_ENDPOINT can point at a local emulator for tests; then no token is sent.
 */
const config = require('./config');

const ENDPOINT = (process.env.GCS_ENDPOINT || 'https://storage.googleapis.com').replace(/\/$/, '');
const EMULATED = !/^https:\/\/storage\.googleapis\.com$/.test(ENDPOINT);
const META_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let cached = { token: null, expires: 0 };

async function authHeader() {
  if (EMULATED) return {};
  if (process.env.GCS_ACCESS_TOKEN) return { Authorization: `Bearer ${process.env.GCS_ACCESS_TOKEN}` };
  if (cached.token && cached.expires > Date.now() + 60_000) return { Authorization: `Bearer ${cached.token}` };
  const res = await fetch(META_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`GCS: could not get access token from metadata server (${res.status})`);
  const body = await res.json();
  cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return { Authorization: `Bearer ${cached.token}` };
}

const enc = encodeURIComponent;
const objectUrl = (name) => `${ENDPOINT}/storage/v1/b/${enc(config.GCS_BUCKET)}/o/${enc(name)}`;

async function request(url, opts = {}, okMissing = false) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(await authHeader()) } });
    if (res.ok) return res;
    if (okMissing && res.status === 404) return null;
    // Retry rate limits / transient server errors a couple of times.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    throw new Error(`GCS ${opts.method || 'GET'} ${url.replace(ENDPOINT, '')} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/** Upload bytes. Returns the new object generation. */
async function upload(name, data, contentType = 'application/octet-stream') {
  const url = `${ENDPOINT}/upload/storage/v1/b/${enc(config.GCS_BUCKET)}/o?uploadType=media&name=${enc(name)}`;
  const res = await request(url, { method: 'POST', body: data, headers: { 'Content-Type': contentType } });
  return (await res.json()).generation;
}

/** Download an object. Returns { data: Buffer, contentType, generation } or null if missing. */
async function download(name) {
  const res = await request(`${objectUrl(name)}?alt=media`, {}, true);
  if (!res) return null;
  return {
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    generation: res.headers.get('x-goog-generation'),
  };
}

/** Object metadata (generation, size) or null if missing. */
async function stat(name) {
  const res = await request(objectUrl(name), {}, true);
  return res ? res.json() : null;
}

async function remove(name) {
  await request(objectUrl(name), { method: 'DELETE' }, true);
}

module.exports = { upload, download, stat, remove };
