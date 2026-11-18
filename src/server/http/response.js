"use strict";

const { PassThrough, Readable } = require("node:stream");

// Writable response used by route handlers. Handlers may answer with json/send
// or stream into it (CSV and PDF exports); the Web Response is created when the
// first byte is written, so status and headers can still change until then.
class ApiResponse extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Headers();
    this.committed = false;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
  }

  get headersSent() {
    return this.committed;
  }

  commit() {
    if (this.committed) return;
    this.committed = true;
    const emptyBody = [204, 304].includes(this.statusCode);
    if (emptyBody) this.resume();
    this.resolveReady(new Response(emptyBody ? null : Readable.toWeb(this), { status: this.statusCode, headers: this.headers }));
  }

  _transform(chunk, encoding, callback) {
    this.commit();
    callback(null, chunk);
  }

  _flush(callback) {
    this.commit();
    callback();
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    return this;
  }

  getHeader(name) {
    return this.headers.get(name) ?? undefined;
  }

  removeHeader(name) {
    this.headers.delete(name);
  }

  json(body) {
    if (!this.headers.has("Content-Type")) this.setHeader("Content-Type", "application/json; charset=utf-8");
    this.end(JSON.stringify(body));
    return this;
  }

  send(body) {
    this.end(body);
    return this;
  }
}

module.exports = { ApiResponse };
