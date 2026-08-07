/* ============================================================
   toast.js — 轻提示
   ============================================================ */

import { h, icon } from '../util.js';

const ICONS = {
  ok: '<path d="M20 6L9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
  warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8v.01"/>',
};

let root = null;

export function toast(msg, type = 'info', ms = 2600) {
  root ||= document.getElementById('toast-root');
  if (!root) return () => {};

  const el = h(`div.toast.toast-${type}`, { role: 'status' }, icon(ICONS[type] || ICONS.info), h('span', msg));
  root.append(el);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  const timer = setTimeout(close, ms);
  return () => {
    clearTimeout(timer);
    close();
  };
}

export const toastOk = (m, ms) => toast(m, 'ok', ms);
export const toastError = (m, ms) => toast(m, 'error', ms ?? 4000);
export const toastWarn = (m, ms) => toast(m, 'warn', ms ?? 3400);
