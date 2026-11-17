# Connector Zalo OA cho HADO STORE: hướng dẫn cài đặt

Connector này là một máy chủ nhỏ (MCP server) đứng giữa Claude và Zalo Official Account API. Sau khi cài xong, anh thêm nó vào claude.ai như một **custom connector**, và Claude trong dự án "Agents Sale" sẽ đọc được tin nhắn khách trên OA, soạn câu trả lời, gắn nhãn khách và gửi ZNS xác nhận đơn.

Tổng thời gian cài đặt khoảng 45 đến 60 phút, chia làm 5 bước:

1. Chuẩn bị Zalo (OA + ứng dụng Zalo Developers)
2. Tạo nơi lưu token (Upstash, miễn phí)
3. Deploy server lên Render
4. Khai báo URL với Zalo và cấp quyền OA
5. Thêm connector vào Claude

> **An toàn:** Mặc định `ZALO_SEND_ENABLED=false`, các tool gửi tin chỉ trả **bản xem trước**, không gửi gì cho khách. Anh chỉ bật `true` khi đã thử xong và muốn cho phép gửi thật. Kể cả khi đã bật, Claude sẽ hỏi anh duyệt trước mỗi lần gọi tool gửi tin.
>
> **Không dán App Secret, token hay MCP_SECRET vào chat với Claude.** Các giá trị đó chỉ nhập trong trang cài đặt của Render.

---

## Claude làm được gì với connector này

| Tool | Việc làm | Gửi ra ngoài? |
|---|---|---|
| `zalo_trang_thai` | Kiểm tra đã kết nối OA chưa, token còn hạn, chế độ gửi thật bật/tắt | Không |
| `zalo_thong_tin_oa` | Thông tin OA (tên, số người quan tâm, gói) | Không |
| `zalo_hoi_thoai_gan_day` | Danh sách hội thoại mới nhất: khách nào vừa nhắn, nhắn gì | Không |
| `zalo_doc_hoi_thoai` | Đọc lịch sử chat với một khách | Không |
| `zalo_tin_moi_webhook` | Tin khách gửi tới mà server nhận qua webhook (gần như tức thời) | Không |
| `zalo_thong_tin_khach` | Hồ sơ khách: tên, nhãn, SĐT/địa chỉ nếu khách đã chia sẻ | Không |
| `zalo_danh_sach_khach` | Lọc khách theo nhãn, theo thời gian tương tác | Không |
| `zalo_gan_nhan_khach` | Gắn nhãn khách (vd: `da-chot-don`, `da-dau-mun`) | Chỉ trên OA, khách không thấy |
| `zalo_gui_tin_tu_van` | Trả lời tin nhắn khách | **Có** (khi bật gửi thật) |
| `zalo_gui_anh` | Gửi ảnh sản phẩm kèm chú thích | **Có** (khi bật gửi thật) |
| `zalo_gui_zns` | Gửi ZNS xác nhận đơn tới SĐT khách (có phí) | **Có** (khi bật gửi thật) |

---

## Bước 1. Chuẩn bị Zalo

**Điều kiện:** OA của HADO đã được xác thực (OA doanh nghiệp). Từ 01/06/2026, chỉ OA dùng gói **Tăng trưởng** (1.400.000đ/6 tháng hoặc 2.500.000đ/năm) hoặc **Toàn diện** mới được tích hợp Open API; gói Cơ bản và Tiêu chuẩn không dùng được connector này. Gói cũ Nâng cao/Premium còn hạn vẫn dùng được nhưng không gia hạn được nữa ([bảng giá Zalo](https://zalo.solutions/oa/pricing)).

1. Vào **https://developers.zalo.me**, đăng nhập bằng tài khoản Zalo là **quản trị viên OA**.
2. Bấm **Thêm ứng dụng mới**, đặt tên (vd: `HADO Sales Agent`), chọn danh mục, tạo.
3. Trong ứng dụng, mở **Thông tin ứng dụng (Cài đặt)** và ghi lại:
   - **ID ứng dụng** → `ZALO_APP_ID`
   - **Khóa bí mật của ứng dụng** → `ZALO_APP_SECRET`
4. Bấm **Kích hoạt** ứng dụng nếu đang ở trạng thái chưa kích hoạt.
5. Mục **Official Account → Thiết lập chung**: liên kết OA của HADO với ứng dụng. Phần Callback URL sẽ điền ở Bước 4 (sau khi có URL server).

## Bước 2. Tạo nơi lưu token (Upstash Redis, miễn phí)

Zalo cấp access token sống khoảng 25 giờ và refresh token sống 3 tháng, **mỗi refresh token chỉ dùng được một lần**. Server tự làm mới token, nên cần một chỗ lưu bền để không mất token khi server khởi động lại.

1. Vào **https://upstash.com**, đăng ký (đăng nhập bằng Google được).
2. **Create Database** → Redis, chọn region **Singapore (ap-southeast-1)**, gói Free.
3. Trong database, mục **REST API**, copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

(Nếu anh deploy lên VPS có ổ đĩa riêng thì bỏ qua bước này, token sẽ lưu ở thư mục `data/`.)

## Bước 3. Deploy server lên Render

1. Đưa thư mục `zalo-connector` lên một repo GitHub riêng (private). Nếu anh muốn, Claude có thể tạo repo và đẩy code giúp sau khi anh kết nối GitHub.
2. Vào **https://render.com** → **New → Web Service** → chọn repo đó.
   - Runtime: **Docker** (đã có sẵn `Dockerfile`), hoặc Node với Build `npm install`, Start `npm start`.
   - Region: **Singapore**.
   - Gói: **Starter** (~7 USD/tháng) được khuyên dùng. Gói Free sẽ "ngủ" sau 15 phút không dùng: lần gọi đầu chậm ~50 giây và **webhook từ Zalo có thể bị mất** trong lúc ngủ.
3. Mục **Environment**, thêm các biến (xem `.env.example`):

| Biến | Giá trị |
|---|---|
| `ZALO_APP_ID` | từ Bước 1 |
| `ZALO_APP_SECRET` | từ Bước 1 |
| `PUBLIC_BASE_URL` | URL Render cấp, vd `https://hado-zalo.onrender.com` (không có `/` cuối) |
| `MCP_SECRET` | chuỗi ngẫu nhiên dài, vd 48 ký tự hex |
| `ADMIN_KEY` | một mật khẩu khác, dùng để mở trang cấp quyền OA |
| `ZALO_SEND_ENABLED` | `false` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | từ Bước 2 |

   Tạo chuỗi ngẫu nhiên: trang https://www.random.org/strings hoặc lệnh `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

4. Deploy. Mở `https://<url>/health`, thấy `{"ok":true,...,"zalo":{"connected":false}}` là server đã chạy.

## Bước 4. Khai báo với Zalo và cấp quyền OA

1. **Xác thực domain** (Zalo yêu cầu trước khi nhận callback/webhook): trong developers.zalo.me, mục **Xác thực domain**, nhập domain Render. Zalo cấp một mã xác thực. Dán mã đó vào biến `ZALO_VERIFY_CODE` trên Render, đợi deploy lại, rồi bấm **Xác thực** trên Zalo. Server đã tự hiển thị cả meta tag lẫn file `zalo_verifier<MÃ>.html`.
2. **Callback URL**: mục **Official Account → Thiết lập chung**, điền:
   `https://<url>/oauth/callback`
   và tick các quyền: gửi tin nhắn, quản lý tin nhắn/hội thoại, quản lý thông tin người dùng, quản lý nhãn.
3. **Cấp quyền**: mở trình duyệt, vào
   `https://<url>/oauth/start?key=<ADMIN_KEY>`
   → Zalo hiện trang chọn OA → chọn OA HADO → **Cho phép**. Thấy "Đã kết nối Zalo OA thành công ✅" là xong. Kiểm tra lại `/health` sẽ thấy `"connected": true`.
4. **Webhook** (để nhận tin khách gần như tức thời): mục **Webhook**, điền `https://<url>/webhook`, bật các sự kiện `user_send_text`, `user_send_image`, `user_send_sticker`, `follow`, `unfollow`. Copy **OA Secret Key** của mục Webhook vào biến `ZALO_OA_SECRET_KEY` để server kiểm tra chữ ký (khuyên dùng).

## Bước 5. Thêm connector vào Claude

1. Trên claude.ai: **Settings → Connectors → Add custom connector**.
2. Tên: `Zalo OA HADO`. URL: `https://<url>/mcp/<MCP_SECRET>` (URL này coi như mật khẩu, không chia sẻ).
3. Lưu, rồi trong dự án "Agents Sale" bật connector này cho chat.
4. Thử: nhắn Claude "kiểm tra trạng thái Zalo" (gọi `zalo_trang_thai`), rồi "xem 10 hội thoại Zalo gần nhất".

## Bật gửi tin thật

Khi anh đã xem các bản nháp trả lời và thấy ổn: trên Render đổi `ZALO_SEND_ENABLED=true` và deploy lại. Claude vẫn phải hỏi anh duyệt trước mỗi lần gọi tool gửi.

Lưu ý chính sách Zalo:
- **Tin tư vấn** chỉ gửi được cho khách đã tương tác với OA, trong khung thời gian Zalo cho phép kể từ lần khách nhắn gần nhất, và có hạn mức theo gói OA.
- **ZNS** (xác nhận đơn, thông báo giao hàng) gửi theo **số điện thoại**, kể cả khách chưa quan tâm OA, nhưng: phải đăng ký **mẫu ZNS** và được Zalo duyệt (vài ngày), có phí mỗi tin, cần nạp tiền vào tài khoản ZCA. Khi có `template_id` và danh sách tham số của mẫu, gửi cho Claude để cài vào quy trình chốt đơn.

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Tool báo "Chưa cấp quyền OA" | Làm lại Bước 4.3 |
| `Zalo OAuth lỗi ... invalid refresh token` | Refresh token đã hết hạn (quá 3 tháng không dùng) hoặc bị dùng ở nơi khác. Làm lại Bước 4.3 |
| `Zalo API lỗi -224` hoặc lỗi về gói | OA chưa có gói dịch vụ hỗ trợ API này |
| `Zalo API lỗi -213`/`-230` khi gửi tin | Khách chưa quan tâm OA hoặc quá thời hạn được gửi tin tư vấn; dùng ZNS thay thế |
| `zalo_tin_moi_webhook` trống | Chưa cấu hình webhook, hoặc server Free bị ngủ. Dùng `zalo_hoi_thoai_gan_day` thay thế |
| Claude không thấy connector | Kiểm tra URL có đúng `/mcp/<MCP_SECRET>` và `/health` mở được |

## Cấu trúc code

```
zalo-connector/
├── src/server.js   # Express: /mcp/<secret>, /oauth/start, /oauth/callback, /webhook, /health
├── src/tools.js    # 11 tool MCP
├── src/zalo.js     # OAuth v4 (PKCE), tự làm mới token, gọi Zalo API, kiểm tra chữ ký webhook
├── src/events.js   # Lưu 300 sự kiện webhook gần nhất
├── src/store.js    # Lưu token: Upstash Redis hoặc file
├── .env.example
└── Dockerfile
```
