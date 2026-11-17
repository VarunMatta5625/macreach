import { api, apiJSON, getCsrf } from './api.js';

const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

/** Upload to / download from the Mac over plain HTTP streams (never the video socket). */
export class Files {
  constructor({ ui, root }) {
    this.ui = ui; this.root = root;
    this.path = ''; this.showHidden = false; this.uploads = [];
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = '';
    const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt) e.textContent = txt; return e; };
    this.bar = el('div', 'fbar');
    this.crumb = el('div', 'crumb');
    const up = el('button', 'btn', '⬆ Upload'); up.type = 'button';
    this.input = el('input'); this.input.type = 'file'; this.input.multiple = true; this.input.hidden = true;
    up.onclick = () => this.input.click();
    this.input.onchange = () => { this.upload([...this.input.files]); this.input.value = ''; };
    const hid = el('label', 'chk'); const hc = el('input'); hc.type = 'checkbox'; hc.onchange = () => { this.showHidden = hc.checked; this.render(); };
    hid.append(hc, document.createTextNode(' Hidden'));
    this.bar.append(up, this.input, hid);
    this.upl = el('div', 'uploads');
    this.list = el('div', 'flist');
    this.drop = el('div', 'dropnote', 'Drop files here to send them to the Mac');
    r.append(this.bar, this.crumb, this.upl, this.list, this.drop);
    ['dragenter', 'dragover'].forEach((t) => r.addEventListener(t, (e) => { e.preventDefault(); r.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((t) => r.addEventListener(t, (e) => { e.preventDefault(); r.classList.remove('dragging'); }));
    r.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) this.upload(f); });
  }

  async open(path = this.path) { await this.load(path); }

  async load(path) {
    try {
      const j = await apiJSON('/api/files/list?path=' + encodeURIComponent(path || ''));
      this.data = j; this.path = j.path; this.render();
    } catch (e) { this.list.textContent = 'Cannot open folder: ' + e.message; }
  }

  render() {
    const j = this.data; if (!j) return;
    this.crumb.innerHTML = '';
    const home = j.roots[0] || '/';
    const rel = j.path.startsWith(home) ? j.path.slice(home.length) : j.path;
    const parts = ['Home', ...rel.split('/').filter(Boolean)];
    let acc = home;
    parts.forEach((p, i) => {
      if (i > 0) acc += '/' + p;
      const target = acc;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'crumbbtn'; b.textContent = p; b.onclick = () => this.load(target);
      this.crumb.append(b);
      if (i < parts.length - 1) this.crumb.append(document.createTextNode(' / '));
    });
    this.list.innerHTML = '';
    if (j.parent) this.list.append(this.row({ name: '..', dir: true }, j.parent, true));
    for (const e of j.entries) {
      if (!this.showHidden && e.name.startsWith('.')) continue;
      this.list.append(this.row(e, j.path + '/' + e.name));
    }
  }

  row(e, full, up = false) {
    const d = document.createElement('div'); d.className = 'frow';
    const n = document.createElement('button'); n.type = 'button'; n.className = 'fname'; n.textContent = (e.dir ? '📁 ' : '📄 ') + (up ? 'Up' : e.name);
    n.onclick = () => (e.dir ? this.load(full) : this.download(full));
    const s = document.createElement('span'); s.className = 'fsize'; s.textContent = e.dir ? '' : fmtSize(e.size);
    d.append(n, s);
    if (!up) {
      const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'btn small'; dl.textContent = e.dir ? 'Zip' : 'Get';
      dl.onclick = () => this.download(full);
      d.append(dl);
    }
    return d;
  }

  download(full) {
    const a = document.createElement('a');
    a.href = '/api/files/download?path=' + encodeURIComponent(full); a.download = ''; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
  }

  /** Download specific absolute paths (from the Mac's clipboard files list) */
  showPaths(paths) {
    this.list.innerHTML = '';
    const h = document.createElement('div'); h.className = 'note'; h.textContent = 'Files copied on the Mac:';
    this.list.append(h);
    for (const p of paths) this.list.append(this.row({ name: p.split('/').pop(), dir: false, size: 0 }, p));
  }

  upload(files, dir = '') {
    for (const f of files) this.uploadOne(f, dir);
    this.ui.openFiles?.();
  }

  uploadOne(file, dir) {
    const row = document.createElement('div'); row.className = 'urow';
    const label = document.createElement('span'); label.textContent = file.name;
    const prog = document.createElement('progress'); prog.max = 100; prog.value = 0;
    row.append(label, prog); this.upl.prepend(row);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/files/upload?name=${encodeURIComponent(file.name)}${dir ? '&dir=' + encodeURIComponent(dir) : ''}`);
    xhr.setRequestHeader('x-csrf', getCsrf());
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) prog.value = (e.loaded / e.total) * 100; };
    xhr.onload = () => {
      if (xhr.status === 200) { prog.value = 100; label.textContent = '✓ ' + file.name; this.ui.toast(`Sent ${file.name} to Mac`); try { label.title = JSON.parse(xhr.responseText).path; } catch {} }
      else { label.textContent = '✗ ' + file.name; this.ui.toast(`Upload failed: ${file.name}`); }
    };
    xhr.onerror = () => { label.textContent = '✗ ' + file.name; this.ui.toast('Upload failed'); };
    xhr.send(file);
  }
}
