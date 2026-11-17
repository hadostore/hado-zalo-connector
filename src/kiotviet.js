// KiotViet Public API: lấy token, tìm khách / hàng / chi nhánh, tạo phiếu Đặt hàng (không tạo hoá đơn).
// Cấu hình: KIOTVIET_CLIENT_ID, KIOTVIET_CLIENT_SECRET, KIOTVIET_RETAILER (tên gian hàng), KIOTVIET_BRANCH_ID (tuỳ chọn).
const ID_URL = 'https://id.kiotviet.vn/connect/token';
const API = 'https://public.kiotapi.com';

let token = null;
let tokenExp = 0;

export function kiotvietConfigured() {
  return Boolean(process.env.KIOTVIET_CLIENT_ID && process.env.KIOTVIET_CLIENT_SECRET && process.env.KIOTVIET_RETAILER);
}

async function getToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const body = new URLSearchParams({
    scopes: 'PublicApi.Access',
    grant_type: 'client_credentials',
    client_id: process.env.KIOTVIET_CLIENT_ID,
    client_secret: process.env.KIOTVIET_CLIENT_SECRET,
  });
  const r = await fetch(ID_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`KiotViet token lỗi ${r.status}`);
  const j = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + Number(j.expires_in || 3600) * 1000;
  return token;
}

async function kv(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Retailer: process.env.KIOTVIET_RETAILER, Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`KiotViet ${opts.method || 'GET'} ${path} lỗi ${r.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export const kvCustomerByCode = async (code) => (await kv(`/customers?code=${encodeURIComponent(code)}`))?.data?.[0] || null;
export const kvProductByCode = async (code) => kv(`/products/code/${encodeURIComponent(code)}`);
export const kvBranches = async () => (await kv('/branches'))?.data || [];

// lines: [{ma_hang, so_luong, gia_niem_yet (nghìn đ), ck_pct}]
export async function kvCreateOrder({ maKh, lines, ghiChu }) {
  const customer = await kvCustomerByCode(maKh);
  if (!customer) throw new Error(`Không thấy khách ${maKh} trên KiotViet`);
  let branchId = Number(process.env.KIOTVIET_BRANCH_ID || 0);
  if (!branchId) branchId = (await kvBranches())[0]?.id;
  const orderDetails = [];
  for (const l of lines) {
    const p = await kvProductByCode(l.ma_hang);
    const price = Math.round(Number(l.gia_niem_yet) * 1000);
    orderDetails.push({
      productId: p.id,
      productCode: p.code,
      productName: p.name,
      quantity: Number(l.so_luong),
      price,
      discountRatio: Number(l.ck_pct),
      discount: Math.round(price * Number(l.ck_pct) / 100),
    });
  }
  return kv('/orders', {
    method: 'POST',
    body: JSON.stringify({ branchId, customerId: customer.id, description: ghiChu || 'Agent Zalo tạo, nhân viên đã duyệt', orderDetails }),
  });
}
