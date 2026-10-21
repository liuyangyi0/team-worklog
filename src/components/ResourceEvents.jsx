import React, { useCallback, useEffect, useRef, useState } from "react";
import { History, LockKeyhole, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { FormError, primary, secondary } from "./UI.jsx";

const objects = {
  document: "文档",
  folder: "目录",
  release: "交付归档",
  resource: "资源",
  "resource-category": "资源分类",
  deployment: "项目部署",
  environment: "环境",
  credential: "账号",
  configuration: "配置",
  upload: "上传",
  note: "随手记",
  checklist: "资料清单",
  "checklist-template": "清单模板",
};
const actions = {
  create: "新建",
  update: "修改",
  delete: "移入回收站",
  restore: "恢复",
  publish: "发布正式版",
  reveal: "查看敏感内容",
  checkout: "开始修改",
  "release-checkout": "结束修改",
  "restore-version": "恢复历史版本",
  "select-version": "采用工作版本",
  upload: "上传版本",
  apply: "登记配置使用",
  "apply-checklist": "套用资料清单",
  "attach-note": "添加附件",
  "detach-note": "移除附件",
};
function describe(event) {
  if (actions[event.action]) return actions[event.action];
  for (const [verb, label] of Object.entries(actions))
    if (
      event.action.startsWith(verb + "-") ||
      event.action.endsWith("-" + verb)
    )
      return label;
  return event.action;
}
export default function ResourceEvents({ project, user, onLogin }) {
  const [entries, setEntries] = useState([]),
    [cursor, setCursor] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const seq = useRef(0);
  const load = useCallback(
    async (before) => {
      if (!project || !user) return;
      const serial = ++seq.current;
      setBusy(true);
      setError("");
      try {
        const result = await api(
          "/resource-events?project_id=" +
            encodeURIComponent(project.id) +
            (before ? "&before=" + before : ""),
        );
        if (serial !== seq.current) return;
        setEntries((old) =>
          before
            ? [
                ...old,
                ...result.entries.filter(
                  (row) => !old.some((item) => item.id === row.id),
                ),
              ]
            : result.entries,
        );
        setCursor(result.nextCursor);
      } catch (e) {
        if (serial === seq.current) setError(e.message);
      } finally {
        if (serial === seq.current) setBusy(false);
      }
    },
    [project?.id, user?.id],
  );
  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load]);
  return (
    <section className="pt-8" aria-label="资料操作日志">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            资料日志
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            文件、资源、账号和配置的操作记录，成员可查看，日志不可删除。
          </p>
        </div>
        {user && (
          <button className={secondary} disabled={busy} onClick={() => load()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        )}
      </div>
      {!user ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center">
          <LockKeyhole className="mx-auto mb-3 h-7 w-7 text-indigo-400" />
          <p className="mb-5 text-sm text-slate-500">登录后查看项目资料日志</p>
          <button className={primary} onClick={onLogin}>
            注册 / 登录
          </button>
        </div>
      ) : (
        <>
          <FormError error={error} />
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {!entries.length ? (
              <p className="py-14 text-center text-sm text-slate-400">
                {busy ? "正在加载日志…" : "暂无资料操作记录"}
              </p>
            ) : (
              <ol className="divide-y divide-slate-100">
                {entries.map((event) => (
                  <li key={event.id} className="flex gap-3 px-5 py-4">
                    <span className="mt-1 rounded-xl bg-indigo-50 p-2 text-indigo-400">
                      <History className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <strong className="text-slate-700">
                          {event.actor_name}
                        </strong>
                        <span className="text-xs text-slate-400">
                          @{event.actor_login}
                        </span>
                        <span className="text-slate-500">
                          {describe(event)}
                        </span>
                        <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs text-slate-400">
                          {objects[event.entity_type] || event.entity_type}
                        </span>
                      </div>
                      <p className="mt-1.5 break-all text-sm text-slate-600">
                        {event.details?.title ||
                          event.details?.name ||
                          event.details?.filename ||
                          event.entity_id}
                      </p>
                      {event.details?.fields?.length > 0 && (
                        <p className="mt-1 text-xs text-slate-400">
                          修改字段：{event.details.fields.join("、")}
                        </p>
                      )}
                      <time className="mt-2 block text-[11px] text-slate-400">
                        {new Date(event.created).toLocaleString("zh-CN", {
                          timeZone: "Asia/Shanghai",
                          hour12: false,
                        })}{" "}
                        · #{event.id}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {cursor && (
            <button
              className={secondary + " mt-4 w-full"}
              disabled={busy}
              onClick={() => load(cursor)}
            >
              加载更早记录
            </button>
          )}
        </>
      )}
    </section>
  );
}
