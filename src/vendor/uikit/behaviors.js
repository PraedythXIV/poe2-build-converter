// ui-component-library — js/behaviors.js
// The OPT-IN interaction layer. Sibling of preview/drivers.js (motion): where
// drivers.js animates `data-drive` elements, behaviors.js makes `data-behavior`
// elements *work* — keyboard nav, focus management, ARIA state — to the WAI-ARIA
// APG patterns. Framework-agnostic, zero-dependency, tree-shakeable, idempotent.
//
//   import { mountBehaviors } from "./js/behaviors.js";
//   mountBehaviors();                 // wire everything under document
//   mountBehaviors(someContainer);    // …or a subtree (call after markup is in the DOM)
//
// The components are already authored to ARIA contracts and style off ARIA state
// (e.g. .ac-hd[aria-expanded="true"] + .ac-panel, .tb-tab[aria-selected="true"],
// .lo-opt[aria-selected="true"]), so these behaviors only TOGGLE the attributes the
// markup already declares — they don't inject styling. You own data/validation/
// business logic; this owns the interaction mechanics.
//
// Opt in by adding a data-behavior token to the container:
//   data-behavior="tabs | tablist | menu | dialog | accordion | combobox | otp | validate | stepper"
// (space-separated to combine). Dialog triggers use data-dialog-open="<dialog id>".
//
// VENDORED VERBATIM into poe2-build-planner (src/vendor/uikit/) — copied, not linked, like the
// CSS subset. The app uses ONLY the `dialog`, `accordion` and `tablist` behaviors (`tablist` is
// the nav-only roving strip this app's own wiring was backported into the library as — the
// panel-owning `tabs`/`stepper` would break the routing-coupled nav, and the lock/error
// step-router keeps its hand-rolled wiring in main.ts). Re-vendor from canonical js/behaviors.js
// to update.

const qsa = (el, s) => (el ? [...el.querySelectorAll(s)] : []);
const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),details>summary:first-of-type,[contenteditable="true"]';
const focusablesIn = (el) => qsa(el, FOCUSABLE).filter((e) => e.offsetParent !== null || e.getClientRects().length);
const isVisible = (el) => !el.hidden && el.getClientRects().length > 0;
// one-time guard per element+behavior so mountBehaviors() is safe to call repeatedly
const once = (el, key) => { const k = "bh_" + key; if (el.dataset[k]) return false; el.dataset[k] = "1"; return true; };
const scrollNearest = (el) => { try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* jsdom */ } };
let _uid = 0;
const ensureId = (f) => (f.id || (f.id = "bh-f" + ++_uid));
// ONE shared document listener closes any open menu/combobox whose root doesn't
// contain the pointer target — avoids a per-instance listener leak on teardown.
let _outsideBound = false;
function ensureOutsideClose() {
  if (_outsideBound) return; _outsideBound = true;
  document.addEventListener("pointerdown", (e) => {
    for (const w of document.querySelectorAll('[data-behavior~="menu"],[data-behavior~="combobox"]'))
      if (w._closeOutside) w._closeOutside(e.target);
  });
}
// modal containment: inert + aria-hidden everything outside `keep` (and its
// ancestors); revert only what we set (data-bh-inert marker) so we never clobber
// a pre-existing aria-hidden/inert.
function backgroundInert(keep, on) {
  let el = keep;
  while (el && el !== document.body) {
    const parent = el.parentElement; if (!parent) break;
    for (const sib of parent.children) {
      if (sib === el || sib.contains(keep)) continue;
      if (on) { if (!sib.hasAttribute("data-bh-inert")) { sib.setAttribute("data-bh-inert", ""); sib.setAttribute("aria-hidden", "true"); sib.inert = true; } }
      else if (sib.hasAttribute("data-bh-inert")) { sib.removeAttribute("data-bh-inert"); sib.removeAttribute("aria-hidden"); sib.inert = false; }
    }
    el = parent;
  }
}

// ── tabs (APG tablist: roving tabindex, arrows, automatic activation) ─────────
export function tabs(root) {
  if (!once(root, "tabs")) return;
  const list = root.matches('[role="tablist"]') ? root : root.querySelector('[role="tablist"]');
  if (!list) return;
  const tabEls = () => qsa(list, '[role="tab"]').filter((t) => t.getAttribute("aria-disabled") !== "true" && !t.disabled);
  const vertical = list.getAttribute("aria-orientation") === "vertical";
  const panelOf = (t) => { const id = t.getAttribute("aria-controls"); return id && root.ownerDocument.getElementById(id); };
  function select(t, focus = true) {
    for (const x of tabEls()) {
      const on = x === t;
      x.setAttribute("aria-selected", on ? "true" : "false");
      x.tabIndex = on ? 0 : -1;
      const p = panelOf(x); if (p) p.hidden = !on;
    }
    if (focus) t.focus();
  }
  const all = tabEls(); if (!all.length) return;
  let cur = all.find((t) => t.getAttribute("aria-selected") === "true") || all[0];
  select(cur, false);
  list.addEventListener("keydown", (e) => {
    const items = tabEls(); const i = items.indexOf(document.activeElement); if (i < 0) return;
    const prev = vertical ? "ArrowUp" : "ArrowLeft", next = vertical ? "ArrowDown" : "ArrowRight";
    let j = -1;
    if (e.key === next) j = (i + 1) % items.length;
    else if (e.key === prev) j = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = items.length - 1;
    if (j < 0) return;
    e.preventDefault(); select(items[j]);
  });
  list.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t && list.contains(t)) select(t); });
}

// ── tablist (NAV-ONLY roving variant of tabs: app-owned activation) ───────────
// For tab strips whose selection/panels the APP owns (`tabs` owns its panels).
// Arrows rove focus and forward activation through the tab's own click handler;
// this behavior never writes aria-selected and never touches a panel.
export function tablist(root) {
  if (!once(root, "tablist")) return;
  const list = root.matches('[role="tablist"]') ? root : root.querySelector('[role="tablist"]');
  if (!list) return;
  // hidden/disabled tabs are not nav stops (apps hide tabs contextually, e.g. mode gating)
  const tabEls = () => qsa(list, '[role="tab"]').filter((t) => !t.hidden && !t.disabled && t.getAttribute("aria-disabled") !== "true");
  const vertical = list.getAttribute("aria-orientation") === "vertical";
  // roving tabindex derived from the APP's aria-selected — the selected tab is the one tab stop
  const rove = () => { for (const t of tabEls()) t.tabIndex = t.getAttribute("aria-selected") === "true" ? 0 : -1; };
  rove();
  list.addEventListener("keydown", (e) => {
    const items = tabEls(); const i = items.indexOf(document.activeElement); if (i < 0) return;
    const prev = vertical ? "ArrowUp" : "ArrowLeft", next = vertical ? "ArrowDown" : "ArrowRight";
    let j = -1;
    if (e.key === next) j = (i + 1) % items.length;
    else if (e.key === prev) j = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = items.length - 1;
    if (j < 0) return;
    e.preventDefault(); items[j].focus(); items[j].click();
  });
  // the app's click handler flips aria-selected first (registered earlier) — re-derive the tab stop
  list.addEventListener("click", rove);
}

// ── menu (APG menu button: open/close, roving items, type-ahead-free arrows) ──
export function menu(root) {
  if (!once(root, "menu")) return;
  const trigger = root.querySelector('[aria-haspopup="menu"],[data-menu-trigger]');
  const menuEl = root.querySelector('[role="menu"]');
  if (!trigger || !menuEl) return;
  const items = () => qsa(menuEl, '[role^="menuitem"]').filter((x) => x.getAttribute("aria-disabled") !== "true" && isVisible(x));
  const setOpen = (open, focusItem = true) => {
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    menuEl.hidden = !open;
    if (open) { const it = items(); it.forEach((x, k) => (x.tabIndex = k === 0 ? 0 : -1)); if (focusItem && it[0]) it[0].focus(); }
  };
  const isOpen = () => trigger.getAttribute("aria-expanded") === "true";
  setOpen(false, false);
  trigger.addEventListener("click", (e) => { e.preventDefault(); setOpen(!isOpen()); });
  trigger.addEventListener("keydown", (e) => {
    if (["ArrowDown", "Enter", " "].includes(e.key)) { e.preventDefault(); setOpen(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setOpen(true); const it = items(); it[it.length - 1]?.focus(); }
  });
  menuEl.addEventListener("keydown", (e) => {
    const it = items(); const i = it.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false, false); trigger.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); it[(i + 1) % it.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); it[(i - 1 + it.length) % it.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); it[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); it[it.length - 1]?.focus(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); document.activeElement?.click(); } // activate non-button menuitems (Space also avoids page scroll)
    else if (e.key === "Tab") { setOpen(false, false); }
  });
  menuEl.addEventListener("click", (e) => { const mi = e.target.closest('[role^="menuitem"]'); if (mi && mi.getAttribute("aria-disabled") !== "true") setOpen(false, false), trigger.focus(); });
  root._closeOutside = (target) => { if (isOpen() && !root.contains(target)) setOpen(false, false); };
  ensureOutsideClose();
}

// ── dialog (modal: focus trap, Escape, restore focus, backdrop close) ────────
export function dialog(root) {
  if (!once(root, "dialog")) return;
  let opener = null, prevOverflow = "";
  const isOpen = () => root.classList.contains("open");
  const show = () => {
    if (isOpen()) return;                                   // guard: don't overwrite opener / re-inert
    opener = document.activeElement;
    root.hidden = false; root.classList.add("open");
    if (root.matches('[role="dialog"],[role="alertdialog"]')) root.setAttribute("aria-modal", "true");
    backgroundInert(root, true);                            // everything else inert + aria-hidden
    prevOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const f = focusablesIn(root);                           // pick a VISIBLE focus target
    const target = f.find((e) => e.hasAttribute("autofocus")) || f[0];
    if (target) target.focus(); else { root.tabIndex = -1; root.focus(); }
  };
  const hide = () => {
    if (!isOpen()) return;
    root.classList.remove("open"); root.hidden = true;
    backgroundInert(root, false); document.body.style.overflow = prevOverflow;
    if (opener && opener.focus) opener.focus();
  };
  root._dialog = { open: show, close: hide };
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); hide(); return; }
    if (e.key !== "Tab") return;
    const f = focusablesIn(root); if (!f.length) { e.preventDefault(); root.focus?.(); return; }
    const first = f[0], last = f[f.length - 1];
    // absolute trap: also re-capture if focus somehow escaped the dialog
    if (!root.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  qsa(root, "[data-dialog-close]").forEach((b) => b.addEventListener("click", hide));
  const backdrop = root.querySelector(".md-backdrop,[data-dialog-backdrop]");
  if (backdrop) backdrop.addEventListener("click", hide);
}
function wireDialogTrigger(btn) {
  if (!once(btn, "dlgtrigger")) return;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const dlg = btn.ownerDocument.getElementById(btn.getAttribute("data-dialog-open"));
    if (dlg && dlg._dialog) dlg._dialog.open();
  });
}

// ── accordion / disclosure (toggle aria-expanded + panel; optional single-open) ─
export function accordion(root) {
  if (!once(root, "accordion")) return;
  const single = root.getAttribute("data-accordion") === "single";
  const heads = () => qsa(root, "[aria-expanded][aria-controls]");
  const panelOf = (h) => root.ownerDocument.getElementById(h.getAttribute("aria-controls"));
  const setExpanded = (h, open) => { h.setAttribute("aria-expanded", open ? "true" : "false"); const p = panelOf(h); if (p) p.hidden = !open; };
  for (const h of heads()) { const p = panelOf(h); if (p) p.hidden = h.getAttribute("aria-expanded") !== "true"; }
  root.addEventListener("click", (e) => {
    const h = e.target.closest("[aria-expanded][aria-controls]"); if (!h || !root.contains(h)) return;
    const open = h.getAttribute("aria-expanded") !== "true";
    if (single && open) for (const o of heads()) if (o !== h) setExpanded(o, false);
    setExpanded(h, open);
  });
  root.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const hs = heads(); const i = hs.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault();
    const j = e.key === "ArrowDown" ? (i + 1) % hs.length : e.key === "ArrowUp" ? (i - 1 + hs.length) % hs.length : e.key === "Home" ? 0 : hs.length - 1;
    hs[j].focus();
  });
}

// ── combobox (APG editable combobox + listbox popup, aria-activedescendant) ──
export function combobox(root) {
  if (!once(root, "combobox")) return;
  const input = root.querySelector('[role="combobox"]');
  const listId = input && input.getAttribute("aria-controls");
  const list = listId && root.ownerDocument.getElementById(listId);
  if (!input || !list) return;
  const options = () => qsa(list, '[role="option"]').filter((o) => o.getAttribute("aria-disabled") !== "true" && isVisible(o));
  const setOpen = (open) => { input.setAttribute("aria-expanded", open ? "true" : "false"); list.hidden = !open; root.classList.toggle("is-open", open); if (!open) setActive(null); };
  const isOpen = () => input.getAttribute("aria-expanded") === "true";
  const setActive = (opt) => {
    for (const o of qsa(list, '[role="option"]')) o.setAttribute("aria-selected", o === opt ? "true" : "false");
    if (opt) { input.setAttribute("aria-activedescendant", opt.id); scrollNearest(opt); } else input.removeAttribute("aria-activedescendant");
  };
  const active = () => qsa(list, '[role="option"][aria-selected="true"]')[0];
  const choose = (opt) => { if (!opt) return; input.value = (opt.querySelector(".lo-label") || opt).textContent.trim(); setOpen(false); input.focus(); };
  const filter = () => { const q = input.value.trim().toLowerCase(); for (const o of qsa(list, '[role="option"]')) o.hidden = !!q && !o.textContent.toLowerCase().includes(q); };
  setOpen(false);
  input.addEventListener("input", () => { filter(); setOpen(true); const o = options(); setActive(o[0] || null); });
  input.addEventListener("keydown", (e) => {
    const o = options(); const cur = active(); const i = o.indexOf(cur);
    if (e.key === "ArrowDown") { e.preventDefault(); if (!isOpen()) setOpen(true); setActive(o[(i + 1) % o.length] || o[0]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (!isOpen()) setOpen(true); setActive(o[(i - 1 + o.length) % o.length] || o[o.length - 1]); }
    else if (e.key === "Enter" && isOpen() && cur) { e.preventDefault(); choose(cur); }
    else if (e.key === "Escape") { e.preventDefault(); if (isOpen()) setOpen(false); else { input.value = ""; filter(); } }
    else if (e.key === "Home" && isOpen()) { e.preventDefault(); setActive(o[0]); }
    else if (e.key === "End" && isOpen()) { e.preventDefault(); setActive(o[o.length - 1]); }
  });
  list.addEventListener("click", (e) => { const opt = e.target.closest('[role="option"]'); if (opt && opt.getAttribute("aria-disabled") !== "true") choose(opt); });
  const toggle = root.querySelector('[aria-label*="suggestion" i],[data-combobox-toggle]');
  if (toggle) toggle.addEventListener("click", () => { setOpen(!isOpen()); if (isOpen()) input.focus(); });
  root._closeOutside = (target) => { if (isOpen() && !root.contains(target)) setOpen(false); };
  ensureOutsideClose();
}

// ── otp (segmented code input: auto-advance, backspace, paste-distribute) ─────
// Generic (alphanumeric OK — set inputmode/pattern in your markup if numeric-only).
export function otp(root) {
  if (!once(root, "otp")) return;
  const boxes = qsa(root, "input"); if (!boxes.length) return;
  const setCurrent = (idx) => boxes.forEach((x, k) => { if (k === idx) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current"); });
  boxes.forEach((b, i) => {
    if (!b.maxLength || b.maxLength > 1) b.maxLength = 1;
    b.addEventListener("focus", () => setCurrent(i));
    b.addEventListener("input", () => {
      b.value = b.value.replace(/\s/g, "").slice(-1);
      if (b.value && i < boxes.length - 1) { boxes[i + 1].focus(); setCurrent(i + 1); } else setCurrent(i);
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !b.value && i > 0) { e.preventDefault(); boxes[i - 1].focus(); boxes[i - 1].value = ""; setCurrent(i - 1); }
      else if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
      else if (e.key === "ArrowRight" && i < boxes.length - 1) { e.preventDefault(); boxes[i + 1].focus(); }
    });
    b.addEventListener("paste", (e) => {
      e.preventDefault();
      const chars = ((e.clipboardData || window.clipboardData).getData("text") || "").replace(/\s/g, "").split("");
      let k = i; for (; k < boxes.length && chars.length; k++) boxes[k].value = chars.shift();
      const last = Math.min(k, boxes.length - 1); boxes[last].focus(); setCurrent(last);
    });
  });
}

// ── validate (native constraint validation → ARIA error wiring on submit/blur) ─
export function validate(root) {
  if (!once(root, "validate")) return;
  const form = root.matches("form") ? root : root.querySelector("form") || root;
  const fields = () => qsa(form, "input,select,textarea").filter((f) => f.willValidate);
  const errId = (f) => ensureId(f) + "-err";   // stable: assigns a one-time id if missing (never hashes mutated attrs)
  function setError(f, msg) {
    f.setAttribute("aria-invalid", "true");
    let id = errId(f), node = form.ownerDocument.getElementById(id);
    // reuse an existing described-by error node if the markup already wired one
    const existing = (f.getAttribute("aria-describedby") || "").split(/\s+/).map((x) => form.ownerDocument.getElementById(x)).find(Boolean);
    node = node || existing;
    if (!node) { node = form.ownerDocument.createElement("span"); node.id = id; node.className = "fm-note"; f.insertAdjacentElement("afterend", node); }
    node.id = node.id || id; node.setAttribute("role", "alert"); node.textContent = msg;
    const db = (f.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!db.includes(node.id)) { db.push(node.id); f.setAttribute("aria-describedby", db.join(" ")); }
  }
  function clearError(f) {
    f.setAttribute("aria-invalid", "false");
    const node = form.ownerDocument.getElementById(errId(f)); if (node) node.textContent = "";
  }
  const check = (f) => (f.checkValidity() ? (clearError(f), true) : (setError(f, f.validationMessage), false));
  form.setAttribute("novalidate", "");
  form.addEventListener("submit", (e) => {
    let ok = true, first = null;
    for (const f of fields()) { if (!check(f)) { ok = false; first = first || f; } }
    if (!ok) { e.preventDefault(); first && first.focus(); }
  });
  form.addEventListener("blur", (e) => { if (e.target.willValidate && e.target.getAttribute("aria-invalid")) check(e.target); }, true);
  form.addEventListener("input", (e) => { if (e.target.willValidate && e.target.getAttribute("aria-invalid") === "true") check(e.target); });
}

// ── stepper / wizard (prev/next over [data-step] panels + progress sync) ─────
export function stepper(root) {
  if (!once(root, "stepper")) return;
  const steps = qsa(root, "[data-step]"); if (!steps.length) return;
  const prevBtn = root.querySelector("[data-step-prev]"), nextBtn = root.querySelector("[data-step-next]");
  const bar = root.querySelector('[role="progressbar"]');
  const markers = qsa(root, ".sx-step,[data-step-marker]");
  let i = Math.max(0, steps.findIndex((s) => !s.hidden));
  function render() {
    steps.forEach((s, k) => (s.hidden = k !== i));
    if (prevBtn) prevBtn.disabled = i === 0;
    if (nextBtn) nextBtn.textContent = i === steps.length - 1 ? (nextBtn.dataset.finishLabel || "Finish") : (nextBtn.dataset.stepNext || nextBtn.textContent);
    if (bar) { bar.setAttribute("aria-valuenow", String(i + 1)); bar.setAttribute("aria-label", `Step ${i + 1} of ${steps.length}`); }
    markers.forEach((m, k) => { m.dataset.state = k < i ? "done" : k === i ? "current" : "upcoming"; m.toggleAttribute("aria-current", k === i); if (k === i) m.setAttribute("aria-current", "step"); });
  }
  const go = (d) => { const n = Math.min(steps.length - 1, Math.max(0, i + d)); if (n !== i) { i = n; render(); steps[i].focus?.(); } };
  prevBtn && prevBtn.addEventListener("click", () => go(-1));
  nextBtn && nextBtn.addEventListener("click", () => go(1));
  render();
}

const REGISTRY = { tabs, tablist, menu, dialog, accordion, combobox, otp, validate, stepper };

// Wire every [data-behavior] (+ dialog triggers) under `root`. Idempotent.
export function mountBehaviors(root = document) {
  const apply = (el) => {
    for (const name of el.dataset.behavior.split(/\s+/)) {
      const fn = REGISTRY[name];
      if (fn) { try { fn(el); } catch (err) { console.warn("[behaviors] " + name + " failed:", err); } }
    }
  };
  qsa(root, "[data-behavior]").forEach(apply);
  qsa(root, "[data-dialog-open]").forEach(wireDialogTrigger);
  // querySelectorAll never matches the root node itself — handle a root that IS the target
  if (root.matches) {
    if (root.matches("[data-behavior]")) apply(root);
    if (root.matches("[data-dialog-open]")) wireDialogTrigger(root);
  }
  return root;
}

export default mountBehaviors;
