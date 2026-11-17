const f = document.getElementById('f'), u = document.getElementById('u'), p = document.getElementById('p'), t = document.getElementById('t');
const tw = document.getElementById('tw'), rw = document.getElementById('rw'), r = document.getElementById('r'), b = document.getElementById('b'), e = document.getElementById('e');
let needTotp = false, timer = null;
const show = (m) => { e.textContent = m || ''; };
f.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (b.disabled) return;
  b.disabled = true; show('');
  try {
    const res = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.value, password: p.value, totp: needTotp ? t.value.trim() : undefined, remember: r.checked }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) { location.replace('/'); return; }
    if (res.ok && j.need === 'totp') { needTotp = true; tw.hidden = false; t.focus(); show('Enter your authentication code.'); }
    else if (res.status === 429) {
      let s = j.retryAfter || 60; show(`Too many attempts. Try again in ${s}s.`);
      clearInterval(timer); b.disabled = true;
      timer = setInterval(() => { s--; if (s <= 0) { clearInterval(timer); b.disabled = false; show(''); } else show(`Too many attempts. Try again in ${s}s.`); }, 1000);
      return;
    } else show(j.error || 'Sign in failed.');
  } catch { show('Network error. Please retry.'); }
  b.disabled = false;
});
// "remember this device" checkbox appears only if the server allows it
fetch('/_/opts.json').then((r) => r.json()).then((o) => { rw.hidden = !o.remember; }).catch(() => {});
