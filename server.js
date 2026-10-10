const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.speculation': 'application/json'
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (MIME_TYPES[ext]) return MIME_TYPES[ext];
  if (filePath.includes(path.sep + 'api' + path.sep) || filePath.endsWith('translations') || filePath.endsWith('wishes')) {
    return 'application/json; charset=utf-8';
  }
  return 'application/octet-stream';
}

function serveFile(req, res, filePath, explicitMime = null) {
  try {
    const stat = fs.statSync(filePath);
    const mimeType = explicitMime || getMimeType(filePath);

    // Range support for video / audio streaming
    const range = req.headers.range;
    if (range && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*'
      });
      const stream = fs.createReadStream(filePath, { start, end });
      return stream.pipe(res);
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': filePath.includes('_next/static') ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

async function handleNextImage(req, res, reqUrl) {
  const targetUrl = reqUrl.searchParams.get('url');
  if (!targetUrl) {
    const fallbackPath = path.join(ROOT_DIR, '_next', 'image');
    if (fs.existsSync(fallbackPath)) {
      return serveFile(req, res, fallbackPath, 'image/png');
    }
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing url parameter');
  }

  // 0. If local relative path (e.g. /wajah.jpeg, /IMG_3586.JPG.jpeg)
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    const cleanRel = targetUrl.replace(/^\/+/, '');
    const localDirect = path.join(ROOT_DIR, cleanRel);
    if (fs.existsSync(localDirect) && fs.statSync(localDirect).isFile()) {
      return serveFile(req, res, localDirect);
    }
  }

  try {
    const parsed = new URL(targetUrl);
    // 1. Look in _external with colons replaced by underscores
    const localRelColon = path.join(ROOT_DIR, '_external', parsed.hostname, parsed.pathname.replace(/:/g, '_'));
    if (fs.existsSync(localRelColon) && fs.statSync(localRelColon).isFile()) {
      return serveFile(req, res, localRelColon);
    }

    // 2. Look in _external exact pathname
    const localRelExact = path.join(ROOT_DIR, '_external', parsed.hostname, parsed.pathname);
    if (fs.existsSync(localRelExact) && fs.statSync(localRelExact).isFile()) {
      return serveFile(req, res, localRelExact);
    }

    // 3. Look in local .cache directory
    const cachePath = path.join(ROOT_DIR, '.cache', parsed.hostname, parsed.pathname.replace(/[^a-zA-Z0-9._-]/g, '_'));
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).isFile()) {
      return serveFile(req, res, cachePath);
    }

    // 4. Fetch from remote if available
    const remote = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
    if (remote.ok) {
      const buf = Buffer.from(await remote.arrayBuffer());
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, buf);
      const ct = remote.headers.get('content-type') || getMimeType(targetUrl);
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000'
      });
      return res.end(buf);
    }
  } catch (err) {
    // Network unavailable or timeout
  }

  // 5. Fallback placeholder
  const fallback = path.join(ROOT_DIR, '_next', 'image');
  if (fs.existsSync(fallback)) {
    return serveFile(req, res, fallback, 'image/png');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Image Not Found');
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(reqUrl.pathname);

  // Next.js dynamic image handler
  if (pathname === '/_next/image') {
    return handleNextImage(req, res, reqUrl);
  }

  if (req.method === 'POST' && pathname === '/api/diag') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      fs.writeFileSync('diag_result.json', body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // API mock endpoints
  if (pathname.startsWith('/api/')) {
    // Check if matching file exists in api/ directory
    let apiFilePath = path.join(ROOT_DIR, pathname);
    if (fs.existsSync(apiFilePath) && fs.statSync(apiFilePath).isFile()) {
      return serveFile(req, res, apiFilePath, 'application/json; charset=utf-8');
    }

    // Wishes endpoint
    if (pathname.includes('/wishes')) {
      const wishesFile = path.join(ROOT_DIR, 'api', 'v1', 'form', 'undefined', 'wishes');
      if (fs.existsSync(wishesFile)) {
        return serveFile(req, res, wishesFile, 'application/json; charset=utf-8');
      }
    }

    // Translations endpoint
    if (pathname.includes('/translations')) {
      const translationsFile = path.join(ROOT_DIR, '_external', 'global.viding.co', 'api', 'translations');
      if (fs.existsSync(translationsFile)) {
        return serveFile(req, res, translationsFile, 'application/json; charset=utf-8');
      }
    }

    // Default API response
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({ status: 200, success: true, data: [] }));
  }

  // Root or index
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(req, res, path.join(ROOT_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  // Sanitize pathname for static file serving
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const candidateFile = path.join(ROOT_DIR, safePath);

  if (fs.existsSync(candidateFile)) {
    const stat = fs.statSync(candidateFile);
    if (stat.isFile()) {
      return serveFile(req, res, candidateFile);
    } else if (stat.isDirectory()) {
      const indexHtml = path.join(candidateFile, 'index.html');
      if (fs.existsSync(indexHtml)) {
        return serveFile(req, res, indexHtml, 'text/html; charset=utf-8');
      }
    }
  }

  // SPA fallback for Next.js App Router (e.g. /theme/preview/182)
  if (!path.extname(pathname)) {
    return serveFile(req, res, path.join(ROOT_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

function startServer(port) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`  Viding Studio Local Server Started!`);
    console.log(`  Local URL   : http://localhost:${port}`);
    console.log(`  Network URL : http://127.0.0.1:${port}`);
    console.log(`  Direct Theme: http://localhost:${port}/theme/preview/182`);
    console.log(`==================================================\n`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(PORT);
