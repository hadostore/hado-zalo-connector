// Client Zalo OA API: OAuth v4 (PKCE), tự làm mới access token, gọi API.
import crypto from 'node:crypto';
import { getJSON, setJSON } from './store.js';

const APP_ID = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;
const OAUTH = 'https://oauth.zaloapp.com/v4/oa';
const OPENAPI = 'https://openapi.zalo.me';
const ZNS_API = 'https://business.openapi.zalo.me';
const TOKEN_KEY = 'tokens';

// ---------- OAuth ----------
const pending = new Map(); // state -> { verifier, createdAt }

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildAuthUrl(redirectUri) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, { verifier, createdAt: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.createdAt > 15 * 60_000) pending.delete(k);
  const u = new URL(`${OAUTH}/permission`);
  u.searchParams.set('app_id', APP_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(params) {
  const res = await fetch(`${OAUTH}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: APP_SECRET },
    body: new URLSearchParams({ app_id: APP_ID, ...params }),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`Zalo OAuth lỗi: ${json.error ?? res.status} ${json.error_name ?? ''} ${json.error_description ?? ''}`.trim());
  }
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + Number(json.expires_in || 90000) * 1000,
    updated_at: new Date().toISOString(),
  };
  // Refresh token của Zalo chỉ dùng được 1 lần: phải lưu ngay token mới.
  await setJSON(TOKEN_KEY, tokens);
  return tokens;
}

export async function exchangeCode(code, state) {
  const p = pending.get(state);
  if (!p) throw new Error('state không hợp lệ hoặc đã hết hạn, hãy mở lại /oauth/start');
  pending.delete(state);
  return tokenRequest({ code, grant_type: 'authorization_code', code_verifier: p.verifier });
}

let refreshing = null;
async function refresh() {
  if (!refreshing) {
    refreshing = (async () => {
      const cur = await getJSON(TOKEN_KEY);
      if (!cur?.refresh_token) throw new Error('Chưa cấp quyền OA. Mở <PUBLIC_BASE_URL>/oauth/start?key=<ADMIN_KEY> để kết nối.');
      return tokenRequest({ refresh_token: cur.refresh_token, grant_type: 'refresh_token' });
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function accessToken(force = false) {
  const t = await getJSON(TOKEN_KEY);
  if (!t) throw new Error('Chưa cấp quyền OA. Mở <PUBLIC_BASE_URL>/oauth/start?key=<ADMIN_KEY> để kết nối.');
  if (force || Date.now() > t.expires_at - 5 * 60_000) return (await refresh()).access_token;
  return t.access_token;
}

export async function tokenStatus() {
  const t = await getJSON(TOKEN_KEY);
  if (!t) return { connected: false };
  return { connected: true, access_token_expires_at: new Date(t.expires_at).toISOString(), updated_at: t.updated_at };
}

// ---------- Gọi API ----------
const TOKEN_ERRORS = new Set([-216, -124, -155]); // access token không hợp lệ / hết hạn

async function call(base, method, path, { query, body } = {}, retried = false) {
  const url = new URL(base + path);
  if (query) url.searchParams.set('data', JSON.stringify(query));
  const res = await fetch(url, {
    method,
    headers: { access_token: await accessToken(retried), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Zalo trả về không phải JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (json.error && TOKEN_ERRORS.has(Number(json.error)) && !retried) {
    return call(base, method, path, { query, body }, true);
  }
  if (json.error && Number(json.error) !== 0) {
    throw new Error(`Zalo API lỗi ${json.error}: ${json.message}`);
  }
  return json.data ?? json;
}

export const zalo = {
  get: (path, query) => call(OPENAPI, 'GET', path, { query }),
  post: (path, body) => call(OPENAPI, 'POST', path, { body }),
  zns: (path, body) => call(ZNS_API, 'POST', path, { body }),
};

// ---------- Webhook ----------
export function verifyWebhook(rawBody, payload, signatureHeader) {
  const oaSecret = process.env.ZALO_OA_SECRET_KEY;
  if (!oaSecret) return true;
  const expected = 'mac=' + crypto.createHash('sha256')
    .update(`${payload.app_id}${rawBody}${payload.timestamp}${oaSecret}`).digest('hex');
  const got = String(signatureHeader || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
