import { DependencyPicker } from "./Relations.jsx";
import React, { useState } from "react";
import {
  Sparkles,
  Pencil,
  Trash2,
  Settings,
  FolderPlus,
  LogIn,
  KeyRound,
  ImageDown,
  Check,
  Plus,
  X,
  ListChecks,
} from "lucide-react";
import { api } from "../api.js";
import {
  COLORS,
  colorOf,
  splitNames,
  statistics,
  PRIORITIES,
  beijingDate,
  isCompleted,
  recordMonth,
} from "../model.js";
import { download, exportPicture } from "../picture.js";
import { PROJECT_KINDS } from "../checklist.js";
import PublicNotice from "./PublicNotice.jsx";
import {
  AvatarChip,
  DateBadge,
  Field,
  FormActions,
  FormError,
  inputClass,
  Modal,
  PersonPicker,
  primary,
  secondary,
} from "./UI.jsx";
export function AuthDialog({ onClose, onDone }) {
  const [mode, setMode] = useState("login"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/" + mode,
        "POST",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      await onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="欢迎来到项目工作台"
      sub="公开查看，凭成员邀请码注册后即可填写"
      icon={LogIn}
      onClose={onClose}
    >
      <div className="mx-6 mb-5 flex rounded-xl bg-slate-100 p-1">
        {[
          ["login", "登录"],
          ["register", "注册账号"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => {
              setMode(key);
              setError("");
            }}
            className={
              "flex-1 rounded-lg py-2 text-[13px] font-medium transition-all " +
              (mode === key
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-400")
            }
          >
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} key={mode}>
        <div className="space-y-5 px-6 pb-3">
          {mode === "register" && (
            <Field label="你的姓名">
              <input
                name="name"
                autoComplete="name"
                required
                maxLength={30}
                className={inputClass}
                placeholder="请填写真实姓名"
              />
            </Field>
          )}
          {mode === "register" && (
            <Field
              label="成员邀请码"
              hint="请向管理员领取与你姓名绑定的邀请码。"
            >
              <input
                name="invitationCode"
                required
                autoComplete="off"
                maxLength={160}
                className={inputClass}
                placeholder="输入个人邀请码"
              />
            </Field>
          )}
          <Field label="账号" hint="3–32 位字母、数字、下划线或短横线">
            <input
              name="login"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_\-]+"
              className={inputClass}
              placeholder="输入账号"
            />
          </Field>
          <Field label="密码">
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              className={inputClass}
              placeholder="至少 8 位"
            />
          </Field>
        </div>
        <FormError error={error} />
        <FormActions
          onClose={onClose}
          busy={busy}
          label={mode === "login" ? "登录" : "注册并开始填写"}
        />
      </form>
    </Modal>
  );
}
export function RecordDialog({
  records = [],
  projects = [],
  record,
  parent,
  project,
  people,
  onClose,
  onSave,
  onReload,
}) {
  const [owner, setOwner] = useState(
      record
        ? splitNames(record.owner)
        : parent
          ? splitNames(parent.owner)
          : [],
    ),
    [actual, setActual] = useState(record ? splitNames(record.actual) : []),
    [date, setDate] = useState(record?.date || ""),
    [dependencyIds, setDependencyIds] = useState(record?.dependency_ids || []),
    [blocked, setBlocked] = useState(Boolean(record?.blocked)),
    [helpers, setHelpers] = useState(splitNames(record?.support_people)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const firstChild =
    parent &&
    !parent.child_count &&
    !records.some((r) => r.parent_id === parent.id);
  const priorMonth = record && isCompleted(record) ? recordMonth(record) : "";
  const nextRecord = {
    ...record,
    actual: actual.join("、"),
    date,
    completed_at:
      record && isCompleted(record)
        ? record.completed_at
        : new Date().toISOString(),
  };
  const nextMonth = isCompleted(nextRecord) ? recordMonth(nextRecord) : "";
  async function submit(e) {
    e.preventDefault();
    if (!owner.length) return;
    const b = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...b,
        owner: owner.join("、"),
        dependency_ids: dependencyIds,
        blocked,
        blocker_note: blocked ? String(b.blocker_note || "") : "",
        support_people: helpers.join("、"),
        actual: actual.join("、"),
        project_id: project.id,
        version: record?.version,
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={record ? "编辑记录" : parent ? "添加子任务" : "记录完成"}
      sub={
        parent
          ? "上级任务：" + parent.task
          : project.name + " · 原定谁负责，实际谁完成"
      }
      icon={record ? Pencil : Sparkles}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="space-y-5 px-6 pb-2">
          <PublicNotice />
          {firstChild && (
            <p
              role="status"
              className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-700"
            >
              添加首个子任务后，上级任务将作为分组，不再单独计入完成数量；原记录和完成人仍保留。独立完成的工作可另记为具体子任务。
            </p>
          )}
          <Field label="工作事项">
            <textarea
              name="task"
              rows={2}
              required
              maxLength={300}
              defaultValue={record?.task || ""}
              placeholder="简要填写工作事项"
              className={inputClass}
            />
          </Field>
          <Field
            label="任务说明（选填）"
            hint="可补充背景、做法、验收标准或相关链接，最多 2000 字。"
          >
            <textarea
              name="description"
              rows={3}
              maxLength={2000}
              defaultValue={record?.description || ""}
              placeholder="例如：需要对接的系统、交付要求"
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="优先级">
              <select
                name="priority"
                aria-label="优先级"
                defaultValue={record?.priority || parent?.priority || "normal"}
                className={inputClass}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="计划完成日期（选填）"
              hint="用于临期和逾期提醒，不影响完成状态。"
            >
              <input
                type="date"
                name="due_date"
                aria-label="计划完成日期（选填）"
                defaultValue={record?.due_date || ""}
                className={inputClass}
              />
            </Field>
          </div>
          <PersonPicker
            label="原定负责人（可多选）"
            selected={owner}
            onChange={setOwner}
            people={people}
            multi
          />
          <details
            open={Boolean(
              record?.dependency_ids?.length ||
                record?.blocked ||
                record?.support_people,
            )}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4"
          >
            <summary className="cursor-pointer text-[13px] font-medium text-slate-600">
              依赖与阻塞（选填）
            </summary>
            <div className="mt-4 space-y-5">
              <DependencyPicker
                selected={dependencyIds}
                onChange={setDependencyIds}
                records={records}
                projects={projects}
                currentId={record?.id}
                known={record?.dependency_tasks || []}
              />
              <label className="flex cursor-pointer items-start gap-2 text-[13px] text-slate-600">
                <input
                  type="checkbox"
                  aria-label="手动标记阻塞"
                  checked={blocked}
                  onChange={(e) => setBlocked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                />
                <span>
                  手动标记阻塞
                  <small className="mt-1 block text-[11px] leading-relaxed text-slate-400">
                    前置任务尚未完成时会自动阻塞；其他需要等待的情况也可手动标记。
                  </small>
                </span>
              </label>
              {blocked && (
                <Field label="阻塞说明（选填）">
                  <textarea
                    name="blocker_note"
                    rows={2}
                    maxLength={500}
                    defaultValue={record?.blocker_note || ""}
                    placeholder="例如：等待设备到货或接口确认"
                    className={inputClass}
                  />
                </Field>
              )}
              <PersonPicker
                label="需要配合的人（可多选）"
                hint="指定后，对方可以在“需要我配合”中查看，并收到站内提醒。"
                selected={helpers}
                onChange={setHelpers}
                people={[
                  ...new Set([
                    ...people,
                    ...records.flatMap((r) => [
                      ...splitNames(r.owner),
                      ...splitNames(r.actual),
                      ...splitNames(r.support_people),
                    ]),
                  ]),
                ]}
                multi
              />
            </div>
          </details>
          <PersonPicker
            label="实际完成人（可多选）"
            hint="选填；实际完成人和完成日期任填一项即为完成。"
            selected={actual}
            onChange={setActual}
            people={people}
            multi
          />
          <Field
            label={
              <>
                完成日期{" "}
                <span className="ml-1 text-xs font-normal text-slate-400">
                  选填
                </span>
              </>
            }
            hint="选填；未填日期保持空白，两项都空才显示未完成。"
          >
            <input
              type="date"
              name="date"
              aria-label="完成日期（选填）"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </Field>
          {priorMonth && nextMonth && priorMonth !== nextMonth && (
            <p
              role="status"
              className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-700"
            >
              保存后，统计月份将从 {priorMonth} 调整为 {nextMonth}
              。已导出的历史核对结果不会自动更新。
            </p>
          )}
        </div>
        <FormError error={error} onReload={onReload} />
        <FormActions
          onClose={onClose}
          busy={busy}
          disabled={!owner.length}
          label={record ? "保存修改" : parent ? "创建子任务" : "提交记录"}
        />
      </form>
    </Modal>
  );
}
export function ProjectDialog({
  project,
  people = [],
  onClose,
  onSave,
  onReload,
}) {
  const [checklist, setChecklist] = useState(""),
    [templates, setTemplates] = useState([]),
    [color, setColor] = useState(project?.color || "indigo"),
    [members, setMembers] = useState(project?.members || []),
    [archived, setArchived] = useState(Boolean(project?.archived)),
    [entry, setEntry] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function add() {
    const names = splitNames(entry);
    if (names.some((n) => n.length > 30)) {
      setError("每个成员姓名最多 30 字");
      return;
    }
    setMembers((a) => [...new Set([...a, ...names])]);
    setEntry("");
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const name = new FormData(e.currentTarget).get("name");
      await onSave({
        name,
        color,
        members: [...new Set([...members, ...splitNames(entry)])],
        ...(project ? { archived } : { checklist }),
        version: project?.version,
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={project ? "项目设置" : "新建项目"}
      sub={
        project
          ? "管理项目名称、标识色和常用成员"
          : "创建一个新的工作完成记录项目"
      }
      icon={project ? Settings : FolderPlus}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="space-y-5 px-6 pb-2">
          <Field label="项目名称">
            <input
              name="name"
              required
              maxLength={60}
              defaultValue={project?.name || ""}
              placeholder="例如：示例项目 二期改造"
              className={inputClass}
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-slate-600">
              标识色
              <span className="ml-2 text-xs font-normal text-slate-400">
                {colorOf(color).label}
              </span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  aria-label={c.label}
                  aria-pressed={color === c.id}
                  title={c.label}
                  onClick={() => setColor(c.id)}
                  className="project-color flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border-2 p-1 text-white transition-colors"
                  style={{
                    borderColor: color === c.id ? c.to : "transparent",
                  }}
                >
                  <span
                    className="flex h-full w-full items-center justify-center rounded-[10px]"
                    style={{
                      background:
                        "linear-gradient(135deg," + c.from + "," + c.to + ")",
                    }}
                  >
                    {color === c.id && (
                      <Check className="h-4 w-4" strokeWidth={3} />
                    )}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-slate-600">
              常用成员
            </legend>
            <div className="flex flex-wrap gap-2">
              {members.map((n) => (
                <span
                  key={n}
                  className="flex items-center gap-1 rounded-full bg-slate-50 py-1 pl-1 pr-2 ring-1 ring-slate-200"
                >
                  <AvatarChip name={n} />
                  <button
                    type="button"
                    aria-label={"移除 " + n}
                    className="rounded-full p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                    onClick={() => setMembers((a) => a.filter((x) => x !== n))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                aria-label="添加项目成员"
                placeholder="输入姓名，多人用顿号分隔"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                maxLength={1000}
                className={inputClass}
              />
              <button
                type="button"
                onClick={add}
                disabled={!entry.trim()}
                className={secondary + " shrink-0 px-3"}
              >
                <Plus className="h-3.5 w-3.5" />
                添加
              </button>
            </div>
            {people.filter((n) => !members.includes(n)).length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>记录中的成员</span>
                {people
                  .filter((n) => !members.includes(n))
                  .slice(0, 12)
                  .map((n) => (
                    <button
                      type="button"
                      key={n}
                      onClick={() => setMembers((a) => [...a, n])}
                      className="rounded-full border border-dashed border-slate-200 px-2 py-1 hover:border-indigo-300 hover:text-indigo-500"
                    >
                      + {n}
                    </button>
                  ))}
              </div>
            )}
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              用于填写时快捷选择姓名，移除不会改动历史记录。
            </p>
          </fieldset>
          {!project && (
            <Field
              label="资料清单"
              hint="按项目类型生成应交资料清单（合同、配置记录、验收单等），之后可在“项目资料”中增删。"
            >
              <select
                value={checklist}
                onChange={(e) => setChecklist(e.target.value)}
                onFocus={() => {
                  if (!templates.length)
                    api("/checklist-templates")
                      .then((r) => setTemplates(r.templates))
                      .catch(() => {});
                }}
                className={inputClass}
              >
                <option value="">暂不生成</option>
                {PROJECT_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
                {templates.map((t) => (
                  <option key={t.id} value={"template:" + t.id}>
                    模板：{t.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {project && (
            <label className="flex cursor-pointer items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 text-[13px] text-slate-600">
              <input
                type="checkbox"
                aria-label="归档此项目"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
              />
              <span>
                归档此项目
                <small className="mt-1 block text-[11px] leading-relaxed text-slate-400">
                  项目结束后可归档：侧栏收进“已归档”，不再计入我的待办和到期提醒。记录、资料和日志全部保留，仍可查看和修改，随时可取消归档。
                </small>
              </span>
            </label>
          )}
        </div>
        <FormError error={error} onReload={onReload} />
        <FormActions
          busy={busy}
          onClose={onClose}
          label={project ? "保存设置" : "创建项目"}
        />
      </form>
    </Modal>
  );
}
export function PasswordDialog({ onClose, onSave }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title="修改密码"
      sub="更换后其他登录会话将退出"
      icon={KeyRound}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSave(Object.fromEntries(new FormData(e.currentTarget)));
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-5 px-6 pb-2">
          <Field label="原密码">
            <input
              name="oldPassword"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="current-password"
              className={inputClass}
            />
          </Field>
          <Field label="新密码">
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              className={inputClass}
            />
          </Field>
        </div>
        <FormError error={error} />
        <FormActions onClose={onClose} busy={busy} label="修改密码" />
      </form>
    </Modal>
  );
}
export function DeleteDialog({ record, onClose, onDelete, onReload }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="删除这条记录？"
      sub="若有子任务会一起删除，可通过提示一起撤销"
      icon={Trash2}
      tone="rose"
      onClose={onClose}
    >
      <div className="px-6 pb-2">
        <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100">
          <DateBadge date={record.date} actual={record.actual} />
          <div className="mt-3 whitespace-pre-wrap break-words text-sm font-medium text-slate-800">
            {record.task}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
            <span>原定 {record.owner}</span>
            <span>|</span>
            <span>实际 {record.actual}</span>
          </div>
        </div>
      </div>
      <FormError error={error} onReload={onReload} />
      <div className="flex justify-end gap-2.5 px-6 py-5">
        <button
          onClick={onClose}
          className="rounded-xl px-4 py-2 text-[13px] text-slate-500 hover:bg-slate-100"
        >
          再想想
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-xl bg-gradient-to-b from-rose-500 to-rose-600 px-5 py-2 text-[13px] font-medium text-white shadow-lg shadow-rose-600/25 hover:shadow-xl disabled:opacity-50"
        >
          {busy ? "删除中…" : "确认删除"}
        </button>
      </div>
    </Modal>
  );
}
export function BatchDialog({ count, people, onClose, onSave }) {
  const [actual, setActual] = useState([]),
    [date, setDate] = useState(""),
    [priority, setPriority] = useState(""),
    [dueMode, setDueMode] = useState("keep"),
    [due, setDue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const changes = {
    ...(actual.length ? { actual: actual.join("、") } : {}),
    ...(date ? { date } : {}),
    ...(priority ? { priority } : {}),
    ...(dueMode === "clear"
      ? { due_date: "" }
      : dueMode === "set" && due
        ? { due_date: due }
        : {}),
  };
  async function submit(e) {
    e.preventDefault();
    if (!Object.keys(changes).length) return;
    setBusy(true);
    setError("");
    try {
      await onSave(changes);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="批量修改"
      sub={"已选 " + count + " 项 · 只修改填写的内容，其余保持不变"}
      icon={ListChecks}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="space-y-5 px-6 pb-2">
          <PersonPicker
            label="实际完成人（可多选）"
            hint="选填；选择后会替换所选记录原有的实际完成人。"
            selected={actual}
            onChange={setActual}
            people={people}
            multi
          />
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="完成日期（选填）">
                <input
                  type="date"
                  aria-label="批量完成日期"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>
            <button
              type="button"
              onClick={() => setDate(beijingDate())}
              className={secondary + " shrink-0 px-3"}
            >
              今天
            </button>
          </div>
          <p className="-mt-3 text-xs leading-relaxed text-slate-400">
            实际完成人或完成日期任填一项，所选记录即标记为完成。填写完成日期会按该日期重新计算统计月份。
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="优先级">
              <select
                aria-label="批量优先级"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={inputClass}
              >
                <option value="">保持不变</option>
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <Field label="计划完成日期">
                <select
                  aria-label="批量计划日期方式"
                  value={dueMode}
                  onChange={(e) => setDueMode(e.target.value)}
                  className={inputClass}
                >
                  <option value="keep">保持不变</option>
                  <option value="set">设置为…</option>
                  <option value="clear">清除计划日期</option>
                </select>
              </Field>
              {dueMode === "set" && (
                <input
                  type="date"
                  aria-label="批量计划完成日期"
                  required
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  className={inputClass + " mt-2"}
                />
              )}
            </div>
          </div>
        </div>
        <FormError error={error} />
        <FormActions
          onClose={onClose}
          busy={busy}
          disabled={!Object.keys(changes).length}
          label={"应用到 " + count + " 项"}
        />
      </form>
    </Modal>
  );
}
export function BatchDeleteDialog({ records, onClose, onDelete }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={"删除所选 " + records.length + " 项？"}
      sub="子任务会一起删除，可通过提示一次撤销"
      icon={Trash2}
      tone="rose"
      onClose={onClose}
    >
      <div className="px-6 pb-2">
        <ul className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-100">
          {records.slice(0, 6).map((r) => (
            <li key={r.id} className="break-words">
              · {r.task}
            </li>
          ))}
          {records.length > 6 && (
            <li className="text-xs text-slate-400">等共 {records.length} 项</li>
          )}
        </ul>
      </div>
      <FormError error={error} />
      <div className="flex justify-end gap-2.5 px-6 py-5">
        <button
          onClick={onClose}
          className="rounded-xl px-4 py-2 text-[13px] text-slate-500 hover:bg-slate-100"
        >
          再想想
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-xl bg-gradient-to-b from-rose-500 to-rose-600 px-5 py-2 text-[13px] font-medium text-white shadow-lg shadow-rose-600/25 hover:shadow-xl disabled:opacity-50"
        >
          {busy ? "删除中…" : "确认删除"}
        </button>
      </div>
    </Modal>
  );
}
export function ExportDialog({ project, records, tab, filterLabel, onClose }) {
  const [scope, setScope] = useState("all"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  const s = statistics(records);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const next = await exportPicture({
        project: project.name,
        records,
        mode:
          scope === "stats"
            ? "overview"
            : tab === "people"
              ? "people"
              : "records",
        filterLabel,
      });
      if (result) URL.revokeObjectURL(result.url);
      setResult(next);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  React.useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result],
  );
  return (
    <Modal
      title={result ? "图片已生成" : "导出图片"}
      sub="生成一张可直接发群的工作完成记录图"
      icon={ImageDown}
      wide={!!result}
      onClose={onClose}
    >
      {result ? (
        <>
          <div className="mx-6 max-h-[58dvh] overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50">
            <img
              src={result.url}
              alt="工作完成记录导出图片"
              className="w-full"
            />
          </div>
          <p className="px-6 pt-3 text-xs text-slate-400">
            可以下载后发群，也可以长按图片保存。
          </p>
          <div className="flex justify-end gap-3 px-6 py-5">
            <button className={secondary} onClick={() => setResult(null)}>
              调整内容
            </button>
            <button
              className={primary}
              onClick={() => download(result.blob, result.filename)}
            >
              <ImageDown className="h-4 w-4" />
              下载图片
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-5 px-6 pb-2">
            <div className="overflow-hidden rounded-2xl ring-1 ring-slate-200">
              <div className="bg-gradient-to-br from-[#0C1322] to-[#1B2A4A] px-5 py-4 text-white">
                <div className="text-[10px] tracking-[0.15em] text-indigo-300">
                  {project.name}
                </div>
                <div className="mt-1 text-[15px] font-bold">工作完成记录</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {filterLabel}
                </div>
              </div>
              <div className="flex divide-x divide-slate-100 bg-white">
                {[
                  [s.total, "完成记录"],
                  [s.people, "参与成员"],
                  [
                    tab === "people" ? "按人汇总" : "完成明细",
                    scope === "all" ? "含完整列表" : "仅统计",
                  ],
                ].map(([v, l]) => (
                  <div key={l} className="flex-1 px-3 py-3 text-center">
                    <div className="text-sm font-bold text-slate-800">{v}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-slate-600">
                导出内容
              </legend>
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  ["all", "统计 + 当前视图", "含筛选结果的全部页"],
                  ["stats", "仅统计概览", "只展示顶部数据"],
                ].map(([key, label, desc]) => (
                  <button
                    key={key}
                    aria-pressed={scope === key}
                    onClick={() => setScope(key)}
                    className={
                      "rounded-2xl border-2 p-3.5 text-left transition-all active:scale-[0.98] " +
                      (scope === key
                        ? "border-indigo-400 bg-indigo-50/60"
                        : "border-slate-200 hover:border-slate-300")
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-700">
                        {label}
                      </span>
                      {scope === key && (
                        <Check className="h-4 w-4 shrink-0 text-indigo-500" />
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      {desc}
                    </div>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
          <FormError error={error} />
          <div className="flex justify-end gap-2.5 px-6 py-5">
            <button
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-[13px] text-slate-500 hover:bg-slate-100"
            >
              取消
            </button>
            <button onClick={generate} disabled={busy} className={primary}>
              <ImageDown className="h-4 w-4" />
              {busy ? "生成中…" : "生成图片"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
