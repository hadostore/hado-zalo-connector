// Chế độ "nick Zalo cá nhân": đăng nhập bằng QR qua thư viện KHÔNG CHÍNH THỨC zca-js.
// Rủi ro: vi phạm điều khoản Zalo, nick có thể bị khoá. Chủ shop đã chấp nhận rủi ro này (17/11/2026).
import crypto from 'node:crypto';
import { Zalo, ThreadType } from 'zca-js';
import { getJSON, setJSON, delKey, pushList, getList } from './store.js';

const CREDS_KEY = 'personal:creds';
const MSGS_KEY = 'personal:msgs';
const MAX_MSGS = 5000;

const state = {
  status: 'chua_dang_nhap', // chua_dang_nhap | cho_quet_qr | da_quet | dang_ket_noi | da_ket_noi | bi_ngat
  qrImage: null,            // base64 PNG khi đang chờ quét
  scannedBy: null,
  account: null,            // { id, name }
  lastError: null,
  since: null,
};
let api = null;
let listener = null;
let loginInFlight = null;
const seen = new Set();

// ----- Mã hoá thông tin đăng nhập (cookie Zalo = toàn quyền nick) -----
function encKey() {
  return crypto.createHash('sha256').update('hado-zca:' + (process.env.PERSONAL_ENC_KEY || process.env.ADMIN_KEY)).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

// ----- Chuẩn hoá tin nhắn -----
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const parts = [content.title, content.description, content.href].filter((x) => typeof x === 'string' && x);
  return parts.length ? `[đính kèm] ${parts.join(' | ')}` : '[đính kèm/sticker]';
}
function normalize(m) {
  const d = m.data || {};
  return {
    id: String(d.msgId ?? ''),
    thread_id: String(m.threadId),
    loai: m.type === ThreadType.Group ? 'nhom' : 'ca_nhan',
    tu_minh: Boolean(m.isSelf),
    nguoi_gui_id: String(d.uidFrom ?? ''),
    nguoi_gui_ten: d.dName || '',
    thoi_gian: d.ts ? new Date(Number(d.ts)).toISOString() : new Date().toISOString(),
    noi_dung: textOf(d.content),
    kieu: d.msgType,
  };
}
async function saveMessage(m) {
  const n = normalize(m);
  if (!n.id || seen.has(n.id)) return;
  seen.add(n.id);
  if (seen.size > 8000) seen.delete(seen.values().next().value);
  await pushList(MSGS_KEY, n, MAX_MSGS).catch((e) => console.error('Lưu tin lỗi:', e.message));
}

// ----- Tải lùi lịch sử: xin Zalo từng trang tin cũ hơn tới khi hết hoặc đủ số trang -----
const BACKFILL_MAX_PAGES = Number(process.env.ZCA_BACKFILL_PAGES || 40);
const backfill = { [ThreadType.User]: { pages: 0, lastId: null, total: 0, done: false }, [ThreadType.Group]: { pages: 0, lastId: null, total: 0, done: false } };
export function startBackfill() {
  for (const t of [ThreadType.User, ThreadType.Group]) {
    Object.assign(backfill[t], { pages: 0, lastId: null, total: 0, done: false });
    try { listener?.requestOldMessages(t); } catch {}
  }
}
function continueBackfill(list, type) {
  const b = backfill[type];
  if (!b || b.done) return;
  b.pages++;
  b.total += list.length;
  if (!list.length) { b.done = true; return; }
  let oldest = list[0];
  for (const m of list) if (Number(m.data?.ts) < Number(oldest.data?.ts)) oldest = m;
  const id = String(oldest.data?.msgId ?? '');
  if (!id || id === b.lastId || b.pages >= BACKFILL_MAX_PAGES) { b.done = true; return; }
  b.lastId = id;
  setTimeout(() => { try { listener?.requestOldMessages(type, id); } catch { b.done = true; } }, 1500);
}
export const backfillStatus = () => ({
  ca_nhan: { ...backfill[ThreadType.User] }, nhom: { ...backfill[ThreadType.Group] }, toi_da_trang: BACKFILL_MAX_PAGES,
});

// ----- Kết nối -----
function attachListener() {
  listener = api.listener;
  listener.on('connected', () => {
    console.log('[zca] listener connected');
    state.status = 'da_ket_noi';
    state.since = new Date().toISOString();
    state.lastError = null;
    // Lấy lại tin gần đây (bù tin nhận được lúc server ngủ/khởi động lại), rồi tải lùi nhiều trang.
    startBackfill();
  });
  listener.on('message', (m) => { saveMessage(m); });
  listener.on('old_messages', (list, type) => {
    for (const m of list) saveMessage(m);
    continueBackfill(list, type);
  });
  listener.on('disconnected', (code, reason) => { console.log('[zca] disconnected', code, reason); state.status = 'dang_ket_noi_lai'; });
  listener.on('closed', (code, reason) => {
    console.log('[zca] closed', code, reason);
    state.status = 'bi_ngat';
    const kicked = code === 3000 || code === 3003;
    state.lastError = kicked
      ? 'Nick đang mở Zalo Web ở nơi khác (chat.zalo.me) nên kết nối của agent bị ngắt. Đóng Zalo Web rồi bấm Kết nối lại.'
      : `Kết nối bị đóng (${code}) ${reason || ''}, đang tự kết nối lại...`.trim();
    if (!kicked) scheduleReconnect();
  });
  listener.on('error', (e) => { console.log('[zca] ws error', e?.message || e); state.lastError = String(e?.message || e); });
  listener.start({ retryOnClose: true });
}

async function afterLogin(zaloApi) {
  api = zaloApi;
  const id = api.getOwnId();
  let name = '';
  try { const info = await api.fetchAccountInfo(); name = info?.profile?.displayName || info?.displayName || ''; } catch {}
  state.account = { id: String(id), name };
  state.qrImage = null;
  attachListener();
}

const newZalo = () => new Zalo({ selfListen: true, checkUpdate: false, logging: String(process.env.ZCA_LOGGING) === 'true' });

export function startQRLogin() {
  if (loginInFlight) return loginInFlight;
  stopListener();
  state.status = 'cho_quet_qr';
  state.qrImage = null;
  state.scannedBy = null;
  state.lastError = null;
  loginInFlight = (async () => {
    try {
      const zalo = newZalo();
      let retries = 0;
      const zaloApi = await zalo.loginQR({}, (ev) => {
        switch (ev.type) {
          case 0: state.qrImage = ev.data.image; state.status = 'cho_quet_qr'; break; // QR mới
          case 1: // QR hết hạn (~100 giây): tự tạo QR mới tối đa 3 lần
            state.qrImage = null;
            if (retries++ < 3) ev.actions.retry(); else { state.status = 'qr_het_han'; ev.actions.abort(); }
            break;
          case 2: state.status = 'da_quet'; state.scannedBy = ev.data.display_name; break;
          case 3: state.status = 'tu_choi'; state.qrImage = null; ev.actions.abort(); break;
          case 4: // GotLoginInfo
            setJSON(CREDS_KEY, encrypt({ cookie: ev.data.cookie, imei: ev.data.imei, userAgent: ev.data.userAgent }))
              .catch((e) => console.error('Lưu đăng nhập lỗi:', e.message));
            break;
        }
      });
      if (!zaloApi) throw new Error('Đăng nhập QR không thành công');
      console.log('[zca] QR login ok');
      state.status = 'dang_ket_noi';
      await afterLogin(zaloApi);
    } catch (e) {
      console.log('[zca] QR login failed', e?.message || e);
      if (state.status !== 'qr_het_han' && state.status !== 'tu_choi') state.status = 'chua_dang_nhap';
      state.lastError = String(e?.message || e);
    } finally {
      loginInFlight = null;
    }
  })();
  return loginInFlight;
}

export async function restoreSession() {
  const box = await getJSON(CREDS_KEY).catch(() => null);
  if (!box) return false;
  try {
    state.status = 'dang_ket_noi';
    const creds = decrypt(box);
    await afterLogin(await newZalo().login(creds));
    return true;
  } catch (e) {
    console.log('[zca] restore failed', e?.message || e);
    state.status = state.account ? 'bi_ngat' : 'chua_dang_nhap';
    state.lastError = 'Đăng nhập lại bằng phiên đã lưu thất bại (nếu lỗi kéo dài, hãy quét QR lại): ' + (e?.message || e);
    return false;
  }
}

// Tự kết nối lại khi rớt mạng: đăng nhập lại bằng phiên đã lưu, giãn dần 30s -> 10 phút.
let reconnectTimer = null;
let reconnectDelay = 30_000;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    stopListener();
    const ok = await restoreSession();
    if (ok) { reconnectDelay = 30_000; return; }
    reconnectDelay = Math.min(reconnectDelay * 2, 600_000);
    scheduleReconnect(); // vẫn lỗi: thử lại, giãn dần tới 10 phút/lần
    state.status = 'bi_ngat';
  }, reconnectDelay);
}
export async function reconnectNow() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopListener();
  reconnectDelay = 30_000;
  return restoreSession();
}
// Lưới an toàn: 5 phút kiểm tra 1 lần, nếu đang bị ngắt (không phải do Zalo Web) thì nối lại.
setInterval(() => {
  if (state.status === 'bi_ngat' && state.account && !state.lastError?.includes('Zalo Web')) scheduleReconnect();
}, 5 * 60_000).unref();

function stopListener() {
  try { listener?.stop(); } catch {}
  listener = null;
  api = null;
}

export async function logout() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopListener();
  await delKey(CREDS_KEY);
  Object.assign(state, { status: 'chua_dang_nhap', qrImage: null, account: null, scannedBy: null, lastError: null, since: null });
}

export const personalState = () => ({ ...state });
export const isLoggedIn = () => Boolean(api);
export const hasAccount = () => Boolean(state.account);

function requireApi() {
  if (!api) throw new Error(`Nick Zalo cá nhân chưa kết nối (trạng thái: ${state.status}). Chủ shop cần mở trang /canhan?key=<ADMIN_KEY> và quét QR.`);
  return api;
}

// ----- Dữ liệu cho tool -----
export async function recentMessages(limit = 200) {
  return getList(MSGS_KEY, Math.min(limit, MAX_MSGS));
}

export async function threadSummaries({ chi_ca_nhan = true, limit = 20 }) {
  const msgs = await recentMessages(MAX_MSGS);
  const threads = new Map();
  for (const m of msgs) { // mới nhất trước
    if (chi_ca_nhan && m.loai !== 'ca_nhan') continue;
    let t = threads.get(m.thread_id);
    if (!t) {
      t = { thread_id: m.thread_id, loai: m.loai, ten_khach: null, tin_cuoi: m.noi_dung, luc: m.thoi_gian, tin_cuoi_la_cua_khach: !m.tu_minh, so_tin_luu: 0 };
      threads.set(m.thread_id, t);
    }
    if (!m.tu_minh && !t.ten_khach) t.ten_khach = m.nguoi_gui_ten;
    t.so_tin_luu++;
  }
  return [...threads.values()].slice(0, limit);
}

export async function threadMessages(threadId, limit = 30) {
  const msgs = (await recentMessages(MAX_MSGS)).filter((m) => m.thread_id === String(threadId));
  return msgs.slice(0, limit).reverse(); // cũ -> mới cho dễ đọc
}

export async function userInfo(userId) {
  const r = await requireApi().getUserInfo(String(userId));
  const p = r?.changed_profiles?.[userId] || r?.changed_profiles?.[`${userId}_0`] || Object.values(r?.changed_profiles || {})[0];
  if (!p) return r;
  return { user_id: userId, ten: p.displayName || p.zaloName, ten_zalo: p.zaloName, gioi_tinh: p.gender, sdt: p.phoneNumber || null, anh: p.avatar };
}

let friendsCache = null;
export async function contacts({ refresh = false } = {}) {
  if (!friendsCache || refresh) {
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const r = await requireApi().getAllFriends(200, page);
      const list = Array.isArray(r) ? r : (r?.friends || r?.data || []);
      all.push(...list);
      if (list.length < 200) break;
    }
    friendsCache = all.map((u) => ({ user_id: String(u.userId), ten: u.displayName || u.zaloName, ten_zalo: u.zaloName, sdt: u.phoneNumber || null }));
  }
  return friendsCache;
}

export async function labels() {
  const r = await requireApi().getLabels();
  const names = new Map((friendsCache || []).map((f) => [f.user_id, f.ten]));
  return (r?.labelData || []).map((l) => ({
    nhan: l.text, so_hoi_thoai: l.conversations?.length || 0,
    hoi_thoai: (l.conversations || []).map((id) => ({ thread_id: String(id).replace(/^g/, ''), la_nhom: String(id).startsWith('g'), ten: names.get(String(id)) || null })),
  }));
}

export async function groupHistory(groupId, count = 30) {
  return requireApi().getGroupChatHistory(String(groupId), count);
}

export async function sendText(threadId, text, isGroup) {
  return requireApi().sendMessage(text, String(threadId), isGroup ? ThreadType.Group : ThreadType.User);
}
