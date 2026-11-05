'use strict';
// server.js — 职场嘴替 (工作版) 本地 HTTP 服务 (零依赖, node:http)
// 运行: node src/server.js  (PORT 环境变量, 默认 8788)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getConfig, analyzeWithLLM, analyzeImageWithLLM } = require('./llm');

const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        tooLarge = true;
        // continue draining but discard
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('payload_too_large');
        err.code = 'payload_too_large';
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req, res, limitBytes) {
  let raw;
  try {
    raw = await readBody(req, limitBytes);
  } catch (e) {
    if (e && e.code === 'payload_too_large') {
      sendJson(res, 413, { error: 'payload_too_large', message: '请求体过大' });
      return null;
    }
    sendJson(res, 400, { error: 'bad_json', message: '请求体读取失败' });
    return null;
  }
  if (!raw || !raw.trim()) {
    sendJson(res, 400, { error: 'bad_json', message: '请求体不能为空，需要 JSON' });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    sendJson(res, 400, { error: 'bad_json', message: '请求体不是合法 JSON' });
    return null;
  }
}

function serveStatic(req, res, pathname) {
  // pathname is decoded URL path
  let rel;
  if (pathname === '/' || pathname === '') {
    rel = 'index.html';
  } else if (pathname.startsWith('/web/')) {
    rel = pathname.slice('/web/'.length);
  } else {
    sendJson(res, 404, { error: 'not_found', message: 'Not found' });
    return;
  }

  if (!rel) {
    sendJson(res, 404, { error: 'not_found', message: 'Not found' });
    return;
  }

  // Prevent path traversal: normalize and confine to WEB_DIR
  const normalized = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
  // Also reject absolute paths
  if (path.isAbsolute(normalized)) {
    sendJson(res, 403, { error: 'forbidden', message: 'Forbidden' });
    return;
  }
  const filePath = path.join(WEB_DIR, normalized);
  const resolvedWeb = path.resolve(WEB_DIR);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedWeb && !resolvedFile.startsWith(resolvedWeb + path.sep)) {
    sendJson(res, 403, { error: 'forbidden', message: 'Forbidden' });
    return;
  }

  fs.readFile(resolvedFile, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        sendJson(res, 404, { error: 'not_found', message: 'Not found' });
      } else {
        sendJson(res, 500, { error: 'internal_error', message: 'Failed to read file' });
      }
      return;
    }
    const ext = path.extname(resolvedFile).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(data);
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    let pathname = '/';
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch (_) {
      pathname = req.url || '/';
    }
    const method = req.method || 'GET';

    // Log one line per request on finish
    res.on('finish', () => {
      console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - start}ms`);
    });

    try {
      // Health
      if (pathname === '/api/health') {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
          return;
        }
        const cfg = getConfig();
        sendJson(res, 200, {
          ok: true,
          llmConfigured: !!cfg.configured,
          model: cfg.configured ? cfg.model : null,
        });
        return;
      }

      // Analyze text
      if (pathname === '/api/analyze') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
          return;
        }
        const body = await parseJsonBody(req, res, 2 * 1024 * 1024);
        if (body === null) return; // response already sent
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) {
          sendJson(res, 400, { error: 'text_required', message: 'text 必填：把对方发来的消息粘进来' });
          return;
        }
        const input = {
          text: text.trim(),
          relation: body.relation,
          intent: body.intent,
          hour: typeof body.hour === 'number' ? body.hour : undefined,
        };
        try {
          const result = await analyzeWithLLM(input);
          sendJson(res, 200, result);
        } catch (e) {
          // analyzeWithLLM should not throw for text, but be safe
          sendJson(res, 500, { error: 'internal_error', message: (e && e.message) || 'Internal error' });
        }
        return;
      }

      // Analyze image
      if (pathname === '/api/image') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
          return;
        }
        const body = await parseJsonBody(req, res, 8 * 1024 * 1024);
        if (body === null) return;
        let imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
        // Tolerate data URL prefix if client sent it
        if (imageBase64.startsWith('data:')) {
          const comma = imageBase64.indexOf(',');
          if (comma >= 0) imageBase64 = imageBase64.slice(comma + 1);
        }
        if (!imageBase64.trim()) {
          sendJson(res, 400, { error: 'image_required', message: 'imageBase64 必填：请上传截图' });
          return;
        }
        const mime = typeof body.mime === 'string' && body.mime ? body.mime : 'image/png';
        const opts = {
          relation: body.relation,
          intent: body.intent,
          hour: typeof body.hour === 'number' ? body.hour : undefined,
        };
        try {
          const result = await analyzeImageWithLLM(imageBase64, mime, opts);
          if (result && result.error) {
            sendJson(res, 422, { error: result.error, message: result.message || result.error });
            return;
          }
          sendJson(res, 200, result);
        } catch (e) {
          sendJson(res, 500, { error: 'internal_error', message: (e && e.message) || 'Internal error' });
        }
        return;
      }

      // API 404
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not_found', message: 'Not found' });
        return;
      }

      // Static
      if (method === 'GET') {
        serveStatic(req, res, pathname);
        return;
      }

      sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', message: (e && e.message) || 'Internal error' });
      } else {
        try { res.end(); } catch (_) {}
      }
    }
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8788);
  const server = createServer();
  server.listen(port, () => {
    console.log(`职场嘴替 server listening on http://localhost:${port}`);
  });
}

module.exports = { createServer };
