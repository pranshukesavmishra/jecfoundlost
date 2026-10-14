// Tiny in-memory stand-in for the Google Cloud Storage JSON API (only what src/gcs.js uses).
const http = require('http');

function fakeGcs() {
  const objects = new Map(); // "bucket/name" -> { data, contentType, generation }
  let gen = 1000;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/))) {
      const key = `${decodeURIComponent(m[1])}/${url.searchParams.get('name')}`;
      const obj = { data: body, contentType: req.headers['content-type'], generation: String(++gen) };
      objects.set(key, obj);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: url.searchParams.get('name'), generation: obj.generation, size: String(body.length) }));
    }
    if ((m = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/))) {
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      const obj = objects.get(key);
      if (req.method === 'DELETE') {
        if (!obj) { res.statusCode = 404; return res.end('not found'); }
        objects.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      if (!obj) { res.statusCode = 404; return res.end('{"error":{"code":404}}'); }
      if (url.searchParams.get('alt') === 'media') {
        res.setHeader('content-type', obj.contentType);
        res.setHeader('x-goog-generation', obj.generation);
        return res.end(obj.data);
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ generation: obj.generation, size: String(obj.data.length) }));
    }
    res.statusCode = 400;
    res.end('unsupported');
  });
  return { server, objects };
}

module.exports = { fakeGcs };
