// Lưu 300 sự kiện webhook gần nhất (tin khách gửi tới OA, follow/unfollow...).
import { getJSON, setJSON } from './store.js';

const KEY = 'events';
const MAX = 300;
let cache = null;
let chain = Promise.resolve();

async function load() {
  if (!cache) cache = (await getJSON(KEY)) || [];
  return cache;
}

export function addEvent(payload) {
  chain = chain.then(async () => {
    const list = await load();
    list.push({
      event: payload.event_name,
      time: payload.timestamp ? new Date(Number(payload.timestamp)).toISOString() : new Date().toISOString(),
      user_id: payload.sender?.id ?? payload.follower?.id ?? payload.user_id_by_app,
      to: payload.recipient?.id,
      text: payload.message?.text,
      msg_id: payload.message?.msg_id,
      attachments: payload.message?.attachments,
    });
    if (list.length > MAX) list.splice(0, list.length - MAX);
    await setJSON(KEY, list);
  }).catch((e) => console.error('Lưu webhook lỗi:', e.message));
  return chain;
}

export async function listEvents({ user_id, since, limit = 50, only_from_customers = true }) {
  let list = [...(await load())];
  if (only_from_customers) list = list.filter((e) => e.event?.startsWith('user_') || e.event === 'follow');
  if (user_id) list = list.filter((e) => e.user_id === user_id);
  if (since) list = list.filter((e) => e.time >= since);
  return list.slice(-limit).reverse();
}
