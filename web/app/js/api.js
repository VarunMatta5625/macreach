let csrf = '';
export const setCsrf = (t) => { csrf = t; };
export const getCsrf = () => csrf;

export async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'x-csrf': csrf, ...(opts.headers || {}) } });
  if (res.status === 401) { location.replace('/'); throw new Error('unauthorized'); }
  return res;
}
export async function apiJSON(path, opts) {
  const res = await api(path, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
