import MyTodos from "./components/MyTodos.jsx";
import Notifications from "./components/Notifications.jsx";
import TaskDetail from "./components/TaskDetail.jsx";
import PeopleOverview from "./components/PeopleOverview.jsx";
import OperationLog from "./components/OperationLog.jsx";
import ProjectLibrary from "./components/ProjectLibrary.jsx";
import ProjectResources from "./components/ProjectResources.jsx";
import ResourceEvents from "./components/ResourceEvents.jsx";
import Deliverables from "./components/Deliverables.jsx";
import React, { useEffect, useMemo, useState } from "react";
import {
  Settings,
  CheckCircle2,
  ImageDown,
  Plus,
  ScanLine,
  Check,
  X,
  Download,
  RefreshCw,
  Archive,
  ListChecks,
  Trash2,
  FileSpreadsheet,
} from "lucide-react";
import { api, useWorkbench } from "./api.js";
import {
  availablePeople,
  filterRecords,
  monthLabel,
  pagination,
  PAGE_SIZE,
  PAGE_SIZES,
  SORT_OPTIONS,
  taskTree,
  statistics,
  myTodos,
  priorityOf,
  recordsCsv,
} from "./model.js";
import { Stats, primary, secondary } from "./components/UI.jsx";
import {
  Sidebar,
  MonthSelect,
  Filters,
  DetailTable,
  PersonSummary,
} from "./components/Workbench.jsx";
import {
  AuthDialog,
  RecordDialog,
  ProjectDialog,
  PasswordDialog,
  DeleteDialog,
  ExportDialog,
  BatchDialog,
  BatchDeleteDialog,
} from "./components/Dialogs.jsx";
import { download } from "./picture.js";
function listPreference(key, allowed, fallback) {
  try {
    const value = JSON.parse(
      localStorage.getItem("worklog-list-preferences") || "{}",
    )[key];
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
export default function App() {
  const { state, loaded, error, refresh } = useWorkbench();
  const [projectId, setProjectId] = useState(
      () => new URLSearchParams(location.search).get("project") || "",
    ),
    [month, setMonth] = useState(""),
    [peopleFilter, setPeopleFilter] = useState([]),
    [priorityFilter, setPriorityFilter] = useState(""),
    [dueFilter, setDueFilter] = useState(""),
    [blockedFilter, setBlockedFilter] = useState(""),
    [keyword, setKeyword] = useState(""),
    [page, setPage] = useState(1),
    [overview, setOverview] = useState(false),
    [todosView, setTodosView] = useState(false),
    [notificationsOpen, setNotificationsOpen] = useState(false),
    [detailId, setDetailId] = useState(""),
    [pageSize, setPageSize] = useState(() =>
      listPreference("pageSize", PAGE_SIZES, PAGE_SIZE),
    ),
    [sort, setSort] = useState(() =>
      listPreference(
        "sort",
        SORT_OPTIONS.map((option) => option.id),
        "date-desc",
      ),
    ),
    [tab, setTab] = useState("records"),
    [projectModule, setProjectModule] = useState(() => {
      const value = new URLSearchParams(location.search).get("module");
      return ["documents", "resources", "resource-events"].includes(value)
        ? value
        : "records";
    }),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [capture, setCapture] = useState(false),
    [selectedIds, setSelectedIds] = useState(() => new Set()),
    [logRevision, setLogRevision] = useState(0);
  const { user, projects, records } = state,
    project =
      projects.find((p) => p.id === projectId) ||
      projects.find((p) => !p.archived) ||
      projects[0];
  // Archived projects stay browsable but leave personal to-do lists.
  const activeRecords = useMemo(() => {
    const archived = new Set(
      projects.filter((p) => p.archived).map((p) => p.id),
    );
    return records.filter((r) => !archived.has(r.project_id));
  }, [projects, records]);
  const projectRecords = useMemo(
    () => records.filter((r) => r.project_id === project?.id),
    [records, project?.id],
  );
  const people = useMemo(
    () => availablePeople(project, projectRecords, user),
    [project, projectRecords, user],
  );
  const actualPeople = useMemo(
    () =>
      availablePeople(
        null,
        projectRecords.map((r) => ({ ...r, owner: "" })),
        null,
      ),
    [projectRecords],
  );
  const filtered = useMemo(
    () =>
      filterRecords(projectRecords, {
        month,
        people: peopleFilter,
        priority: priorityFilter,
        due: dueFilter,
        blocked: blockedFilter,
        keyword,
        sort,
      }),
    [
      projectRecords,
      month,
      peopleFilter,
      keyword,
      sort,
      priorityFilter,
      dueFilter,
      blockedFilter,
    ],
  );
  const tree = useMemo(
    () => taskTree(projectRecords, filtered, sort),
    [projectRecords, filtered, sort],
  );
  const selectedRecords = user
    ? projectRecords.filter((r) => selectedIds.has(r.id))
    : [];
  const pg = pagination(tree.roots.length, page, pageSize),
    paged = capture
      ? tree.roots
      : tree.roots.slice(pg.start, pg.start + pageSize);
  const filterLabel = [
    blockedFilter ? (blockedFilter === "blocked" ? "阻塞中" : "可推进") : "",
    monthLabel(month),
    peopleFilter.length ? peopleFilter.join("、") : "全部完成人",
    keyword.trim() ? "搜索：" + keyword.trim() : "",
    priorityFilter ? "优先级：" + priorityOf(priorityFilter).label : "",
    dueFilter
      ? { overdue: "已逾期", upcoming: "今明到期", none: "未设计划日期" }[
          dueFilter
        ]
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const previousCount = useMemo(() => {
    if (!month || month === "none") return null;
    const [y, m] = month.split("-").map(Number);
    const previous = new Date(Date.UTC(y, m - 2, 1));
    return statistics(
      filterRecords(projectRecords, {
        month: previous.toISOString().slice(0, 7),
        people: peopleFilter,
        priority: priorityFilter,
        due: dueFilter,
        blocked: blockedFilter,
        keyword,
      }),
    ).total;
  }, [
    projectRecords,
    month,
    peopleFilter,
    keyword,
    priorityFilter,
    dueFilter,
    blockedFilter,
  ]);
  function notify(message, undo) {
    setToast({ message, undo });
  }
  async function act(fn) {
    try {
      await fn();
    } catch (e) {
      notify(e.message);
    }
  }
  function resetFilters() {
    setMonth("");
    setPeopleFilter([]);
    setPriorityFilter("");
    setDueFilter("");
    setBlockedFilter("");
    setKeyword("");
    setPage(1);
    setSelectedIds(new Set());
  }
  function choose(p) {
    setOverview(false);
    setTodosView(false);
    setProjectId(p.id);
    resetFilters();
    const u = new URL(location.href);
    u.searchParams.set("project", p.id);
    u.searchParams.delete("document");
    history.replaceState(null, "", u);
  }
  function requireUser(next) {
    setModal(user ? next : { type: "auth", next });
  }
  function changeFilter(setter, value) {
    setter(value);
    setPage(1);
    setSelectedIds(new Set());
  }
  function select(ids, checked) {
    setSelectedIds((old) => {
      const next = new Set(old);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return next;
    });
  }
  async function batch(action, changes) {
    try {
      return await api("/records/batch", "POST", {
        action,
        items: selectedRecords.map((r) => ({ id: r.id, version: r.version })),
        ...(changes ? { changes } : {}),
      });
    } catch (e) {
      if (e.status !== 409) throw e;
      await refresh(true).catch(() => {});
      throw Object.assign(
        new Error("部分记录刚被他人修改或删除，列表已刷新，请确认后重新提交"),
        { status: 409 },
      );
    }
  }
  useEffect(() => {
    try {
      localStorage.setItem(
        "worklog-list-preferences",
        JSON.stringify({ pageSize, sort }),
      );
    } catch {
      // Browsing remains available when storage is disabled.
    }
  }, [pageSize, sort]);
  async function saved(message = "已保存", undo) {
    setLogRevision((n) => n + 1);
    setModal(null);
    notify(message, undo);
    try {
      await refresh(true);
    } catch {
      notify(message + "；列表同步失败，请点重试", undo);
    }
  }
  async function reloadRecord(type, id) {
    const next = await refresh(true);
    const record = next.records.find((r) => r.id === id);
    if (record) setModal({ type, record });
    else {
      setModal(null);
      notify("这条记录已被删除，列表已更新");
    }
  }
  async function reloadProject(id) {
    const next = await refresh(true);
    const project = next.projects.find((p) => p.id === id);
    if (project) setModal({ type: "settings", project });
    else {
      setModal(null);
      notify("项目已不存在，列表已更新");
    }
  }
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.undo ? 20000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!capture) return;
    const listener = (e) => {
      if (e.key === "Escape") setCapture(false);
    };
    addEventListener("keydown", listener);
    return () => removeEventListener("keydown", listener);
  }, [capture]);
  const canManage = Boolean(user && project);
  const detailRecord = records.find((r) => r.id === detailId);
  const editingProject =
    modal?.project ||
    projects.find((p) => p.id === modal?.record?.project_id) ||
    project;
  const editingPeople = availablePeople(
    editingProject,
    records.filter((r) => r.project_id === editingProject?.id),
    user,
  );
  function addChild(parent) {
    requireUser({
      type: "record",
      parent,
      project: projects.find((p) => p.id === parent.project_id),
    });
  }
  async function contentChanged() {
    setLogRevision((n) => n + 1);
    await refresh(true);
  }
  return (
    <div
      className={
        "wb-shell flex h-dvh overflow-hidden bg-[#F6F7F9] font-sans text-slate-900 antialiased " +
        (capture ? "capture" : "")
      }
    >
      <Sidebar
        projects={projects}
        project={project}
        user={user}
        todoActive={todosView}
        todoCount={myTodos(activeRecords, user?.name).length}
        unread={state.unread_notifications || 0}
        onTodos={() => {
          if (!user) return setModal({ type: "auth", next: { type: "todos" } });
          setTodosView(true);
          setOverview(false);
          setCapture(false);
        }}
        onNotifications={() => setNotificationsOpen(true)}
        overview={overview}
        onOverview={() => {
          setOverview(true);
          setTodosView(false);
          setCapture(false);
        }}
        onSettings={(p) => requireUser({ type: "settings", project: p })}
        onSelect={choose}
        onNew={() => requireUser({ type: "project" })}
        onLogin={() => setModal({ type: "auth" })}
        onPassword={() => setModal({ type: "password" })}
        onLogout={() =>
          act(async () => {
            await api("/logout", "POST", {});
            await saved("已退出登录");
          })
        }
      />
      <main className="workbench-main flex min-w-0 flex-1 flex-col overflow-y-auto">
        {todosView && user ? (
          <MyTodos
            key={user.id}
            user={user}
            records={activeRecords}
            projects={projects}
            loaded={loaded}
            error={error}
            onRefresh={() => refresh(true)}
            onOpen={(r) => setDetailId(r.id)}
          />
        ) : overview ? (
          <PeopleOverview
            projects={projects}
            records={records}
            onOpen={(r) => setDetailId(r.id)}
          />
        ) : (
          <>
            <header className="topbar sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200/60 bg-[#F6F7F9]/80 px-8 py-4 backdrop-blur-md">
              <nav
                aria-label="当前位置"
                className="flex min-w-0 items-center gap-1.5 text-[13px] text-slate-400"
              >
                <span className="shrink-0">我的项目</span>
                <span className="text-slate-300">/</span>
                <span className="truncate font-medium text-slate-700">
                  {project?.name || "正在加载"}
                </span>
              </nav>
              {canManage ? (
                <button
                  onClick={() => setModal({ type: "settings", project })}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-slate-400 transition-all hover:bg-white hover:text-slate-600 hover:shadow-sm"
                >
                  <Settings className="h-4 w-4" />
                  项目设置
                </button>
              ) : (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-400">
                  <i className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  公开可见
                </span>
              )}
            </header>
            <div className="workbench-content mx-auto w-full max-w-5xl px-8 pb-12">
              <nav
                aria-label="项目模块"
                className="project-module-nav mt-6 flex flex-wrap gap-1 rounded-xl border border-slate-200/70 bg-white/70 p-1 shadow-sm"
              >
                {[
                  ["records", "工作记录"],
                  ["documents", "项目资料"],
                  ["resources", "资源与配置"],
                  ["resource-events", "资料日志"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-current={projectModule === id ? "page" : undefined}
                    onClick={() => {
                      setProjectModule(id);
                      setCapture(false);
                      const next = new URL(location.href);
                      next.searchParams.set("module", id);
                      next.searchParams.delete("document");
                      if (project) next.searchParams.set("project", project.id);
                      history.replaceState(null, "", next);
                    }}
                    className={
                      "rounded-lg px-4 py-2 text-[13px] font-medium transition-all " +
                      (projectModule === id
                        ? "bg-indigo-50 text-indigo-600 shadow-sm"
                        : "text-slate-400 hover:bg-slate-50 hover:text-slate-700")
                    }
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {project?.archived ? (
                <div
                  role="note"
                  className="archived-banner mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700"
                >
                  <span className="flex items-center gap-1.5">
                    <Archive className="h-3.5 w-3.5 shrink-0" />
                    此项目已归档：内容仍可查看和修改，但不再计入我的待办和到期提醒。
                  </span>
                  {user && (
                    <button
                      className="shrink-0 font-medium underline-offset-2 hover:underline"
                      onClick={() =>
                        act(async () => {
                          await api("/projects/" + project.id, "PATCH", {
                            name: project.name,
                            archived: false,
                            version: project.version,
                          });
                          await saved("项目已取消归档");
                        })
                      }
                    >
                      取消归档
                    </button>
                  )}
                </div>
              ) : null}
              {projectModule === "documents" ? (
                <div className="pt-8">
                  <ProjectLibrary
                    key={(project?.id || "") + ":" + (user?.id || "guest")}
                    project={project}
                    user={user}
                    records={projectRecords}
                    members={people}
                    onLogin={() => setModal({ type: "auth" })}
                  />
                  <Deliverables
                    key={
                      "deliverables:" +
                      (project?.id || "") +
                      ":" +
                      (user?.id || "guest")
                    }
                    project={project}
                    user={user}
                    members={people}
                  />
                </div>
              ) : projectModule === "resources" ? (
                <div className="pt-8">
                  <ProjectResources
                    key={(project?.id || "") + ":" + (user?.id || "guest")}
                    project={project}
                    user={user}
                    records={projectRecords}
                    members={people}
                    onLogin={() => setModal({ type: "auth" })}
                  />
                </div>
              ) : projectModule === "resource-events" ? (
                <ResourceEvents
                  key={(project?.id || "") + ":" + (user?.id || "guest")}
                  project={project}
                  user={user}
                  onLogin={() => setModal({ type: "auth" })}
                />
              ) : (
                <>
                  <div className="title-row flex items-end justify-between gap-5 pt-8">
                    <div>
                      <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
                        工作完成记录
                      </h1>
                      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-slate-400">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        原定谁负责，实际谁完成。
                      </p>
                      <p className="capture-project mt-3 hidden text-sm font-semibold text-slate-700">
                        {project?.name}
                      </p>
                    </div>
                    <div className="title-actions flex shrink-0 items-center gap-2.5">
                      {tab !== "logs" && (
                        <button
                          disabled={!loaded || !project}
                          className={secondary}
                          onClick={() => setModal({ type: "export" })}
                        >
                          <ImageDown className="h-4 w-4" />
                          导出图片
                        </button>
                      )}
                      <button
                        disabled={!loaded || !project}
                        className={primary}
                        onClick={() => requireUser({ type: "record" })}
                      >
                        <Plus className="h-4 w-4" strokeWidth={2.5} />
                        记录完成
                      </button>
                    </div>
                  </div>
                  {error && (
                    <div
                      className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-600"
                      role="alert"
                    >
                      <span>暂时无法同步：{error}</span>
                      <button
                        className="inline-flex shrink-0 items-center gap-1"
                        onClick={() => refresh(true).catch(() => {})}
                      >
                        <RefreshCw className="h-3 w-3" />
                        重试
                      </button>
                    </div>
                  )}
                  {tab !== "logs" && (
                    <Stats
                      records={filtered}
                      month={month}
                      previousCount={previousCount}
                    />
                  )}
                  <div className="view-controls mt-8 flex flex-wrap items-center justify-between gap-3">
                    <div
                      role="tablist"
                      aria-label="记录视图"
                      className="flex rounded-xl bg-slate-200/50 p-1"
                    >
                      {[
                        ["records", "完成明细"],
                        ["people", "按人汇总"],
                        ["logs", "操作日志"],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          role="tab"
                          aria-selected={tab === key}
                          onClick={() => {
                            setCapture(false);
                            setTab(key);
                            setPage(1);
                          }}
                          className={
                            "rounded-lg px-4 py-1.5 text-[13px] font-medium transition-all active:scale-95 " +
                            (tab === key
                              ? "bg-white text-slate-800 shadow-sm"
                              : "text-slate-500 hover:text-slate-700")
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {tab !== "logs" && (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setCapture(true)}
                          className="screenshot-button inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-white hover:text-slate-600"
                        >
                          <ScanLine className="h-3.5 w-3.5" />
                          截图模式
                        </button>
                        <MonthSelect
                          month={month}
                          records={projectRecords}
                          onChange={(m) => changeFilter(setMonth, m)}
                        />
                      </div>
                    )}
                  </div>
                  {tab !== "logs" && (
                    <Filters
                      keyword={keyword}
                      onKeyword={(v) => changeFilter(setKeyword, v)}
                      people={actualPeople}
                      selected={peopleFilter}
                      onSelected={(v) => changeFilter(setPeopleFilter, v)}
                      priority={priorityFilter}
                      onPriority={(v) => changeFilter(setPriorityFilter, v)}
                      blocked={blockedFilter}
                      onBlocked={(v) => changeFilter(setBlockedFilter, v)}
                      due={dueFilter}
                      onDue={(v) => changeFilter(setDueFilter, v)}
                      active={
                        !!(
                          keyword ||
                          month ||
                          peopleFilter.length ||
                          priorityFilter ||
                          dueFilter ||
                          blockedFilter
                        )
                      }
                      sort={tab === "records" ? sort : null}
                      onSort={(value) => changeFilter(setSort, value)}
                      onClear={resetFilters}
                    />
                  )}
                  <div className="capture-filter mt-5 hidden text-xs text-slate-500">
                    {filterLabel} · {tab === "people" ? "按人汇总" : "完成明细"}
                  </div>
                  <div
                    className="mt-4"
                    role="tabpanel"
                    aria-label={
                      tab === "records"
                        ? "完成明细"
                        : tab === "people"
                          ? "按人汇总"
                          : "操作日志"
                    }
                  >
                    {!loaded && !error ? (
                      <div className="rounded-2xl border border-slate-200 bg-white py-20 text-center text-sm text-slate-400">
                        正在加载记录…
                      </div>
                    ) : tab === "records" ? (
                      <>
                        {selectedRecords.length > 0 && !capture && (
                          <div
                            role="toolbar"
                            aria-label="批量操作"
                            className="batch-bar mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-2.5 text-xs text-indigo-700"
                          >
                            <span className="mr-auto font-medium">
                              已选 {selectedRecords.length} 项
                            </span>
                            <button
                              className={secondary + " px-3 py-1.5 text-xs"}
                              onClick={() => setModal({ type: "batch" })}
                            >
                              <ListChecks className="h-3.5 w-3.5" />
                              批量修改
                            </button>
                            <button
                              className={
                                secondary +
                                " px-3 py-1.5 text-xs hover:text-rose-500"
                              }
                              onClick={() => setModal({ type: "batch-delete" })}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              批量删除
                            </button>
                            <button
                              className="px-2 py-1.5 text-slate-400 hover:text-slate-600"
                              onClick={() => setSelectedIds(new Set())}
                            >
                              取消选择
                            </button>
                          </div>
                        )}
                        <DetailTable
                          records={paged}
                          total={tree.roots.length}
                          matchingTotal={filtered.length}
                          tree={tree}
                          allRecords={projectRecords}
                          forceExpand={Boolean(
                            keyword ||
                            month ||
                            peopleFilter.length ||
                            priorityFilter ||
                            dueFilter ||
                            blockedFilter,
                          )}
                          onOpen={(r) => setDetailId(r.id)}
                          onAddChild={addChild}
                          page={pg.page}
                          pageSize={pageSize}
                          onPageSize={(value) =>
                            changeFilter(setPageSize, value)
                          }
                          onPage={setPage}
                          onEdit={(r) =>
                            setModal({ type: "record", record: r })
                          }
                          onDelete={(r) =>
                            setModal({ type: "delete", record: r })
                          }
                          capture={capture}
                          emptyAction={
                            loaded
                              ? () => requireUser({ type: "record" })
                              : null
                          }
                          selected={user ? selectedIds : null}
                          onSelect={select}
                        />
                      </>
                    ) : tab === "people" ? (
                      <PersonSummary records={filtered} capture={capture} />
                    ) : (
                      <OperationLog project={project} revision={logRevision} />
                    )}
                  </div>
                  {tab !== "logs" && (
                    <footer className="mt-6">
                      <p className="text-center text-xs leading-relaxed text-slate-400">
                        实际完成人或完成日期任填一项即为完成，两项都空为未完成。
                      </p>
                      <p className="mt-2 text-center text-[11px] leading-relaxed text-slate-400">
                        共同完成在每位参与者名下各计 1
                        项；未完成不计入完成统计。有子任务时只统计子任务，父任务不重复计数。
                      </p>
                      <div className="footer-tools mt-5 flex items-center justify-between gap-4 text-[11px] text-slate-400">
                        <span>
                          {user
                            ? "已登录，可修改全部内容 · 约每 30 秒同步"
                            : "所有人均可查看 · 注册登录后填写"}
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <button
                            disabled={!loaded}
                            onClick={() => {
                              if (project)
                                download(
                                  new Blob(
                                    [recordsCsv(filtered, projectRecords)],
                                    {
                                      type: "text/csv;charset=utf-8",
                                    },
                                  ),
                                  project.name.replace(/[\\/:*?"<>|]/g, "_") +
                                    "-工作记录.csv",
                                );
                            }}
                            className="inline-flex shrink-0 items-center gap-1 hover:text-indigo-500"
                          >
                            <FileSpreadsheet className="h-3 w-3" />
                            导出表格
                          </button>
                          <button
                            disabled={!loaded}
                            onClick={() => {
                              if (project)
                                download(
                                  new Blob(
                                    [
                                      JSON.stringify(
                                        {
                                          project: project.name,
                                          filter: filterLabel,
                                          records: filtered.map(
                                            ({
                                              id,
                                              parent_id,
                                              task,
                                              description,
                                              owner,
                                              actual,
                                              due_date,
                                              priority,
                                              dependency_ids,
                                              dependency_tasks,
                                              blocked,
                                              blocker_note,
                                              support_people,
                                              date,
                                            }) => ({
                                              id,
                                              parent_id,
                                              task,
                                              description,
                                              owner,
                                              actual,
                                              due_date,
                                              priority,
                                              dependency_ids,
                                              dependency_tasks,
                                              blocked,
                                              blocker_note,
                                              support_people,
                                              date,
                                            }),
                                          ),
                                        },
                                        null,
                                        2,
                                      ),
                                    ],
                                    { type: "application/json" },
                                  ),
                                  project.name.replace(/[\\/:*?"<>|]/g, "_") +
                                    "-工作记录.json",
                                );
                            }}
                            className="inline-flex shrink-0 items-center gap-1 hover:text-indigo-500"
                          >
                            <Download className="h-3 w-3" />
                            导出数据
                          </button>
                        </span>
                      </div>
                    </footer>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </main>
      {capture && (
        <button
          onClick={() => setCapture(false)}
          className="exit-capture fixed bottom-5 right-6 z-30 rounded-xl bg-slate-900 px-4 py-2 text-xs text-white shadow-xl"
        >
          退出截图模式 · Esc
        </button>
      )}
      {toast && (
        <div
          role="status"
          className="animate-toast fixed left-1/2 top-6 z-[70] flex max-w-[92vw] -translate-x-1/2 items-center gap-2.5 rounded-2xl bg-slate-900/95 px-4 py-3 text-[13px] font-medium text-white shadow-2xl backdrop-blur"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/20">
            <Check className="h-3 w-3 text-emerald-300" strokeWidth={3} />
          </span>
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              className="ml-2 shrink-0 text-indigo-300"
              onClick={() =>
                act(async () => {
                  await api("/records/" + toast.undo.id + "/restore", "POST", {
                    version: toast.undo.version,
                  });
                  await saved("记录已恢复");
                })
              }
            >
              撤销
            </button>
          )}
          <button
            aria-label="关闭提示"
            className="ml-2 text-slate-400"
            onClick={() => setToast(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {notificationsOpen && user && (
        <Notifications
          key={user.id}
          onClose={() => setNotificationsOpen(false)}
          onChanged={() => refresh(true)}
          onOpen={async (entry) => {
            const next = await refresh(true);
            const record = next.records.find((r) => r.id === entry.record_id);
            if (!record) {
              notify("这条任务已被删除，提醒已标记为已读");
              return;
            }
            setNotificationsOpen(false);
            setDetailId(record.id);
          }}
        />
      )}
      {detailRecord && (
        <TaskDetail
          key={detailRecord.id}
          record={detailRecord}
          project={projects.find((p) => p.id === detailRecord.project_id)}
          records={records}
          user={user}
          members={state.members || []}
          onClose={() => setDetailId("")}
          onOpen={(r) => setDetailId(r.id)}
          onEdit={(r) => setModal({ type: "record", record: r })}
          onDelete={(r) => setModal({ type: "delete", record: r })}
          onAddChild={addChild}
          onLogin={() => setModal({ type: "auth" })}
          onChanged={contentChanged}
        />
      )}
      {modal?.type === "auth" && (
        <AuthDialog
          onClose={() => setModal(null)}
          onDone={async () => {
            const next = modal.next;
            setModal(null);
            try {
              await refresh(true);
              if (next?.type === "todos") {
                setTodosView(true);
                setOverview(false);
                setCapture(false);
                setModal(null);
              } else setModal(next || null);
              notify("已登录，可以开始填写了");
            } catch {
              notify("已登录；列表同步失败，请点重试");
            }
          }}
        />
      )}
      {modal?.type === "record" && editingProject && (
        <RecordDialog
          key={(modal.record?.id || "new") + ":" + (modal.record?.version || 0)}
          onReload={
            modal.record
              ? () => reloadRecord("record", modal.record.id)
              : undefined
          }
          record={modal.record}
          parent={modal.parent}
          project={editingProject}
          records={records}
          projects={projects}
          user={user}
          people={editingPeople}
          onClose={() => setModal(null)}
          onSave={async (b) => {
            await api(
              modal.record ? "/records/" + modal.record.id : "/records",
              modal.record ? "PATCH" : "POST",
              {
                ...b,
                ...(!modal.record && modal.parent
                  ? { parent_id: modal.parent.id }
                  : {}),
              },
            );
            if (!modal.record) resetFilters();
            await saved(modal.record ? "修改已保存" : "记录已提交");
          }}
        />
      )}
      {["project", "settings"].includes(modal?.type) && (
        <ProjectDialog
          key={modal.type + ":" + (modal.project?.version || 0)}
          onReload={
            modal.project ? () => reloadProject(modal.project.id) : undefined
          }
          project={modal.type === "settings" ? modal.project : null}
          people={
            modal.type === "settings"
              ? availablePeople(
                  modal.project,
                  records.filter((r) => r.project_id === modal.project?.id),
                  user,
                )
              : []
          }
          onClose={() => setModal(null)}
          onSave={async (b) => {
            if (modal.type === "settings") {
              await api("/projects/" + modal.project.id, "PATCH", b);
              await saved("项目设置已保存");
            } else {
              const result = await api("/projects", "POST", b);
              choose({ id: result.id });
              await saved("项目已创建");
            }
          }}
        />
      )}
      {modal?.type === "password" && (
        <PasswordDialog
          onClose={() => setModal(null)}
          onSave={async (b) => {
            await api("/password", "POST", b);
            await saved("密码已修改");
          }}
        />
      )}
      {modal?.type === "delete" && (
        <DeleteDialog
          key={modal.record.id + ":" + modal.record.version}
          onReload={() => reloadRecord("delete", modal.record.id)}
          record={modal.record}
          onClose={() => setModal(null)}
          onDelete={async () => {
            const r = modal.record,
              result = await api("/records/" + r.id, "DELETE", {
                version: r.version,
              });
            await saved("记录已删除", { id: r.id, version: result.version });
          }}
        />
      )}
      {modal?.type === "batch" && project && (
        <BatchDialog
          count={selectedRecords.length}
          people={people}
          onClose={() => setModal(null)}
          onSave={async (changes) => {
            const result = await batch("update", changes);
            setSelectedIds(new Set());
            await saved("已批量修改 " + result.count + " 项");
          }}
        />
      )}
      {modal?.type === "batch-delete" && project && (
        <BatchDeleteDialog
          records={selectedRecords}
          onClose={() => setModal(null)}
          onDelete={async () => {
            const result = await batch("delete");
            setSelectedIds(new Set());
            await saved("已删除 " + result.count + " 项", result.undo);
          }}
        />
      )}
      {modal?.type === "export" && project && (
        <ExportDialog
          project={project}
          records={filtered}
          tab={tab}
          filterLabel={filterLabel}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
