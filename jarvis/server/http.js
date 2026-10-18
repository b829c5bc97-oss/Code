export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Validate with a zod schema; throw a 400 with field-level messages on failure. */
export function parseBody(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw new HttpError(400, first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid input.', issues);
  }
  return r.data;
}

export function notFound(what = 'Item') {
  return new HttpError(404, `${what} not found.`);
}

/** Wrap an async route handler so rejections reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
