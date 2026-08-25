import { Router } from 'express';

// ═══════════════════════════════════════════════════════════════════════════
// Express 4 does not catch rejections from `async` route handlers: an
// unhandled rejection terminates the process. A single malformed request —
// e.g. a non-integer :itemId reaching a query — would take the whole API down.
//
// This patches the Router prototype once, at startup, so every async handler
// registered anywhere in the app forwards its rejection to `next(err)` and
// lands in the central error handler instead of killing the server.
// ═══════════════════════════════════════════════════════════════════════════
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function wrap(fn) {
  // Only wrap route handlers, not routers/arrays passed to .use().
  if (typeof fn !== 'function' || fn.length > 3) return fn;
  const wrapped = function (req, res, next) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
      return out;
    } catch (err) {
      next(err);
      return undefined;
    }
  };
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  return wrapped;
}

// `router.param` handlers take FOUR arguments (req, res, next, value), so the
// wrap() above deliberately skips them — and an async param handler that
// rejects would take the process down exactly like an unwrapped route. Param
// handlers run before every matching route, so this is the worst place to
// leave unguarded.
function wrapParam(fn) {
  if (typeof fn !== 'function') return fn;
  return function (req, res, next, value, name) {
    try {
      const out = fn.call(this, req, res, next, value, name);
      if (out && typeof out.then === 'function') out.catch(next);
      return out;
    } catch (err) {
      next(err);
      return undefined;
    }
  };
}

let patched = false;
export function enableAsyncRouteSafety() {
  if (patched) return;
  patched = true;
  const proto = Router;
  for (const method of METHODS) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function (...args) {
      return original.apply(this, args.map((a) => (typeof a === 'function' ? wrap(a) : a)));
    };
  }
  const originalParam = proto.param;
  if (typeof originalParam === 'function') {
    proto.param = function (name, fn) {
      return typeof fn === 'function'
        ? originalParam.call(this, name, wrapParam(fn))
        : originalParam.apply(this, arguments);
    };
  }
}

// Applied at import time. ES module imports are hoisted and evaluated in
// order, so importing this module before any route module guarantees every
// router is created through the patched prototype.
enableAsyncRouteSafety();

// Rejects a request early when a route parameter that must be a positive
// integer is not one, rather than letting Postgres raise a type error.
export function requireIntParams(...names) {
  return (req, res, next) => {
    for (const name of names) {
      const raw = req.params[name];
      if (!/^\d+$/.test(String(raw ?? ''))) {
        return res.status(400).json({ error: `Invalid ${name}` });
      }
    }
    next();
  };
}
