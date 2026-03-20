const http = require('http');
const https = require('https');
const url = require('url');
const { Client } = require('pg');

const PORT = process.env.PORT || 3002;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'obchod@pierre-design.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// PostgreSQL
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
db.connect().then(async () => {
  console.log('[DB] Připojeno k PostgreSQL');
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_notes (
      order_id TEXT PRIMARY KEY,
      note TEXT DEFAULT '',
      tracking_code TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[DB] Tabulka order_notes připravena');
}).catch(e => console.error('[DB] Chyba připojení:', e.message));

// ── HELPERS ────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}

function proxyRequest(targetUrl, authHeader, method, body, res) {
  const parsed = url.parse(targetUrl);
  const bodyBuffer = body ? Buffer.from(body, 'utf8') : null;
  const options = {
    hostname: parsed.hostname, port: parsed.port || 443, path: parsed.path, method: method || 'GET',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' }
  };
  if (bodyBuffer) options.headers['Content-Length'] = bodyBuffer.length;
  const protocol = parsed.protocol === 'https:' ? https : http;
  const proxyReq = protocol.request(options, proxyRes => {
    let data = ''; proxyRes.on('data', c => data += c);
    proxyRes.on('end', () => { res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' }); res.end(data); });
  });
  proxyReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  if (bodyBuffer) proxyReq.write(bodyBuffer);
  proxyReq.end();
}

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); });
}

function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── EMAIL ──────────────────────────────
async function sendEmail(order) {
  if (!RESEND_API_KEY) return;
  const name = ((order.firstname_invoice||'') + ' ' + (order.surname_invoice||'')).trim() || (order.customer?.email) || '–';
  const price = order.order_total ? Number(order.order_total).toLocaleString('cs-CZ') + ' Kč' : '–';
  const email = order.customer?.email || '–';
  const phone = order.customer?.phone || '–';
  let itemsHtml = (order.products||[]).map(p => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #f0ebe3;">${p.title||p.name||'–'}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0ebe3;text-align:center;">${p.count||p.quantity||1} ks</td>
  </tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">
    <div style="background:#1A1714;padding:24px;border-radius:12px 12px 0 0;">
      <div style="font-size:20px;color:#fff;">Pierre <em style="color:#E8C98A;">Design</em> – Nová objednávka</div>
    </div>
    <div style="background:#fff;padding:24px;border:1px solid #f0ebe3;">
      <h2 style="margin:0 0 16px;">#${order.order_number||order.order_id}</h2>
      <p><b>Zákazník:</b> ${name}</p><p><b>E-mail:</b> ${email}</p>
      <p><b>Telefon:</b> ${phone}</p><p><b>Celkem:</b> ${price}</p>
      ${itemsHtml ? `<table style="width:100%;border-collapse:collapse;margin-top:16px;">${itemsHtml}</table>` : ''}
    </div>
  </div>`;
  try {
    await httpsPost('api.resend.com', '/emails', {
      'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json'
    }, JSON.stringify({ from: 'Pierre Design <notifikace@pierre-design.com>', to: [NOTIFY_EMAIL],
      subject: '🏺 Nová objednávka #' + (order.order_number||order.order_id) + ' – ' + price, html }));
  } catch(e) { console.error('[EMAIL] Chyba:', e.message); }
}

// ── NOTIFIER ───────────────────────────
let lastKnownOrderId = null;
let notifierReady = false;
let notifierLogin = '', notifierKey = '', notifierUrl = '';

async function fetchLatestOrder() {
  if (!notifierLogin || !notifierKey || !notifierUrl) return null;
  const base = notifierUrl.replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(notifierLogin + ':' + notifierKey).toString('base64');
  return new Promise(resolve => {
    const parsed = url.parse(base + '/orders?page=1');
    const req = https.request({ hostname: parsed.hostname, path: parsed.path, method: 'GET',
      headers: { 'Authorization': auth, 'Accept': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const orders = (json.orders||[]).sort((a,b) => new Date(b.creation_time) - new Date(a.creation_time));
          resolve(orders[0]||null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

async function checkForNewOrders() {
  if (!notifierReady) return;
  const latest = await fetchLatestOrder();
  if (!latest) return;
  const latestId = String(latest.order_number || latest.order_id);
  if (lastKnownOrderId === null) { lastKnownOrderId = latestId; return; }
  if (latestId !== lastKnownOrderId) {
    console.log('[NOTIFIER] Nová objednávka #' + latestId);
    lastKnownOrderId = latestId;
    await sendEmail(latest);
  }
}

// ── HTTP SERVER ────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const parsed = url.parse(req.url, true);

  // Health
  if (parsed.pathname === '/health') {
    return jsonRes(res, 200, { status: 'ok', service: 'Pierre Design Proxy', notifier: notifierReady });
  }

  // Activate notifier
  if (parsed.pathname === '/activate' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { login, key, apiUrl } = JSON.parse(body);
      if (login && key && apiUrl) {
        notifierLogin = login; notifierKey = key; notifierUrl = apiUrl;
        notifierReady = true; lastKnownOrderId = null;
        return jsonRes(res, 200, { ok: true });
      }
    } catch(e) {}
    return jsonRes(res, 400, { error: 'Chybí údaje' });
  }

  // GET notes for all orders
  if (parsed.pathname === '/notes' && req.method === 'GET') {
    try {
      const result = await db.query('SELECT order_id, note, tracking_code FROM order_notes');
      const notes = {};
      result.rows.forEach(r => { notes[r.order_id] = { note: r.note, tracking_code: r.tracking_code }; });
      return jsonRes(res, 200, notes);
    } catch(e) { return jsonRes(res, 500, { error: e.message }); }
  }

  // Save note + tracking code
  if (parsed.pathname === '/notes' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { order_id, note, tracking_code } = JSON.parse(body);
      if (!order_id) return jsonRes(res, 400, { error: 'Chybí order_id' });
      await db.query(`
        INSERT INTO order_notes (order_id, note, tracking_code, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (order_id) DO UPDATE SET note=$2, tracking_code=$3, updated_at=NOW()
      `, [String(order_id), note||'', tracking_code||'']);
      return jsonRes(res, 200, { ok: true });
    } catch(e) { return jsonRes(res, 500, { error: e.message }); }
  }

  // Proxy GET
  if (parsed.pathname === '/proxy' && req.method === 'GET') {
    const targetUrl = parsed.query.url, authHeader = parsed.query.auth;
    if (!targetUrl || !authHeader) return jsonRes(res, 400, { error: 'Chybí parametry' });
    return proxyRequest(decodeURIComponent(targetUrl), decodeURIComponent(authHeader), 'GET', null, res);
  }

  // Proxy POST
  if (parsed.pathname === '/proxy' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { targetUrl, auth, method, data } = JSON.parse(body);
      if (!targetUrl || !auth) return jsonRes(res, 400, { error: 'Chybí parametry' });
      return proxyRequest(targetUrl, auth, method||'PUT', JSON.stringify(data), res);
    } catch(e) { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  }

  jsonRes(res, 404, { error: 'Nenalezeno' });
});

server.listen(PORT, () => {
  console.log('Pierre Design Proxy běží na portu ' + PORT);
  setInterval(checkForNewOrders, 15 * 60 * 1000);
});
