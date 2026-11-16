// Dedicated server-to-server read endpoint. Never forwards to business APIs.
"use strict";
const { createHash, timingSafeEqual } = require("node:crypto");
const MAX_ROWS = 10000;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function authorized(value, secret) {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    typeof value !== "string"
  )
    return false;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  if (!match) return false;
  return timingSafeEqual(
    createHash("sha256").update(match[1]).digest(),
    createHash("sha256").update(secret).digest(),
  );
}
class InputError extends Error {}
function bad(message) {
  return new InputError(message);
}

function validateRequest(catalog, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["dataset", "filters", "q", "month"].includes(k),
    )
  )
    throw bad("Invalid query");
  if (typeof input.dataset !== "string" || !own(catalog, input.dataset))
    throw bad("Unknown dataset");
  const d = catalog[input.dataset],
    filters = input.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 12)
    throw bad("Too many filters");
  for (const f of filters) {
    if (
      !f ||
      typeof f !== "object" ||
      !own(d.fields, f.field) ||
      !["eq", "gte", "lt", "contains"].includes(f.op) ||
      !["string", "number", "boolean"].includes(typeof f.value) ||
      String(f.value).length > 200
    )
      throw bad("Invalid filter");
    if (
      d.fields[f.field] === "number" &&
      (typeof f.value !== "number" || !Number.isFinite(f.value))
    )
      throw bad("Numeric filters require a number");
    if (d.fields[f.field] === "text" && typeof f.value !== "string")
      throw bad("Text filters require a string");
    if (d.fields[f.field] === "boolean" && typeof f.value !== "boolean")
      throw bad("Boolean filters require a boolean");
    if (f.op !== "eq" && d.fields[f.field] === "boolean")
      throw bad("Invalid boolean filter");
    if (d.fields[f.field] === "json")
      throw bad("JSON filters are not supported");
  }
  if (
    input.q !== undefined &&
    (typeof input.q !== "string" || input.q.length > 100)
  )
    throw bad("Invalid search");
  if (
    d.requiresMonth &&
    !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(input.month || "")
  )
    throw bad("month is required (YYYY-MM)");
  return { ...input, filters };
}
function matches(row, request) {
  return (
    (!request.q ||
      Object.values(row).some(
        (v) =>
          typeof v === "string" &&
          v.toLowerCase().includes(request.q.toLowerCase()),
      )) &&
    request.filters.every((f) => {
      const v = row[f.field];
      if (v === null || v === undefined) return false;
      if (f.op === "eq") return String(v) === String(f.value);
      if (f.op === "contains")
        return String(v).toLowerCase().includes(String(f.value).toLowerCase());
      return f.op === "gte" ? v >= f.value : v < f.value;
    })
  );
}
function buildSelect(d, request, dialect = "pg") {
  const params = [],
    clauses = [];
  const param = (v) => {
    params.push(v);
    return dialect === "pg" ? "$" + params.length : "?";
  };
  for (const f of request.filters) {
    const field = '"' + f.field + '"';
    if (f.op === "contains")
      clauses.push(
        `LOWER(CAST(${field} AS TEXT)) LIKE ${param(
          "%" +
            String(f.value)
              .toLowerCase()
              .replace(/[\\%_]/g, "\\$&") +
            "%",
        )} ESCAPE '\\'`,
      );
    else
      clauses.push(
        `${field} ${{ eq: "=", gte: ">=", lt: "<" }[f.op]} ${param(f.value)}`,
      );
  }
  if (request.q) {
    const p = "%" + request.q.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%";
    const cols = Object.keys(d.fields).filter((f) => d.fields[f] === "text");
    clauses.push(
      "(" +
        cols
          .map(
            (f) => `LOWER(CAST("${f}" AS TEXT)) LIKE ${param(p)} ESCAPE '\\'`,
          )
          .join(" OR ") +
        ")",
    );
  }
  return {
    sql: `SELECT * FROM (${d.sql}) AS approved_data${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} ORDER BY ${d.order.map((x) => '"' + x + '"').join(", ")} LIMIT ${MAX_ROWS + 1}`,
    params,
  };
}
function publicCatalog(catalog) {
  return Object.fromEntries(
    Object.entries(catalog).map(([id, { sql, order, load, ...publicData }]) => [
      id,
      publicData,
    ]),
  );
}
function createReader({
  catalog,
  pool,
  sqlite,
  token = () => process.env.CHATGPT_READ_TOKEN,
}) {
  return async function read({ method, authorization, path, input }) {
    if (!authorized(authorization, token()))
      return { status: 401, body: { error: "Authentication required" } };
    if (method !== "GET")
      return { status: 405, body: { error: "Read-only endpoint" } };
    if (path === "/catalog")
      return {
        status: 200,
        body: { version: 1, datasets: publicCatalog(catalog) },
      };
    if (path !== "/query")
      return { status: 404, body: { error: "Unknown endpoint" } };
    try {
      const request = validateRequest(catalog, input),
        d = catalog[request.dataset];
      let rows;
      if (sqlite) {
        const { sql, params } = buildSelect(d, request, "sqlite");
        rows = sqlite.prepare(sql).all(...params);
      } else {
        const db = await pool.connect();
        try {
          await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await db.query("SET LOCAL statement_timeout = '10s'");
          if (d.load)
            rows = (await d.load(db, request)).filter((r) =>
              matches(r, request),
            );
          else {
            const { sql, params } = buildSelect(d, request);
            rows = (await db.query(sql, params)).rows;
          }
          await db.query("COMMIT");
        } catch (e) {
          await db.query("ROLLBACK");
          throw e;
        } finally {
          db.release();
        }
      }
      const truncated = rows.length > MAX_ROWS;
      const body = {
        version: 1,
        dataset: request.dataset,
        retrievedAt: new Date().toISOString(),
        history: d.history,
        rows: rows.slice(0, MAX_ROWS),
        truncated,
        limit: MAX_ROWS,
      };
      if (Buffer.byteLength(JSON.stringify(body)) > 4 * 1024 * 1024)
        return {
          status: 413,
          body: { error: "Result too large; narrow filters" },
        };
      return { status: 200, body };
    } catch (e) {
      return {
        status: e instanceof InputError ? 400 : 503,
        body: {
          error:
            e instanceof InputError
              ? e.message
              : "Source unavailable; no data was substituted",
        },
      };
    }
  };
}
function expressHandler(options) {
  const reader = createReader(options);
  return async (req, res) => {
    let input;
    try {
      if (req.query.request !== undefined) {
        if (
          typeof req.query.request !== "string" ||
          req.query.request.length > 8000
        )
          throw bad("Invalid query");
        input = JSON.parse(req.query.request);
      }
    } catch {
      return res.status(400).json({ error: "Invalid query" });
    }
    const result = await reader({
      method: req.method,
      authorization: req.get("authorization"),
      path: req.path,
      input,
    });
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    return res.status(result.status).json(result.body);
  };
}
module.exports = {
  createReader,
  expressHandler,
  authorized,
  validateRequest,
  buildSelect,
  MAX_ROWS,
};
