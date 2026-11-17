// HTTP server: endpoint MCP cho Claude, trang cấp quyền OA, và nhận webhook từ Zalo.
import express from 'express';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { buildAuthUrl, exchangeCode, tokenStatus, verifyWebhook } from './zalo.js';
import { addEvent } from './events.js';
import { storeKind } from './store.js';
import { registerPersonalTools } from './personalTools.js';
import { startQRLogin, restoreSession, reconnectNow, logout, personalState, isLoggedIn, hasAccount } from './personal.js';

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
const verifyHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="zalo-platform-site-verification" content="${VERIFY}" /></head><body>HADO Zalo OA connector đang chạy.</body></html>`;
app.get('/', (_req, res) => res.type('html').send(verifyHtml));
if (VERIFY) app.get(`/zalo_verifier${VERIFY}.html`, (_req, res) => res.type('html').send(verifyHtml));
app.get('/health', async (_req, res) => {
  const p = personalState();
  res.json({ ok: true, store: storeKind, zalo: await tokenStatus(), ca_nhan: { trang_thai: p.status, tai_khoan: p.account?.name || null } });
});

// ----- Nick Zalo cá nhân: trang quét QR (cần ADMIN_KEY) -----
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STATUS_VI = {
  chua_dang_nhap: 'Chưa đăng nhập', cho_quet_qr: 'Đang chờ quét QR', da_quet: 'Đã quét, hãy bấm Đăng nhập trên điện thoại',
  dang_ket_noi: 'Đang kết nối...', dang_ket_noi_lai: 'Đang kết nối lại...', da_ket_noi: 'Đã kết nối ✅', bi_ngat: 'Bị ngắt kết nối', qr_het_han: 'QR hết hạn', tu_choi: 'Đã từ chối trên điện thoại',
};
app.get('/canhan', (req, res) => {
  const key = req.query.key ?? '';
  if (!safeEq(key, process.env.ADMIN_KEY)) return res.status(403).send('Sai ADMIN_KEY');
  const s = personalState();
  const k = encodeURIComponent(key);
  const waiting = ['cho_quet_qr', 'da_quet', 'dang_ket_noi'].includes(s.status);
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${waiting ? '<meta http-equiv="refresh" content="3">' : ''}<title>Zalo cá nhân - HADO agent</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:32px auto;padding:0 16px;line-height:1.5}a.btn{display:inline-block;padding:10px 16px;border-radius:8px;background:#0068ff;color:#fff;text-decoration:none;margin:4px 8px 4px 0}a.red{background:#c62828}img{width:260px;border:1px solid #ddd;border-radius:8px}.err{color:#c62828}</style></head><body>
<h2>Nick Zalo cá nhân cho agent</h2>
<p><b>Trạng thái:</b> ${esc(STATUS_VI[s.status] || s.status)}${s.account ? ` · <b>${esc(s.account.name || s.account.id)}</b>` : ''}</p>
${s.scannedBy && s.status === 'da_quet' ? `<p>Đã quét bởi: ${esc(s.scannedBy)}</p>` : ''}
${s.qrImage ? `<p>Mở app Zalo trên điện thoại (nick muốn kết nối) → biểu tượng QR → quét mã này → bấm <b>Đăng nhập</b>:</p><img alt="QR" src="data:image/png;base64,${s.qrImage}">` : ''}
${s.lastError ? `<p class="err">${esc(s.lastError)}</p>` : ''}
<p>${isLoggedIn() ? '' : `<a class="btn" href="/canhan/start?key=${k}">Tạo mã QR đăng nhập</a>`}
${s.status === 'bi_ngat' ? `<a class="btn" href="/canhan/reconnect?key=${k}">Kết nối lại</a>` : ''}
${isLoggedIn() || s.status === 'bi_ngat' ? `<a class="btn red" href="/canhan/logout?key=${k}">Đăng xuất nick khỏi agent</a>` : ''}</p>
<p style="color:#666;font-size:14px">Lưu ý: kết nối này dùng thư viện không chính thức. Không mở Zalo Web (chat.zalo.me) cùng nick, vì sẽ đá agent ra.</p>
</body></html>`);
});
app.get('/canhan/start', (req, res) => {
  if (!safeEq(req.query.key ?? '', process.env.ADMIN_KEY)) return res.status(403).send('Sai ADMIN_KEY');
  startQRLogin();
  setTimeout(() => res.redirect(`/canhan?key=${encodeURIComponent(req.query.key)}`), 2500);
});
app.get('/canhan/reconnect', async (req, res) => {
  if (!safeEq(req.query.key ?? '', process.env.ADMIN_KEY)) return res.status(403).send('Sai ADMIN_KEY');
  await reconnectNow();
  res.redirect(`/canhan?key=${encodeURIComponent(req.query.key)}`);
});
app.get('/canhan/logout', async (req, res) => {
  if (!safeEq(req.query.key ?? '', process.env.ADMIN_KEY)) return res.status(403).send('Sai ADMIN_KEY');
  await logout();
  res.redirect(`/canhan?key=${encodeURIComponent(req.query.key)}`);
});

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
  registerPersonalTools(server);
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
  console.log(`- Nick Zalo cá nhân (quét QR): ${BASE}/canhan?key=<ADMIN_KEY>`);
  restoreSession().then((ok) => console.log(ok ? 'Đã khôi phục phiên nick Zalo cá nhân' : 'Chưa có phiên nick Zalo cá nhân'));
});

// Gói Render Free ngủ sau 15 phút không có request, làm đứt kết nối nhận tin.
// Khi nick cá nhân đang kết nối, tự gọi /health mỗi 10 phút để server luôn thức.
if (String(process.env.KEEP_ALIVE ?? 'true') !== 'false') {
  setInterval(() => {
    if (hasAccount()) fetch(`${BASE}/health`).catch(() => {});
  }, 10 * 60 * 1000).unref();
}
