const test = require("node:test");
const assert = require("node:assert/strict");
const { createReader, buildSelect } = require("./reader.cjs");
const catalog = {
  fixture: {
    title: "fixture",
    sql: "SELECT id,name,amount FROM fixture",
    fields: { id: "number", name: "text", amount: "number" },
    order: ["id"],
    history: "event",
  },
};
const secret = "fixture-secret-".repeat(4);
const auth = "Bearer " + secret;
function fixture(fail = false) {
  const calls = [],
    client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (fail && sql.startsWith("SELECT"))
          throw new Error("PRIVATE DATABASE MESSAGE");
        return { rows: [] };
      },
      release() {
        calls.push({ sql: "RELEASE" });
      },
    };
  return {
    calls,
    reader: createReader({
      catalog,
      pool: { connect: async () => client },
      token: () => secret,
    }),
  };
}
test("deny anonymous, wrong, and unset tokens; sessions and query tokens do not authorize", async () => {
  const { reader } = fixture();
  for (const authorization of [undefined, "Bearer wrong", "Cookie session"])
    assert.equal(
      (await reader({ method: "GET", authorization, path: "/catalog" })).status,
      401,
    );
  assert.equal(
    (
      await createReader({ catalog, token: () => "" })({
        method: "GET",
        authorization: auth,
        path: "/catalog",
      })
    ).status,
    401,
  );
});
test("reject all write verbs and unknown paths even with correct token", async () => {
  const { reader, calls } = fixture();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"])
    assert.equal(
      (await reader({ method, authorization: auth, path: "/query" })).status,
      405,
    );
  assert.equal(
    (await reader({ method: "GET", authorization: auth, path: "/sync" }))
      .status,
    404,
  );
  assert.equal(calls.length, 0);
});
test("catalog excludes SQL and handlers", async () => {
  const { reader } = fixture();
  const result = await reader({
    method: "GET",
    authorization: auth,
    path: "/catalog",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.datasets.fixture.sql, undefined);
});
test("fixed SELECT uses read-only transaction; filter values are bound parameters", async () => {
  const { reader, calls } = fixture();
  const hostile = "a' OR 1=1 --";
  const result = await reader({
    method: "GET",
    authorization: auth,
    path: "/query",
    input: {
      dataset: "fixture",
      filters: [{ field: "name", op: "eq", value: hostile }],
    },
  });
  assert.equal(result.status, 200);
  assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "RELEASE");
  const select = calls.find((c) => c.sql.startsWith("SELECT"));
  assert.equal(select.sql.includes(hostile), false);
  assert.deepEqual(select.params, [hostile]);
});
test("wildcard search escapes percent and underscore; no arbitrary identifiers or SQL", async () => {
  const plan = buildSelect(catalog.fixture, {
    filters: [{ field: "name", op: "contains", value: "100%_" }],
  });
  assert.deepEqual(plan.params, ["%100\\%\\_%"]);
  const { reader, calls } = fixture();
  for (const input of [
    { dataset: "users" },
    { dataset: "__proto__" },
    { dataset: "fixture", sql: "DROP TABLE fixture" },
    {
      dataset: "fixture",
      filters: [{ field: "name); DROP TABLE users;--", op: "eq", value: "x" }],
    },
    {
      dataset: "fixture",
      filters: [{ field: "amount", op: "gte", value: "200" }],
    },
  ])
    assert.equal(
      (
        await reader({
          method: "GET",
          authorization: auth,
          path: "/query",
          input,
        })
      ).status,
      400,
    );
  assert.equal(calls.length, 0);
});
test("query failure rolls back, releases client, and redacts upstream errors", async () => {
  const { reader, calls } = fixture(true);
  const result = await reader({
    method: "GET",
    authorization: auth,
    path: "/query",
    input: { dataset: "fixture" },
  });
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("upstream errors with HTTP 400 remain private", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    release() {},
  };
  const reader = createReader({
    catalog: {
      private_source: {
        fields: { id: "number" },
        history: "event",
        async load() {
          throw Object.assign(new Error("PRIVATE upstream body"), {
            status: 400,
          });
        },
      },
      fixture: catalog.fixture,
    },
    pool: { connect: async () => client },
    token: () => secret,
  });
  const result = await reader({
    method: "GET",
    authorization: auth,
    path: "/query",
    input: { dataset: "private_source" },
  });
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.ok(calls.includes("ROLLBACK"));
});
