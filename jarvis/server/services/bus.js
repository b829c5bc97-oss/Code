// In-process pub/sub used to push notifications to a user's open tabs over SSE.
const subscribers = new Map(); // userId -> Set<fn>

export function subscribe(userId, fn) {
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  subscribers.get(userId).add(fn);
  return () => {
    const set = subscribers.get(userId);
    set?.delete(fn);
    if (set && !set.size) subscribers.delete(userId);
  };
}

export function publish(userId, message) {
  for (const fn of subscribers.get(userId) || []) {
    try {
      fn(message);
    } catch {
      /* a broken stream must not break the publisher */
    }
  }
}
