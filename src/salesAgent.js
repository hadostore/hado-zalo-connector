// "Nhân viên ảo" Zalo: đọc tin khách, soạn trả lời + đơn nháp, gửi vào nhóm duyệt nội bộ.
// Chỉ gửi cho khách khi nhân viên nhắn "ok <mã>" trong nhóm duyệt; chỉ tạo Đặt hàng KiotViet khi nhắn "don <mã>".
// Bật bằng AGENT_ENABLED=true, cần ANTHROPIC_API_KEY và AGENT_APPROVAL_GROUP_ID (thread_id nhóm duyệt).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getJSON, setJSON } from './store.js';
import { setMessageHook, threadMessages, sendText, groupName, isLoggedIn } from './personal.js';
import { kiotvietConfigured, kvCreateOrder } from './kiotviet.js';

const ENABLED = String(process.env.AGENT_ENABLED).toLowerCase() === 'true';
const APPROVAL_GROUP = String(process.env.AGENT_APPROVAL_GROUP_ID || '');
const DEBOUNCE_MS = Number(process.env.AGENT_DEBOUNCE_SEC || 60) * 1000;
const MODEL = process.env.AGENT_MODEL || 'claude-opus-5-5';
export const KB_KEY = 'agent:kb';
export const ALIAS_KEY = 'agent:aliases';
export const STYLE_KEY = 'agent:style';

let client = null;
const timers = new Map();
const stats = { drafts: 0, sent: 0, orders: 0, errors: 0, lastError: null };
export const agentStatus = () => ({ bat: ENABLED, nhom_duyet: APPROVAL_GROUP || null, kiotviet: kiotvietConfigured(), co_api_key: Boolean(process.env.ANTHROPIC_API_KEY), model: MODEL, ...stats });

const Reply = z.object({
  y_dinh: z.enum(['hoi_gia', 'dat_hang', 'hoi_thong_tin', 'khieu_nai', 'tro_chuyen', 'khong_can_tra_loi']),
  can_tra_loi: z.boolean(),
  tra_loi: z.string(),
  dong_hang: z.array(z.object({ ma_hang: z.string(), ten_khach_goi: z.string(), so_luong: z.number() })),
  khach_da_chot_don: z.boolean(),
  can_nguoi_xem: z.string(),
});

const RULES = `Bạn là nhân viên bán hàng của HADO STORE (dược mỹ phẩm Ziaja, Farmona, Celia, EUPC... bán sỉ cho bác sĩ, phòng khám, nhà thuốc, spa) trên Zalo.
Nhiệm vụ: đọc đoạn chat, soạn câu trả lời tiếp theo cho khách và nhận diện hàng khách muốn đặt.
Quy tắc bắt buộc:
- Giọng nhân viên thật: ngắn, tự nhiên, xưng "c/e" hoặc "em/anh chị" theo cách đoạn chat đang dùng. Không văn mẫu, không gạch đầu dòng dài, không emoji thừa.
- Chỉ báo giá theo dữ liệu được đưa trong tin nhắn (giá niêm yết + % CK riêng của khách). Không có dữ liệu thì KHÔNG đoán: trả lời kiểu "e kiểm tra giá rồi báo c ngay ạ" và ghi lý do vào can_nguoi_xem.
- Không hứa khuyến mãi, quà tặng, tồn kho, ngày giao, công dụng điều trị nếu dữ liệu không có. Câu hỏi chuyên môn y khoa, khiếu nại, công nợ, đổi trả: để người xử lý (can_nguoi_xem).
- dong_hang: chỉ liệt kê hàng khách thực sự muốn đặt, ma_hang phải lấy đúng trong danh mục; tên gọi tắt tra bảng tên gọi tắt. Không chắc mã nào thì để ma_hang rỗng và ghi vào can_nguoi_xem.
- khach_da_chot_don = true chỉ khi khách đã nói rõ lấy hàng/số lượng.
- Nếu tin cuối không cần trả lời (cảm ơn, sticker, đã có nhân viên trả lời) thì can_tra_loi = false.`;

function catalogText(kb) {
  return Object.entries(kb.danh_muc || {}).map(([ma, p]) => `${ma} | ${p.ten} | ${p.thuong_hieu} | ${p.gia_niem_yet}k`).join('\n');
}

async function loadKB() {
  const [kb, aliases, style] = await Promise.all([getJSON(KB_KEY).catch(() => null), getJSON(ALIAS_KEY).catch(() => null), getJSON(STYLE_KEY).catch(() => null)]);
  return { kb: kb || { danh_muc: {}, khach: {} }, aliases: aliases || {}, style: style || '' };
}

function findCustomer(kb, title) {
  const m = String(title || '').match(/^\s*\(?(?:Mới\)?\s*)?(\d{1,5})/i);
  if (!m) return null;
  return Object.values(kb.khach || {}).find((c) => c.so === m[1]) || null;
}

// Tính giá bằng code từ dữ liệu, không để model tự tính.
function priceLine(kb, cust, line) {
  const p = kb.danh_muc?.[line.ma_hang];
  if (!p) return { ...line, loi: 'mã không có trong danh mục' };
  const row = cust?.dong?.find((r) => r.ma_hang === line.ma_hang);
  const out = { ...line, ten: p.ten, gia_niem_yet: row?.gia_niem_yet ?? p.gia_niem_yet };
  if (!cust) return { ...out, ck_pct: null, loi: 'chưa xác định khách' };
  if (row && row.ck_cac_lan.length === 1 && row.ck < 100) return { ...out, ck_pct: row.ck, chac: true };
  if (row) return { ...out, ck_pct: row.ck, loi: `CK từng dùng: ${row.ck_cac_lan.join('/')}%` };
  return { ...out, ck_pct: cust.ck_hay_dung, loi: `khách chưa mua mã này, tạm theo CK hay dùng ${cust.ck_hay_dung}%` };
}

const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('vi-VN');

async function draftFor(threadId, isGroup) {
  if (!isLoggedIn()) return;
  const msgs = await threadMessages(threadId, 30);
  const last = msgs[msgs.length - 1];
  if (!last || last.tu_minh) return; // nhân viên đã trả lời rồi
  const { kb, aliases, style } = await loadKB();
  const title = isGroup ? await groupName(threadId).catch(() => '') : (last.nguoi_gui_ten || '');
  const cust = findCustomer(kb, title);
  const custRows = cust ? cust.dong.map((r) => `${r.ma_hang} | ${kb.danh_muc[r.ma_hang]?.ten || ''} | niêm yết ${r.gia_niem_yet}k | CK ${r.ck}%${r.ck_cac_lan.length > 1 ? ` (từng: ${r.ck_cac_lan.join('/')}%)` : ''}`).join('\n') : '';
  const chat = msgs.map((m) => `${m.tu_minh ? 'HADO' : (m.nguoi_gui_ten || 'Khách')}: ${m.noi_dung || `[${m.kieu}]`}`).join('\n');

  client ||= new Anthropic();
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'medium', format: zodOutputFormat(Reply) },
    system: [
      { type: 'text', text: `${RULES}\n${style ? `\nGiọng văn HADO tham khảo:\n${style}\n` : ''}\nBảng tên gọi tắt (khách gọi -> mã hàng):\n${JSON.stringify(aliases)}\n\nDanh mục (mã | tên | hãng | giá niêm yết, nghìn đồng):\n${catalogText(kb)}`, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: `Hội thoại: ${title || threadId}\nKhách trên KiotViet: ${cust ? `${cust.ma_kh} ${cust.ten}, CK hay dùng ${cust.ck_hay_dung}%` : 'CHƯA XÁC ĐỊNH'}\nGiá riêng của khách (${cust?.da_duyet ? 'đã duyệt' : 'CHƯA DUYỆT, chỉ tham khảo'}):\n${custRows || '(không có)'}\n\nĐoạn chat (cũ -> mới):\n${chat}`,
    }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`model không trả kết quả (${res.stop_reason})`);
  const out = res.parsed_output;
  if (!out.can_tra_loi && !out.dong_hang.length) return;

  const lines = out.dong_hang.filter((l) => l.ma_hang).map((l) => priceLine(kb, cust, l));
  const id = Math.random().toString(36).slice(2, 6).toUpperCase();
  await setJSON(`agent:draft:${id}`, { id, threadId, isGroup, title, ma_kh: cust?.ma_kh || null, tra_loi: out.tra_loi, lines, chot: out.khach_da_chot_don, at: Date.now() });

  const khach = msgs.filter((m) => !m.tu_minh).slice(-3).map((m) => `"${(m.noi_dung || '').slice(0, 160)}"`).join(' / ');
  let text = `🤖 #${id} | ${title || threadId}\nKhách: ${khach}\n`;
  if (out.can_tra_loi) text += `\nĐề xuất trả lời:\n${out.tra_loi}\n`;
  if (lines.length || out.dong_hang.length) {
    text += `\nĐơn nháp${cust ? ` (${cust.ma_kh})` : ' (CHƯA rõ khách)'}:\n`;
    let total = 0;
    lines.forEach((l, i) => {
      const net = l.ck_pct != null ? l.gia_niem_yet * (1 - l.ck_pct / 100) : null;
      if (net != null) total += net * l.so_luong;
      text += `${i + 1}) ${l.ten || l.ma_hang} x${l.so_luong} | ${l.gia_niem_yet}k CK ${l.ck_pct ?? '?'}%${net != null ? ` = ${fmt(net)}k` : ''}${l.loi ? ` ⚠ ${l.loi}` : ''}\n`;
    });
    out.dong_hang.filter((l) => !l.ma_hang).forEach((l) => { text += `?) "${l.ten_khach_goi}" x${l.so_luong} ⚠ chưa xác định mã\n`; });
    if (total) text += `Tạm tính: ${fmt(total)}k\n`;
  }
  if (out.can_nguoi_xem) text += `\n⚠ Cần người xem: ${out.can_nguoi_xem}\n`;
  text += `\nNhắn: ok ${id} (gửi trả lời)${lines.length ? ` | don ${id} (tạo Đặt hàng KiotViet)` : ''} | bo ${id}`;
  await sendText(APPROVAL_GROUP, text, true);
  stats.drafts++;
}

async function handleApproval(n) {
  const m = String(n.noi_dung || '').trim().match(/^(ok|don|bo)\s+#?([A-Z0-9]{4})\b/i);
  if (!m) return;
  const [, cmd, id] = m;
  const d = await getJSON(`agent:draft:${id.toUpperCase()}`).catch(() => null);
  if (!d) return sendText(APPROVAL_GROUP, `Không thấy nháp #${id}.`, true);
  if (d.done?.[cmd.toLowerCase()]) return sendText(APPROVAL_GROUP, `#${d.id} đã xử lý lệnh "${cmd}" rồi.`, true);
  const c = cmd.toLowerCase();
  if (c === 'bo') { d.done = { ...d.done, bo: true }; await setJSON(`agent:draft:${d.id}`, d); return; }
  if (c === 'ok') {
    await sendText(d.threadId, d.tra_loi, d.isGroup);
    stats.sent++;
  } else if (c === 'don') {
    if (!kiotvietConfigured()) return sendText(APPROVAL_GROUP, `Chưa kết nối KiotViet nên chưa tạo được đơn #${d.id}.`, true);
    if (!d.ma_kh) return sendText(APPROVAL_GROUP, `#${d.id} chưa xác định khách KiotViet, nhân viên tạo tay giúp.`, true);
    const bad = d.lines.filter((l) => l.ck_pct == null || !l.ma_hang);
    if (bad.length) return sendText(APPROVAL_GROUP, `#${d.id} còn dòng thiếu mã hoặc CK, nhân viên tạo tay giúp.`, true);
    const r = await kvCreateOrder({ maKh: d.ma_kh, lines: d.lines, ghiChu: `Agent Zalo #${d.id} – ${d.title}` });
    await sendText(APPROVAL_GROUP, `✅ Đã tạo Đặt hàng ${r?.code || ''} cho ${d.ma_kh} (#${d.id}).`, true);
    stats.orders++;
  }
  d.done = { ...d.done, [c]: true, by: n.nguoi_gui_ten, at: Date.now() };
  await setJSON(`agent:draft:${d.id}`, d);
}

function onMessage(n) {
  if (n.thread_id === APPROVAL_GROUP) {
    handleApproval(n).catch((e) => { stats.errors++; stats.lastError = e.message; sendText(APPROVAL_GROUP, `Lỗi xử lý lệnh: ${e.message}`, true).catch(() => {}); });
    return;
  }
  if (n.tu_minh) { clearTimeout(timers.get(n.thread_id)); timers.delete(n.thread_id); return; }
  clearTimeout(timers.get(n.thread_id));
  timers.set(n.thread_id, setTimeout(() => {
    timers.delete(n.thread_id);
    draftFor(n.thread_id, n.loai === 'nhom').catch((e) => { stats.errors++; stats.lastError = e.message; console.error('[agent] draft lỗi', e.message); });
  }, DEBOUNCE_MS));
}

export function startSalesAgent() {
  if (!ENABLED) { console.log('[agent] tắt (AGENT_ENABLED != true)'); return; }
  if (!process.env.ANTHROPIC_API_KEY || !APPROVAL_GROUP) { console.log('[agent] thiếu ANTHROPIC_API_KEY hoặc AGENT_APPROVAL_GROUP_ID, không chạy'); return; }
  setMessageHook(onMessage);
  console.log('[agent] đang chạy, nhóm duyệt', APPROVAL_GROUP);
}
