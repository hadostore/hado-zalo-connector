// Lưu trữ nhỏ dạng key-value: Upstash Redis (REST) nếu có cấu hình, nếu không thì file JSON.
import fs from 'node:fs/promises';
import path from 'node:path';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_DIR = process.env.DATA_DIR || './data';
const PREFIX = 'hado-zalo:';

async function upstash(cmd, ...args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args]),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Upstash: ${json.error}`);
  return json.result;
}

function filePath(key) {
  return path.join(DATA_DIR, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

export const storeKind = UPSTASH_URL && UPSTASH_TOKEN ? 'upstash' : 'file';

export async function getJSON(key) {
  if (storeKind === 'upstash') {
    const v = await upstash('GET', PREFIX + key);
    return v ? JSON.parse(v) : null;
  }
  try {
    return JSON.parse(await fs.readFile(filePath(key), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function setJSON(key, value) {
  const s = JSON.stringify(value);
  if (storeKind === 'upstash') {
    await upstash('SET', PREFIX + key, s);
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const p = filePath(key);
  await fs.writeFile(p + '.tmp', s, { mode: 0o600 });
  await fs.rename(p + '.tmp', p);
}
