// Tool MCP cho chế độ nick Zalo cá nhân (zca-js).
import { z } from 'zod';
import { personalState, threadSummaries, threadMessages, recentMessages, userInfo, groupHistory, sendText } from './personal.js';

const SEND_ENABLED = String(process.env.ZALO_SEND_ENABLED).toLowerCase() === 'true';
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};

export function registerPersonalTools(server) {
  server.registerTool('zcn_trang_thai', {
    title: 'Trạng thái nick Zalo cá nhân',
    description: 'Kiểm tra nick Zalo cá nhân của shop đã kết nối chưa, kết nối từ lúc nào, lỗi gần nhất, và chế độ gửi tin thật đang bật hay tắt.',
    inputSchema: {},
    annotations: READ,
  }, wrap(async () => {
    const s = personalState();
    return { trang_thai: s.status, tai_khoan: s.account, ket_noi_tu: s.since, loi_gan_nhat: s.lastError, gui_tin_that: SEND_ENABLED };
  }));

  server.registerTool('zcn_danh_sach_hoi_thoai', {
    title: 'Hội thoại Zalo cá nhân gần đây',
    description: 'Danh sách hội thoại mới nhất trên nick Zalo cá nhân (mỗi dòng: thread_id, tên khách, tin cuối, tin cuối có phải của khách không). Dùng để biết khách nào đang chờ trả lời. Chỉ có tin nhận được từ khi agent được kết nối (cộng phần Zalo gửi bù lúc kết nối).',
    inputSchema: {
      chi_ca_nhan: z.boolean().default(true).describe('true: bỏ qua tin trong nhóm'),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: READ,
  }, wrap((a) => threadSummaries(a)));

  server.registerTool('zcn_doc_hoi_thoai', {
    title: 'Đọc hội thoại Zalo cá nhân',
    description: 'Đọc các tin đã lưu của một hội thoại (thread_id từ zcn_danh_sach_hoi_thoai), xếp cũ đến mới. tu_minh=true là tin shop gửi.',
    inputSchema: {
      thread_id: z.string(),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: READ,
  }, wrap(({ thread_id, limit }) => threadMessages(thread_id, limit)));

  server.registerTool('zcn_tin_moi', {
    title: 'Tin Zalo cá nhân mới nhất',
    description: 'Các tin nhắn mới nhất (mọi hội thoại) trên nick Zalo cá nhân, mới nhất đứng đầu.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
      chi_tin_cua_khach: z.boolean().default(true),
    },
    annotations: READ,
  }, wrap(async ({ limit, chi_tin_cua_khach }) => {
    let list = await recentMessages(chi_tin_cua_khach ? 2000 : limit);
    if (chi_tin_cua_khach) list = list.filter((m) => !m.tu_minh);
    return list.slice(0, limit);
  }));

  server.registerTool('zcn_thong_tin_khach', {
    title: 'Hồ sơ người dùng Zalo',
    description: 'Xem tên, giới tính, ảnh đại diện (và SĐT nếu Zalo cho xem) của một người theo user id (chính là thread_id của hội thoại cá nhân).',
    inputSchema: { user_id: z.string() },
    annotations: READ,
  }, wrap(({ user_id }) => userInfo(user_id)));

  server.registerTool('zcn_lich_su_nhom', {
    title: 'Lịch sử tin nhắn nhóm Zalo',
    description: 'Lấy tin nhắn gần đây của một nhóm Zalo mà nick đang tham gia (group_id = thread_id của hội thoại nhóm).',
    inputSchema: { group_id: z.string(), count: z.number().int().min(1).max(50).default(30) },
    annotations: READ,
  }, wrap(({ group_id, count }) => groupHistory(group_id, count)));

  server.registerTool('zcn_gui_tin', {
    title: 'Gửi tin Zalo cá nhân',
    description: 'Gửi tin nhắn văn bản từ nick Zalo cá nhân của shop tới một hội thoại. CHỈ gọi sau khi chủ shop đã duyệt đúng nội dung này. Khi ZALO_SEND_ENABLED tắt, chỉ trả bản xem trước.',
    inputSchema: {
      thread_id: z.string(),
      noi_dung: z.string().min(1).max(2000),
      la_nhom: z.boolean().default(false),
    },
    annotations: WRITE,
  }, wrap(async ({ thread_id, noi_dung, la_nhom }) => {
    if (!SEND_ENABLED) return { da_gui: false, ly_do: 'ZALO_SEND_ENABLED đang tắt: đây chỉ là bản xem trước.', thread_id, noi_dung_se_gui: noi_dung };
    const r = await sendText(thread_id, noi_dung, la_nhom);
    return { da_gui: true, ket_qua: r };
  }));
}
