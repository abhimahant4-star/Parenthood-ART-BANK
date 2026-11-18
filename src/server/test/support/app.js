"use strict";

// Lets the integration tests drive the real API over a local HTTP socket.
const http = require("node:http");
const { Readable } = require("node:stream");
const { handleApiRequest } = require("../../http/app");

async function nodeHandler(req, res) {
  const origin = `http://${req.headers.host || "127.0.0.1"}`;
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  const request = new Request(new URL(req.url, origin), {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {})
  });
  const response = await handleApiRequest(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

function app(req, res) {
  nodeHandler(req, res).catch(error => {
    res.statusCode = 500;
    res.end(error.message);
  });
}
app.listen = (...args) => http.createServer(app).listen(...args);

// Serves one router on its own, for tests that inject replacement services.
function routerServer(prefix, router) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    };
    const shim = {
      status(code) { res.statusCode = code; return shim; },
      json(body) { send(res.statusCode, body); return shim; },
      setHeader: (...args) => res.setHeader(...args)
    };
    const request = { method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), params: {}, body: text ? JSON.parse(text) : {}, ip: "local" };
    router.handle(request, shim, error => {
      if (error) return send(error.status || 500, { success: false, message: error.message });
      return send(404, { success: false, errorCode: "NOT_FOUND" });
    }, url.pathname.slice(prefix.length) || "/");
  });
}

module.exports = app;
module.exports.routerServer = routerServer;
