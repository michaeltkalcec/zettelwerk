const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/";
const PAGE_SIZE = 120;
const THUMB_WIDTH = 360;
const narrow = () => matchMedia("(max-width: 800px)").matches;

const $ = (s) => document.querySelector(s);
const state = {
  files: [], trash: [], view: "all", search: "", folder: "", sort: "mtime-desc", tagSearch: "",
  tagFilter: new Set(), selectMode: false, selected: new Set(), limit: PAGE_SIZE, current: null,
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
state.sort = store.get("sort") || state.sort;

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}
const fmtSize = (b) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB";
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const fileUrl = (f) => f.trash_path ? "trashpdf/" + encodeURIComponent(f.trash_path) : "pdf/" + enc(f.path);
const norm = (s) => s.toLocaleLowerCase("de");

// Tag-Farben: die Regenbogenfarben des alten Apple-Logos; gleicher Tag = immer gleiche Farbe
const TAG_COLORS = ["#61bb46", "#fdb827", "#f5821f", "#e03a3e", "#963d97", "#009ddc"];
function tagColor(t) {
  let x = 2166136261; // FNV-1a mit Nachmischung für gleichmäßige Verteilung
  for (const ch of norm(t)) x = Math.imul(x ^ ch.codePointAt(0), 16777619);
  x ^= x >>> 15; x = Math.imul(x, 2246822507); x ^= x >>> 13;
  return TAG_COLORS[(x >>> 0) % TAG_COLORS.length];
}
const tagChip = (t, ...rest) => h("span", { class: "tag", style: `--tc: ${tagColor(t)}` }, t, ...rest);

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 2500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

let pdfjs;
async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS + "pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
  }
  return pdfjs;
}

// ------------------------------------------------------------------ laden
async function load(rescan = false) {
  $("#status").textContent = rescan ? "Lese Ordner neu ein …" : "Lade …";
  try {
    const data = await api("api/files" + (rescan ? "?rescan=1" : ""));
    state.files = data.files;
    fillFolders();
    render();
  } catch (e) {
    $("#status").textContent = "Fehler: " + e.message;
  }
}

async function loadTrash() {
  try { state.trash = (await api("api/trash")).items; } catch (e) { toast(e.message, true); }
  render();
}

function fillFolders() {
  const folders = [...new Set(state.files.map((f) => f.folder))].sort((a, b) => a.localeCompare(b, "de"));
  const sel = $("#folder");
  const cur = sel.value;
  sel.replaceChildren(h("option", { value: "" }, "Alle Ordner"),
    ...folders.map((f) => h("option", { value: f }, f || "(Hauptordner)")));
  sel.value = folders.includes(cur) ? cur : "";
  state.folder = sel.value;
  $("#folder").hidden = folders.length < 2;
}

function allTags() {
  const counts = new Map();
  for (const f of state.files) for (const t of f.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));
}

// ------------------------------------------------------------------ filtern
function filtered() {
  const terms = norm(state.search).split(/\s+/).filter(Boolean);
  let list = state.view === "trash" ? state.trash : state.files;
  if (state.view === "new") list = list.filter((f) => f.new);
  if (state.view === "untagged") list = list.filter((f) => !f.tags.length);
  if (state.view !== "trash") {
    if (state.folder) list = list.filter((f) => f.folder === state.folder || f.folder.startsWith(state.folder + "/"));
    if (state.tagFilter.size) list = list.filter((f) => [...state.tagFilter].every((t) => f.tags.includes(t)));
  }
  if (terms.length) {
    list = list.filter((f) => {
      const hay = norm(f.path + " " + f.tags.join(" "));
      return terms.every((t) => hay.includes(t));
    });
  }
  if (state.view === "trash") return list;
  const [key, dir] = state.sort.split("-");
  const mul = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) =>
    key === "name" ? mul * a.name.localeCompare(b.name, "de", { numeric: true }) : mul * (a[key] - b[key]));
}

// ------------------------------------------------------------------ render
function render() {
  const isTrash = state.view === "trash";
  const counts = {
    all: state.files.length,
    new: state.files.filter((f) => f.new).length,
    untagged: state.files.filter((f) => !f.tags.length).length,
    trash: state.trash.length || "",
  };
  for (const b of document.querySelectorAll("#views button")) {
    b.classList.toggle("active", b.dataset.view === state.view);
    b.querySelector("span").textContent = counts[b.dataset.view];
  }
  $("#controls").hidden = isTrash;
  $("#btnSelect").classList.toggle("active", state.selectMode);

  renderSideTags();

  const list = filtered();
  const shown = list.slice(0, state.limit);
  $("#status").textContent = isTrash
    ? `${list.length} Datei(en) im Papierkorb`
    : `${list.length} von ${state.files.length} PDFs` + (state.tagFilter.size ? ` · Tags: ${[...state.tagFilter].join(", ")}` : "");
  $("#list").replaceChildren(...shown.map(isTrash ? trashTile : fileTile));
  if (!list.length) $("#list").append(h("li", { class: "empty" }, isTrash ? "Papierkorb ist leer." : "Keine PDFs gefunden."));
  $("#btnMore").hidden = list.length <= state.limit;
  $("#btnMore").textContent = `Mehr anzeigen (${list.length - state.limit} weitere)`;
  renderBulk();
}

function renderSideTags() {
  const tags = allTags();
  $("#tagList").replaceChildren(...tags.map(([t]) => h("option", { value: t })));
  $("#tagReset").hidden = !state.tagFilter.size;
  const q = norm(state.tagSearch);
  const items = tags.filter(([t]) => !q || norm(t).includes(q) || state.tagFilter.has(t));
  $("#tagbar").replaceChildren(...items.map(([t, n]) => h("li", {},
    h("button", {
      class: state.tagFilter.has(t) ? "on" : "",
      onclick: () => {
        state.tagFilter.has(t) ? state.tagFilter.delete(t) : state.tagFilter.add(t);
        if (state.view === "trash" || state.view === "untagged") state.view = "all";
        state.limit = PAGE_SIZE;
        render();
      },
    }, h("i", { class: "dot", style: `--tc: ${tagColor(t)}` }), h("span", {}, t), h("small", {}, String(n))))));
  if (!items.length) $("#tagbar").append(h("li", { class: "none" }, tags.length ? "Kein Treffer" : "Noch keine Tags vergeben"));
}

function thumbEl(f) {
  const img = h("img", { src: `thumb/${enc(f.path)}?v=${f.mtime}`, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => clientThumb(img, f), { once: true });
  return img;
}

function fileTile(f) {
  const sel = state.selected.has(f.path);
  return h("li", {
    class: "tile" + (sel ? " sel" : ""), title: f.path,
    onclick: () => state.selectMode ? toggleSelect(f.path) : openViewer(f),
  },
    h("div", { class: "thumb" },
      thumbEl(f),
      state.selectMode ? h("input", { type: "checkbox", class: "chk", checked: sel, tabindex: -1 })
        : f.new ? h("span", { class: "badge" }, "NEU") : null,
      state.selectMode ? null : h("button", {
        class: "opt", title: "Tags & Details", "aria-label": "Tags und Details",
        onclick: (e) => { e.stopPropagation(); openDetail(f); },
      }, "⋯")),
    h("div", { class: "tinfo" },
      h("div", { class: "name" }, f.name),
      h("p", { class: "meta" }, [fmtDate(f.mtime), fmtSize(f.size), f.folder].filter(Boolean).join(" · ")),
      f.tags.length ? h("div", { class: "tags" }, f.tags.map((t) => tagChip(t))) : null));
}

function trashTile(f) {
  return h("li", { class: "tile", title: f.path, onclick: () => openViewer(f) },
    h("div", { class: "thumb" }, h("span", { class: "ph" }, "PDF")),
    h("div", { class: "tinfo" },
      h("div", { class: "name" }, f.name),
      h("p", { class: "meta" }, `gelöscht ${fmtDate(f.deleted_at)} · ${f.folder || "/"}`),
      f.tags.length ? h("div", { class: "tags" }, f.tags.map((t) => tagChip(t))) : null,
      h("button", {
        class: "btn small", onclick: async (e) => {
          e.stopPropagation();
          try {
            const r = await api("api/restore", { id: f.id });
            toast("Wiederhergestellt: " + r.path);
            await Promise.all([loadTrash(), load()]);
          } catch (err) { toast(err.message, true); }
        },
      }, "Wiederherstellen")));
}

// ------------------------------------------------------------------ Vorschau im Browser
// Fallback, wenn der Server kein Vorschaubild liefern kann (kein pdftoppm installiert)
const thumbQueue = [];
let thumbBusy = 0;

function clientThumb(img, f) {
  thumbQueue.push({ img, f });
  pumpThumbs();
}

async function pumpThumbs() {
  while (thumbBusy < 2 && thumbQueue.length) {
    const { img, f } = thumbQueue.shift();
    if (!img.isConnected) continue;
    thumbBusy++;
    renderThumb(img, f).finally(() => { thumbBusy--; pumpThumbs(); });
  }
}

async function renderThumb(img, f) {
  try {
    const lib = await getPdfjs();
    const doc = await lib.getDocument({ url: fileUrl(f), disableAutoFetch: true, disableStream: true }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: THUMB_WIDTH / page.getViewport({ scale: 1 }).width });
    const canvas = h("canvas", { width: Math.floor(vp.width), height: Math.floor(vp.height) });
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    doc.destroy();
    const data = canvas.toDataURL("image/jpeg", 0.75);
    img.src = data;
    api("api/thumb", { path: f.path, data }).catch(() => {});
  } catch {
    img.replaceWith(h("span", { class: "ph" }, "PDF"));
  }
}

// ------------------------------------------------------------------ Seitenleiste
function setSide(open, remember = true) {
  document.body.classList.toggle("side-closed", !open);
  if (remember && !narrow()) store.set("side", open ? "open" : "closed");
}
setSide(!narrow() && store.get("side") !== "closed", false);
$("#btnSide").addEventListener("click", () => setSide(document.body.classList.contains("side-closed")));
$("#sideBackdrop").addEventListener("click", () => setSide(false, false));
$("#tagSearch").addEventListener("input", (e) => { state.tagSearch = e.target.value; renderSideTags(); });
$("#tagReset").addEventListener("click", () => { state.tagFilter.clear(); state.limit = PAGE_SIZE; render(); });
$("#views").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.view = b.dataset.view;
  state.limit = PAGE_SIZE;
  if (narrow()) setSide(false, false);
  if (state.view === "trash") { setSelectMode(false); loadTrash(); } else render();
});

// ------------------------------------------------------------------ Auswahl
function toggleSelect(p) {
  state.selected.has(p) ? state.selected.delete(p) : state.selected.add(p);
  render();
}
function renderBulk() {
  $("#bulkbar").hidden = !state.selectMode;
  $("#bulkCount").textContent = `${state.selected.size} ausgewählt`;
  $("#bulkTag").disabled = $("#bulkTrash").disabled = !state.selected.size;
}
function setSelectMode(on) {
  state.selectMode = on;
  state.selected.clear();
  render();
}

// ------------------------------------------------------------------ Detail
const detail = $("#detail");

function openDetail(f) {
  state.current = f;
  renderDetail();
  $("#dView").textContent = viewerOpen() ? "Zurück zum PDF" : "Ansehen";
  detail.showModal();
}

function renderDetail() {
  const f = state.current;
  $("#dName").textContent = f.name;
  $("#dMeta").textContent = [f.folder, fmtDate(f.mtime), fmtSize(f.size)].filter(Boolean).join(" · ");
  $("#dTags").replaceChildren(...f.tags.map((t) =>
    tagChip(t, h("button", { class: "x", "aria-label": `${t} entfernen`, onclick: () => saveTags(f.tags.filter((x) => x !== t)) }, "×"))));
  const have = new Set(f.tags.map(norm));
  $("#dSuggest").replaceChildren(...allTags().filter(([t]) => !have.has(norm(t))).slice(0, 15)
    .map(([t]) => h("button", { class: "tag", style: `--tc: ${tagColor(t)}`, onclick: () => saveTags([...f.tags, t]) }, t)));
}

async function saveTags(tags) {
  const f = state.current;
  try {
    const r = await api("api/tags", { path: f.path, tags });
    f.tags = r.tags; f.new = false;
    renderDetail(); render();
  } catch (e) { toast(e.message, true); }
}

$("#dTagForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("#dTagInput");
  const vals = inp.value.split(",").map((s) => s.trim()).filter(Boolean);
  inp.value = "";
  if (vals.length) saveTags([...state.current.tags, ...vals]);
});

$("#dView").addEventListener("click", () => {
  detail.close();
  if (!viewerOpen()) openViewer(state.current);
});

$("#dRename").addEventListener("click", async () => {
  const f = state.current;
  const name = prompt("Neuer Dateiname:", f.name);
  if (!name || name.trim() === f.name) return;
  try {
    const r = await api("api/rename", { path: f.path, name: name.trim() });
    f.path = r.path; f.name = r.path.split("/").pop();
    renderDetail(); render();
    if (viewerOpen() && viewer.item === f) { $("#vTitle").textContent = f.name; $("#vOpen").href = fileUrl(f); }
    toast("Umbenannt");
  } catch (e) { toast(e.message, true); }
});

$("#dTrash").addEventListener("click", async () => {
  const f = state.current;
  if (!confirm(`„${f.name}“ in den Papierkorb verschieben?`)) return;
  detail.close();
  if (viewerOpen() && viewer.item === f) closeViewer();
  await trash([f.path]);
});

// Klick auf Hintergrund schließt Dialog
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

async function trash(paths) {
  try {
    await api("api/trash", { paths });
    const gone = new Set(paths);
    state.files = state.files.filter((f) => !gone.has(f.path));
    for (const p of paths) state.selected.delete(p);
    render();
    toast(paths.length === 1 ? "In den Papierkorb verschoben" : `${paths.length} Dateien in den Papierkorb verschoben`);
  } catch (e) { toast(e.message, true); load(); }
}

// ------------------------------------------------------------------ Bulk
const bulkDlg = $("#bulkDlg");
$("#bulkTag").addEventListener("click", () => {
  $("#bCount").textContent = state.selected.size;
  $("#bSuggest").replaceChildren(...allTags().slice(0, 20).map(([t]) =>
    h("button", { class: "tag", style: `--tc: ${tagColor(t)}`, onclick: () => bulkTags([t], []) }, t)));
  bulkDlg.showModal();
});
$("#bForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const vals = $("#bInput").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!vals.length) return;
  const remove = e.submitter?.dataset.act === "remove";
  $("#bInput").value = "";
  bulkTags(remove ? [] : vals, remove ? vals : []);
});
async function bulkTags(add, remove) {
  try {
    await api("api/bulk-tags", { paths: [...state.selected], add, remove });
    bulkDlg.close();
    toast(add.length ? `Tag „${add.join(", ")}“ hinzugefügt` : `Tag „${remove.join(", ")}“ entfernt`);
    await load();
  } catch (e) { toast(e.message, true); }
}
$("#bulkTrash").addEventListener("click", async () => {
  const n = state.selected.size;
  if (confirm(`${n} Datei(en) in den Papierkorb verschieben?`)) await trash([...state.selected]);
});
$("#bulkAll").addEventListener("click", () => {
  const list = filtered();
  const all = list.every((f) => state.selected.has(f.path));
  for (const f of list) all ? state.selected.delete(f.path) : state.selected.add(f.path);
  render();
});
$("#bulkCancel").addEventListener("click", () => setSelectMode(false));
$("#btnSelect").addEventListener("click", () => setSelectMode(!state.selectMode));

// ------------------------------------------------------------------ Viewer (Overlay, pdf.js)
const viewer = { doc: null, item: null, list: [], zoom: 1, observer: null, token: 0 };
const viewerOpen = () => !$("#viewer").hidden;

function openViewer(f) {
  if (!viewerOpen()) {
    $("#viewer").hidden = false;
    document.body.classList.add("noscroll");
    history.pushState({ viewer: true }, "");
  }
  viewer.list = filtered();
  showInViewer(f);
}

async function showInViewer(f) {
  const token = ++viewer.token;
  viewer.observer?.disconnect();
  viewer.doc?.destroy();
  viewer.doc = null;
  viewer.item = f;
  viewer.zoom = 1;
  const idx = viewer.list.indexOf(f);
  $("#vPrev").disabled = idx <= 0;
  $("#vNext").disabled = idx < 0 || idx >= viewer.list.length - 1;
  $("#vInfo").hidden = !!f.trash_path;
  $("#vTitle").textContent = f.name;
  $("#vOpen").href = fileUrl(f);
  $("#vPage").textContent = "";
  $("#vPages").replaceChildren(h("div", { class: "msg" }, "Lade PDF …"));
  if (f.new) { f.new = false; api("api/seen", { path: f.path }).catch(() => {}); render(); }
  try {
    const lib = await getPdfjs();
    const doc = await lib.getDocument({ url: fileUrl(f), disableAutoFetch: true, disableStream: true }).promise;
    if (token !== viewer.token) return doc.destroy();
    viewer.doc = doc;
    await layoutPages();
  } catch (e) {
    if (token !== viewer.token) return;
    $("#vPages").replaceChildren(h("div", { class: "msg" }, "PDF konnte nicht angezeigt werden (" + e.message + "). ",
      h("a", { href: fileUrl(f), target: "_blank" }, "Direkt öffnen")));
  }
}

async function layoutPages() {
  const doc = viewer.doc, box = $("#vPages");
  viewer.observer?.disconnect();
  const first = await doc.getPage(1);
  const baseW = Math.min(box.clientWidth - 24, 1000) * viewer.zoom;
  const vp1 = first.getViewport({ scale: 1 });
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const el = h("div", { class: "page", "data-n": i });
    el.style.width = baseW + "px";
    el.style.height = (baseW * vp1.height / vp1.width) + "px";
    pages.push(el);
  }
  box.replaceChildren(...pages);
  box.scrollTop = 0;
  $("#vPage").textContent = `1 / ${doc.numPages}`;
  viewer.observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting && !en.target.dataset.done) renderPage(en.target, baseW);
  }, { root: box, rootMargin: "800px 0px" });
  pages.forEach((p) => viewer.observer.observe(p));
}

async function renderPage(el, width) {
  el.dataset.done = "1";
  const doc = viewer.doc;
  const page = await doc.getPage(+el.dataset.n);
  if (doc !== viewer.doc) return;
  const vp0 = page.getViewport({ scale: 1 });
  const scale = width / vp0.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const vp = page.getViewport({ scale: scale * dpr });
  const canvas = h("canvas", { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  el.style.height = (vp0.height * scale) + "px";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  el.replaceChildren(canvas);
}

function closeViewer(fromPop = false) {
  if (!viewerOpen()) return;
  $("#viewer").hidden = true;
  viewer.token++;
  viewer.observer?.disconnect();
  viewer.doc?.destroy();
  viewer.doc = null;
  $("#vPages").replaceChildren();
  document.body.classList.remove("noscroll");
  if (!fromPop && history.state?.viewer) history.back();
}

function step(d) {
  const next = viewer.list[viewer.list.indexOf(viewer.item) + d];
  if (next) showInViewer(next);
}

function zoom(f) {
  if (!viewer.doc) return;
  const box = $("#vPages");
  const rel = box.scrollTop / (box.scrollHeight || 1);
  viewer.zoom = Math.max(0.5, Math.min(4, viewer.zoom * f));
  layoutPages().then(() => (box.scrollTop = rel * box.scrollHeight));
}

$("#vClose").addEventListener("click", () => closeViewer());
$("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") closeViewer(); });
$("#vIn").addEventListener("click", () => zoom(1.25));
$("#vOut").addEventListener("click", () => zoom(0.8));
$("#vPrev").addEventListener("click", () => step(-1));
$("#vNext").addEventListener("click", () => step(1));
$("#vInfo").addEventListener("click", () => openDetail(viewer.item));
window.addEventListener("popstate", () => closeViewer(true));
$("#vPages").addEventListener("scroll", () => {
  if (!viewer.doc) return;
  const box = $("#vPages"), mid = box.scrollTop + box.clientHeight / 3;
  let n = 1;
  for (const p of box.children) { if (p.offsetTop <= mid) n = +p.dataset.n; else break; }
  $("#vPage").textContent = `${n} / ${viewer.doc.numPages}`;
}, { passive: true });
document.addEventListener("keydown", (e) => {
  if (!viewerOpen() || detail.open || e.target.matches("input")) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "+") zoom(1.25);
  else if (e.key === "-") zoom(0.8);
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
});

// ------------------------------------------------------------------ Steuerung
let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value; state.limit = PAGE_SIZE; render(); }, 150);
});
$("#folder").addEventListener("change", (e) => { state.folder = e.target.value; state.limit = PAGE_SIZE; render(); });
$("#sort").value = state.sort;
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  store.set("sort", state.sort);
  render();
});
$("#btnMore").addEventListener("click", () => { state.limit += PAGE_SIZE; render(); });
$("#btnRescan").addEventListener("click", () => state.view === "trash" ? loadTrash() : load(true));

load();
api("api/trash").then((d) => { state.trash = d.items; render(); }).catch(() => {});
