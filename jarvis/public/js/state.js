// Shared client state. Views re-read from here after settings change.
export const state = {
  user: null,
  settings: null,
  ai: null,
  unread: 0,
};

const listeners = new Set();
export const onState = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const emit = (what) => listeners.forEach((fn) => fn(what));
