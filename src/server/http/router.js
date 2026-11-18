"use strict";

// Minimal router with the same matching order and middleware chain as the
// routes were written against, so handlers keep their (req, res, next) form.
function compile(path) {
  const keys = [];
  const source = path
    .replace(/\/+$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+?)";
    });
  return { regex: new RegExp(`^${source}/?$`, "i"), keys };
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error("Failed to decode URL parameter");
    error.status = 400;
    throw error;
  }
}

function Router() {
  const routes = [];
  const router = {};

  for (const method of ["get", "post", "put", "patch", "delete"]) {
    router[method] = (path, ...handlers) => {
      routes.push({ method: method.toUpperCase(), ...compile(path), handlers: handlers.flat() });
      return router;
    };
  }

  router.handle = (req, res, done, pathname) => {
    let routeIndex = 0;

    const nextRoute = error => {
      if (error) return done(error);
      while (routeIndex < routes.length) {
        const route = routes[routeIndex++];
        if (route.method !== req.method) continue;
        const match = route.regex.exec(pathname);
        if (!match) continue;
        try {
          req.params = Object.fromEntries(route.keys.map((key, index) => [key, decode(match[index + 1])]));
        } catch (decodeError) {
          return done(decodeError);
        }
        return runHandlers(route.handlers, req, res, nextRoute);
      }
      return done();
    };

    nextRoute();
  };

  return router;
}

function runHandlers(handlers, req, res, done) {
  let index = 0;
  const next = error => {
    if (error) return done(error);
    const handler = handlers[index++];
    if (!handler) return done();
    try {
      const result = handler(req, res, next);
      if (result && typeof result.catch === "function") result.catch(done);
    } catch (handlerError) {
      done(handlerError);
    }
  };
  next();
}

module.exports = { Router };
