// Định nghĩa các tool MCP mà Claude sẽ thấy khi bật connector.
import { z } from 'zod';
import { zalo, tokenStatus } from './zalo.js';
import { listEvents } from './events.js';

const SEND_ENABLED = String(process.env.ZALO_SEND_ENABLED).toLowerCase() === 'true';
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};

function preview(kind, payload) {
  return {
    da_gui: false,
    ly_do: 'ZALO_SEND_ENABLED đang tắt: đây chỉ là bản xem trước, chưa gửi cho khách.',
    loai: kind,
    noi_dung_se_gui: payload,
  };
}

function normalizePhone(p) {
  const d = String(p).replace(/\D/g, '');
  if (d.startsWith('84')) return d;
  if (d.startsWith('0')) return '84' + d.slice(1);
  return d;
}

export function registerTools(server) {
  server.registerTool('zalo_trang_thai', {
    title: 'Trạng thái kết nối Zalo OA',
    description: 'Kiểm tra connector đã được cấp quyền OA chưa, token còn hạn tới khi nào, và chế độ gửi tin thật đang bật hay tắt.',
    inputSchema: {},
    annotations: READ,
  }, wrap(async () => ({ ...(await tokenStatus()), gui_tin_that: SEND_ENABLED })));

  server.registerTool('zalo_thong_tin_oa', {
    title: 'Thông tin Official Account',
    description: 'Lấy thông tin OA của HADO (tên, ID, số người quan tâm, gói dịch vụ).',
    inputSchema: {},
    annotations: READ,
  }, wrap(() => zalo.get('/v2.0/oa/getoa')));

  server.registerTool('zalo_hoi_thoai_gan_day', {
    title: 'Danh sách hội thoại gần đây',
    description: 'Lấy các tin nhắn gần nhất của OA, mỗi dòng là tin cuối của một hội thoại (khách nào vừa nhắn, nhắn gì). Dùng để biết khách nào cần trả lời. Mỗi lần tối đa 10, dùng offset để xem thêm.',
    inputSchema: {
      offset: z.number().int().min(0).default(0),
      count: z.number().int().min(1).max(10).default(10),
    },
    annotations: READ,
  }, wrap(({ offset, count }) => zalo.get('/v2.0/oa/listrecentchat', { offset, count })));

  server.registerTool('zalo_doc_hoi_thoai', {
    title: 'Đọc hội thoại với một khách',
    description: 'Đọc lịch sử tin nhắn giữa OA và một khách (user_id lấy từ zalo_hoi_thoai_gan_day). Tin mới nhất đứng đầu. src=1 là khách gửi, src=0 là OA gửi. Mỗi lần tối đa 10 tin.',
    inputSchema: {
      user_id: z.string().describe('user_id của khách trên OA'),
      offset: z.number().int().min(0).default(0),
      count: z.number().int().min(1).max(10).default(10),
    },
    annotations: READ,
  }, wrap(({ user_id, offset, count }) => zalo.get('/v2.0/oa/conversation', { user_id, offset, count })));

  server.registerTool('zalo_tin_moi_webhook', {
    title: 'Tin khách gửi tới (qua webhook)',
    description: 'Đọc các sự kiện khách gửi tới OA mà server đã nhận qua webhook (tin chữ, ảnh, follow...). Chỉ có dữ liệu nếu đã cấu hình webhook. Mới nhất đứng đầu.',
    inputSchema: {
      user_id: z.string().optional(),
      since: z.string().optional().describe('Thời điểm ISO, ví dụ 2026-11-02T00:00:00Z'),
      limit: z.number().int().min(1).max(300).default(50),
    },
    annotations: READ,
  }, wrap((a) => listEvents(a)));

  server.registerTool('zalo_thong_tin_khach', {
    title: 'Thông tin một khách',
    description: 'Lấy hồ sơ khách trên OA: tên hiển thị, có quan tâm OA không, nhãn (tag), thông tin khách đã chia sẻ (tên, SĐT, địa chỉ nếu có).',
    inputSchema: { user_id: z.string() },
    annotations: READ,
  }, wrap(({ user_id }) => zalo.get('/v3.0/oa/user/detail', { user_id })));

  server.registerTool('zalo_danh_sach_khach', {
    title: 'Danh sách khách của OA',
    description: 'Liệt kê user_id khách, có thể lọc theo nhãn và thời gian tương tác gần nhất (TODAY, YESTERDAY, L7D, L30D).',
    inputSchema: {
      offset: z.number().int().min(0).default(0),
      count: z.number().int().min(1).max(50).default(50),
      tag_name: z.string().optional(),
      last_interaction_period: z.enum(['TODAY', 'YESTERDAY', 'L7D', 'L30D']).optional(),
      is_follower: z.boolean().optional(),
    },
    annotations: READ,
  }, wrap((a) => zalo.get('/v3.0/oa/user/getlist', Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)))));

  server.registerTool('zalo_gui_tin_tu_van', {
    title: 'Gửi tin tư vấn cho khách',
    description: 'Gửi tin nhắn chữ (tin tư vấn) tới một khách đã nhắn OA. Zalo chỉ cho gửi tin tư vấn miễn phí trong khung thời gian sau lần tương tác gần nhất của khách. LUÔN cho người dùng duyệt nội dung trước khi gọi. Khi ZALO_SEND_ENABLED tắt, tool chỉ trả bản xem trước.',
    inputSchema: {
      user_id: z.string(),
      text: z.string().min(1).max(2000),
      tra_loi_msg_id: z.string().optional().describe('msg_id của tin khách để trích dẫn trả lời (tuỳ chọn)'),
    },
    annotations: WRITE,
  }, wrap(async ({ user_id, text, tra_loi_msg_id }) => {
    const body = { recipient: { user_id }, message: { text, ...(tra_loi_msg_id ? { quote_message_id: tra_loi_msg_id } : {}) } };
    if (!SEND_ENABLED) return preview('tin_tu_van', body);
    return { da_gui: true, ket_qua: await zalo.post('/v3.0/oa/message/cs', body) };
  }));

  server.registerTool('zalo_gui_anh', {
    title: 'Gửi ảnh cho khách',
    description: 'Gửi một ảnh (URL công khai, ví dụ ảnh sản phẩm) kèm chú thích tới khách. LUÔN cho người dùng duyệt trước. Khi ZALO_SEND_ENABLED tắt, chỉ trả bản xem trước.',
    inputSchema: {
      user_id: z.string(),
      image_url: z.string().url(),
      caption: z.string().max(1000).optional(),
    },
    annotations: WRITE,
  }, wrap(async ({ user_id, image_url, caption }) => {
    const body = {
      recipient: { user_id },
      message: {
        ...(caption ? { text: caption } : {}),
        attachment: { type: 'template', payload: { template_type: 'media', elements: [{ media_type: 'image', url: image_url }] } },
      },
    };
    if (!SEND_ENABLED) return preview('anh', body);
    return { da_gui: true, ket_qua: await zalo.post('/v3.0/oa/message/cs', body) };
  }));

  server.registerTool('zalo_gan_nhan_khach', {
    title: 'Gắn nhãn cho khách',
    description: 'Gắn nhãn (tag) cho khách trên OA để phân loại, ví dụ "da-dau-mun", "da-chot-don", "cho-thanh-toan". Nhãn chưa có sẽ được tạo.',
    inputSchema: { user_id: z.string(), tag_name: z.string().min(1).max(50) },
    annotations: WRITE,
  }, wrap(({ user_id, tag_name }) => zalo.post('/v2.0/oa/tag/tagfollower', { user_id, tag_name })));

  server.registerTool('zalo_gui_zns', {
    title: 'Gửi ZNS xác nhận đơn',
    description: 'Gửi tin ZNS (Zalo Notification Service) theo mẫu đã được Zalo duyệt tới số điện thoại khách, ví dụ xác nhận đơn hàng. Tin ZNS có tính phí. template_data phải khớp tham số của mẫu. LUÔN cho người dùng duyệt trước. Khi ZALO_SEND_ENABLED tắt, chỉ trả bản xem trước.',
    inputSchema: {
      phone: z.string().describe('SĐT khách, dạng 09xx hoặc 849xx'),
      template_id: z.string(),
      template_data: z.record(z.string(), z.union([z.string(), z.number()])),
      tracking_id: z.string().optional().describe('Mã đơn hàng để đối soát'),
    },
    annotations: WRITE,
  }, wrap(async ({ phone, template_id, template_data, tracking_id }) => {
    const body = { phone: normalizePhone(phone), template_id, template_data, ...(tracking_id ? { tracking_id } : {}) };
    if (!SEND_ENABLED) return preview('zns', body);
    return { da_gui: true, ket_qua: await zalo.zns('/message/template', body) };
  }));
}
