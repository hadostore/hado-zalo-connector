// HTTP server: endpoint MCP cho Claude, trang cấp quyền OA, và nhận webhook từ Zalo.
import express from 'express';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { buildAuthUrl, exchangeCode, tokenStatus, verifyWebhook } from './zalo.js';
import { addEvent } from './events.js';
import { storeKind } from './store.js';

const required = ['ZALO_APP_ID', 'ZALO_APP_SECRET', 'PUBLIC_BASE_URL', 'MCP_SECRET', 'ADMIN_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Thiếu biến môi trường: ${missing.join(', ')} (xem .env.example)`);
  process.exit(1);
}
const BASE = process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
const REDIRECT = `${BASE}/oauth/callback`;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.disable('x-powered-by');

// Xác thực domain với Zalo: dán mã Zalo cấp vào ZALO_VERIFY_CODE.
const VERIFY = process.env.ZALO_VERIFY_CODE || '';
const verifyHtml = `<!doctype html><html><head><meta charset="utf-8"><meta property="zalo-platform-site-verification" content="${VERIFY}" /></head><body>HADO Zalo OA connector đang chạy.</body></html>`;
app.get('/', (_req, res) => res.type('html').send(verifyHtml));
if (VERIFY) app.get(`/zalo_verifier${VERIFY}.html`, (_req, res) => res.type('html').send(verifyHtml));
app.get('/health', async (_req, res) => res.json({ ok: true, store: storeKind, zalo: await tokenStatus() }));

// ----- Cấp quyền OA (chỉ chủ OA dùng, cần ADMIN_KEY) -----
app.get('/oauth/start', (req, res) => {
  if (!safeEq(req.query.key ?? '', process.env.ADMIN_KEY)) return res.status(403).send('Sai ADMIN_KEY');
  res.redirect(buildAuthUrl(REDIRECT));
});

app.get('/oauth/callback', async (req, res) => {
  try {
    if (!req.query.code) throw new Error('Zalo không trả về code (anh đã bấm Từ chối?)');
    await exchangeCode(req.query.code, req.query.state);
    res.type('html').send('<meta charset="utf-8"><h2>Đã kết nối Zalo OA thành công ✅</h2><p>Anh có thể đóng trang này và quay lại Claude.</p>');
  } catch (e) {
    res.status(400).type('html').send(`<meta charset="utf-8"><h2>Kết nối thất bại</h2><pre>${String(e.message).replace(/</g, '&lt;')}</pre>`);
  }
});

// ----- Webhook từ Zalo -----
app.post('/webhook', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).end(); }
  if (!verifyWebhook(req.body, payload, req.get('X-ZEvent-Signature'))) return res.status(401).end();
  res.status(200).end(); // trả lời Zalo ngay
  addEvent(payload);
});

// ----- MCP endpoint (Claude custom connector) -----
app.all('/mcp/:secret', express.json({ limit: '1mb' }), async (req, res) => {
  if (!safeEq(req.params.secret, process.env.MCP_SECRET)) return res.status(404).end();
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  }
  const server = new McpServer({ name: 'hado-zalo-oa', version: '1.0.0' });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP lỗi:', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Zalo connector chạy ở cổng ${port}, lưu token bằng: ${storeKind}`);
  console.log(`- Cấp quyền OA: ${BASE}/oauth/start?key=<ADMIN_KEY>`);
  console.log(`- Callback cần khai báo trên Zalo: ${REDIRECT}`);
  console.log(`- Webhook URL: ${BASE}/webhook`);
  console.log(`- URL connector cho Claude: ${BASE}/mcp/<MCP_SECRET>`);
});
