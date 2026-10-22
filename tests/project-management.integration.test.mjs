import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import { beijingDate } from "../src/model.js";

test("project management integration preserves completion rules and separates public overview from internal changes and handover", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-pm-integration-"),
  );
  const origin = "https://worklog.example.com";
  let app;
  try {
    app = await createApp({
      dataDir,
      origin,
      adminPassword: "Temporary-integration-123",
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base =
      "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
    async function api(route, method = "GET", body, cookie = "") {
      const response = await fetch(base + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      return {
        status: response.status,
        data,
        cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
      };
    }
    const admin = await api("/login", "POST", {
      login: "admin",
      password: "Temporary-integration-123",
    });
    assert.equal(admin.status, 200);
    const initial = await api("/state");
    const project = initial.data.projects[0];
    const today = beijingDate(),
      yesterday = beijingDate(new Date(Date.now() - 86400000));
    const taskIds = [];
    for (const task of [
      { task: "Actual-only completion", actual: "Fixture member", date: "" },
      { task: "Date-only completion", actual: "", date: today },
      {
        task: "Pending coordination",
        actual: "",
        date: "",
        due_date: yesterday,
        blocked: true,
      },
    ]) {
      const response = await api(
        "/records",
        "POST",
        { project_id: project.id, owner: "Fixture owner", ...task },
        admin.cookie,
      );
      assert.equal(response.status, 201);
      taskIds.push(response.data.id);
    }
    const snapshot = (await api("/state")).data.records;
    const profile = await api(
      "/projects/" + project.id + "/management",
      "PATCH",
      {
        version: 0,
        owner: "Fixture owner",
        stage: "Implementation",
        target_date: today,
      },
      admin.cookie,
    );
    assert.equal(profile.status, 200);
    const milestoneResult = await api(
      "/projects/" + project.id + "/milestones",
      "POST",
      {
        title: "Integration checkpoint",
        owner: "Fixture owner",
        planned_date: yesterday,
        status: "in_progress",
        task_ids: taskIds,
      },
      admin.cookie,
    );
    assert.equal(milestoneResult.status, 201);
    let milestone = milestoneResult.data.milestone;
    const checklist = await api(
      "/projects/" + project.id + "/deliverables",
      "POST",
      { title: "PRIVATE-HANDOVER-MARKER", required: true },
      admin.cookie,
    );
    assert.equal(checklist.status, 201);
    const changeResult = await api(
      "/projects/" + project.id + "/changes",
      "POST",
      {
        title: "PRIVATE-CHANGE-MARKER",
        original_scope: "PRIVATE-ORIGINAL-SCOPE",
        requested_scope: "PRIVATE-REQUESTED-SCOPE",
        requester: "Fixture requester",
        task_ids: [taskIds[2]],
        milestone_id: milestone.id,
        impact_days: 3,
      },
      admin.cookie,
    );
    assert.equal(changeResult.status, 201);
    let change = changeResult.data.change;
    const publicOverview = await api("/project-overview");
    assert.equal(publicOverview.status, 200);
    const publicProject = publicOverview.data.projects.find(
      (p) => p.id === project.id,
    );
    assert.equal(publicProject.management.stage, "Implementation");
    assert.deepEqual(
      {
        total: publicProject.task_summary.total,
        completed: publicProject.task_summary.completed,
        pending: publicProject.task_summary.pending,
        overdue: publicProject.task_summary.overdue,
        blocked: publicProject.task_summary.blocked,
      },
      { total: 3, completed: 2, pending: 1, overdue: 1, blocked: 1 },
    );
    assert.equal(publicProject.milestones.overdue, 1);
    assert.equal(publicProject.milestones.next.id, milestone.id);
    assert.equal(Object.hasOwn(publicProject, "changes"), false);
    assert.equal(Object.hasOwn(publicProject, "handover_missing"), false);
    assert.ok(!JSON.stringify(publicOverview.data).includes("PRIVATE-"));
    assert.equal(
      (await api("/projects/" + project.id + "/changes")).status,
      401,
    );
    assert.equal((await api("/changes/" + change.id)).status, 401);
    assert.equal((await api("/changes/" + change.id + "/history")).status, 401);
    assert.ok(!JSON.stringify((await api("/logs")).data).includes("PRIVATE-"));
    const memberOverview = await api(
      "/project-overview",
      "GET",
      undefined,
      admin.cookie,
    );
    const memberProject = memberOverview.data.projects.find(
      (p) => p.id === project.id,
    );
    assert.equal(memberProject.handover_missing, 1);
    assert.equal(memberProject.changes.pending, 1);
    milestone = (
      await api(
        "/milestones/" + milestone.id,
        "PATCH",
        { version: milestone.version, status: "achieved", actual_date: today },
        admin.cookie,
      )
    ).data.milestone;
    const confirmed = await api(
      "/changes/" + change.id,
      "PATCH",
      {
        version: change.version,
        confirmation_status: "confirmed",
        confirmed_by: "Fixture confirmer",
        confirmed_on: today,
        progress_status: "implemented",
      },
      admin.cookie,
    );
    assert.equal(confirmed.status, 200);
    change = confirmed.data.change;
    assert.deepEqual(
      (await api("/state")).data.records,
      snapshot,
      "milestones and changes cannot rewrite tasks, completion or schedule",
    );
    const after = (
      await api("/project-overview", "GET", undefined, admin.cookie)
    ).data.projects.find((p) => p.id === project.id);
    assert.equal(after.milestones.achieved, 1);
    assert.equal(after.milestones.next, null);
    assert.equal(after.changes.confirmed, 1);
    assert.equal(after.changes.implemented, 1);
    assert.equal(after.task_summary.completed, 2);
    assert.equal(
      (
        await api(
          "/milestones/" + milestone.id,
          "PATCH",
          { version: 1, title: "Stale update" },
          admin.cookie,
        )
      ).status,
      409,
    );
  } finally {
    if (app) {
      await new Promise((r) => app.server.close(r));
      app.db.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
