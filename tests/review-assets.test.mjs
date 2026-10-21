import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createResources } from "../resources.mjs";

const actor = { id: "asset-reviewer", login: "fixture", name: "审查成员" };
const field = (key, type = "text", extra = {}) => ({
  key,
  label: key,
  type,
  options: [],
  required: false,
  archived: false,
  ...extra,
});
function fixture() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-review-assets-"),
  );
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);INSERT INTO projects VALUES('p1','Fixture');",
  );
  let service = createResources({ db, dataDir });
  return {
    db,
    restart() {
      service = createResources({ db, dataDir });
    },
    async api(route, method = "GET", b = {}) {
      return service.api({ route, method, b, user: actor });
    },
    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
async function category(f, name, fields) {
  return (
    await f.api("/projects/p1/resource-categories", "POST", { name, fields })
  ).data.category;
}
async function resource(f, cat, values) {
  return (
    await f.api("/projects/p1/resources", "POST", {
      name: "Fixture resource",
      category_id: cat.id,
      field_values: values,
    })
  ).data.resource;
}
async function switchTo(f, value, cat, values) {
  return (
    await f.api("/resources/" + value.id, "PATCH", {
      version: value.version,
      category_id: cat.id,
      ...(values === undefined ? {} : { field_values: values }),
    })
  ).data.resource;
}

test("review: required text is checked after trimming while zero and false remain valid", async () => {
  const f = fixture();
  try {
    const cat = await category(f, "Required", [
      field("text", "text", { required: true }),
      field("memo", "textarea", { required: true }),
      field("count", "number", { required: true }),
      field("enabled", "boolean", { required: true }),
    ]);
    for (const values of [
      { text: " \t\n ", memo: "ok", count: 0, enabled: false },
      { text: "ok", memo: "\u3000\n", count: 0, enabled: false },
    ])
      await assert.rejects(
        resource(f, cat, values),
        (e) => e.status === 400 && /请填写/.test(e.message),
      );
    const value = await resource(f, cat, {
      text: "  code  ",
      memo: " valid ",
      count: 0,
      enabled: false,
    });
    assert.equal(value.field_values.text, "code");
    assert.equal(value.field_values.count, 0);
    assert.equal(value.field_values.enabled, false);
    await assert.rejects(
      f.api("/resources/" + value.id, "PATCH", {
        version: value.version,
        field_values: { text: " \t " },
      }),
      (e) => e.status === 400,
    );
  } finally {
    f.close();
  }
});

test("review: switching categories preserves same-key values with different types and restores them after restart", async () => {
  const f = fixture();
  try {
    const number = await category(f, "Number category", [
      field("code", "number"),
      field("rack"),
    ]);
    const text = await category(f, "Text category", [
      field("code"),
      field("note"),
    ]);
    let value = await resource(f, number, { code: 123, rack: "Rack A" });
    value = await switchTo(f, value, text);
    assert.equal(value.field_values.code, "");
    assert.equal(value.field_values.rack, "Rack A");
    assert.equal(value.category_values[number.id].code, 123);
    value = (
      await f.api("/resources/" + value.id, "PATCH", {
        version: value.version,
        field_values: { code: "Text B", note: "Note B" },
      })
    ).data.resource;
    f.restart();
    value = (await f.api("/resources/" + value.id)).data.resource;
    assert.equal(
      value.field_history.find((x) => x.category_id === number.id).values.code,
      123,
    );
    value = await switchTo(f, value, number);
    assert.equal(value.field_values.code, 123);
    assert.equal(value.field_values.rack, "Rack A");
    assert.equal(value.category_values[text.id].code, "Text B");
    value = await switchTo(f, value, text);
    assert.equal(value.field_values.code, "Text B");
    assert.equal(value.field_values.note, "Note B");
    assert.equal(
      value.field_history.find((x) => x.category_id === number.id)
        .category_name,
      number.name,
    );
  } finally {
    f.close();
  }
});

test("review: legacy flat fields are attributed before switching and same-type collisions are not lost", async () => {
  const f = fixture();
  try {
    const first = await category(f, "First", [field("code")]);
    const second = await category(f, "Second", [field("code")]);
    let value = await resource(f, first, { code: "Original A" });
    // Simulate the pre-review schema: no per-category values were persisted.
    f.db
      .prepare("UPDATE resources SET category_values_json='{}' WHERE id=?")
      .run(value.id);
    value = await switchTo(f, value, second, { code: "Different B" });
    assert.equal(value.category_values[first.id].code, "Original A");
    value = await switchTo(f, value, first);
    assert.equal(value.field_values.code, "Original A");
    assert.equal(value.category_values[second.id].code, "Different B");
  } finally {
    f.close();
  }
});

test("review: select options used in a former category cannot be removed and break restoration", async () => {
  const f = fixture();
  try {
    const select = await category(f, "Select", [
      field("code", "select", { options: ["A", "B"] }),
    ]);
    const other = await category(f, "Other", [field("code")]);
    let value = await resource(f, select, { code: "A" });
    value = await switchTo(f, value, other, { code: "unrelated" });
    await assert.rejects(
      f.api("/resource-categories/" + select.id, "PATCH", {
        version: select.version,
        fields: [field("code", "select", { options: ["B"] })],
      }),
      (e) => e.status === 409 && /仍被资源使用/.test(e.message),
    );
    value = await switchTo(f, value, select);
    assert.equal(value.field_values.code, "A");
  } finally {
    f.close();
  }
});

test("review: adding a same-key field to the current category does not inherit another category's value", async () => {
  const f = fixture();
  try {
    const first = await category(f, "Numeric", [field("code", "number")]);
    let second = await category(f, "Initially empty", []);
    let value = await resource(f, first, { code: 123 });
    value = await switchTo(f, value, second);
    second = (
      await f.api("/resource-categories/" + second.id, "PATCH", {
        version: second.version,
        fields: [field("code")],
      })
    ).data.category;
    value = (await f.api("/resources/" + value.id)).data.resource;
    assert.equal(value.field_values.code, "");
    assert.equal(value.category_values[first.id].code, 123);
    value = (
      await f.api("/resources/" + value.id, "PATCH", {
        version: value.version,
        name: "Metadata edit still works",
      })
    ).data.resource;
    assert.equal(value.field_values.code, "");
    value = await switchTo(f, value, first);
    assert.equal(value.field_values.code, 123);
  } finally {
    f.close();
  }
});
