import React, { useEffect, useState } from "react";
import { Users, Copy, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import {
  Field,
  FormError,
  inputClass,
  Modal,
  primary,
  secondary,
} from "./UI.jsx";

const labels = {
  "create-invitation": "生成邀请",
  "revoke-invitation": "撤销邀请",
  "disable-member": "停用成员",
  "enable-member": "恢复成员",
  "reset-password": "重置登录密码",
};

export default function MemberManagement({ onClose, onChanged }) {
  const [members, setMembers] = useState([]),
    [names, setNames] = useState([]),
    [invitations, setInvitations] = useState([]),
    [events, setEvents] = useState([]),
    [name, setName] = useState(""),
    [issued, setIssued] = useState(null),
    [resetTarget, setResetTarget] = useState(null),
    [nextPassword, setNextPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function load() {
    const [people, invites, history] = await Promise.all([
      api("/admin/members"),
      api("/admin/invitations"),
      api("/admin/member-events"),
    ]);
    setMembers(people.members);
    setNames(people.registrationNames);
    setInvitations(invites.invitations);
    setEvents(history.entries);
  }
  useEffect(() => {
    let live = true;
    load()
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  async function mutate(fn, success) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
      await onChanged?.();
      setMessage(success);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const available = names.filter((n) => !members.some((m) => m.name === n));
  return (
    <Modal
      title="成员与邀请"
      sub="成员内容权限相同，账号管理由管理员维护"
      icon={Users}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="space-y-5 px-6 pb-6">
        <p className="rounded-xl bg-slate-50 p-3 text-xs leading-6 text-slate-500">
          一人使用一个账号。新成员凭本人姓名和一次性邀请码注册，邀请 7
          天有效。停用会立即退出该成员的全部会话；历史记录保留。
        </p>
        <fieldset
          disabled={busy || loading}
          className="rounded-2xl border border-slate-200 p-4"
        >
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              mutate(async () => {
                setIssued(await api("/admin/invitations", "POST", { name }));
              }, "邀请已生成；请将邀请码单独交给本人。");
            }}
          >
            <div className="min-w-0 flex-1">
              <Field label="邀请成员">
                <select
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                >
                  <option value="">选择姓名</option>
                  {available.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </Field>
            </div>
            <button className={primary} type="submit">
              生成邀请
            </button>
          </form>
          {issued && (
            <div className="mt-4 rounded-xl bg-indigo-50 p-3 text-xs text-indigo-700">
              <p className="font-medium">{issued.name} 的邀请码 · 仅本次显示</p>
              <code className="mt-2 block break-all rounded-lg bg-white p-2 select-all">
                {issued.code}
              </code>
              <p className="mt-2">
                到期：
                {new Date(issued.expires_at).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </p>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.code);
                    setMessage("邀请码已复制");
                  } catch {
                    setError("无法复制，请手动选中邀请码复制");
                  }
                }}
              >
                <Copy className="h-3 w-3" />
                复制邀请码
              </button>
              <button
                type="button"
                className="ml-4"
                onClick={() => setIssued(null)}
              >
                隐藏
              </button>
            </div>
          )}
        </fieldset>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">成员账号</h3>
          {loading ? (
            <p className="text-xs text-slate-400">正在加载…</p>
          ) : (
            members.map((m) => (
              <div
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-3"
              >
                <div className="min-w-0 text-sm text-slate-700">
                  <span className="font-medium">{m.name}</span>
                  <span className="ml-2 break-all text-xs text-slate-400">
                    {m.login}
                  </span>
                  <p className="mt-1 text-xs text-slate-400">
                    {m.role === "admin" ? "管理员" : "成员"} ·{" "}
                    {m.disabled_at ? "已停用" : "可用"}
                    {members.filter((v) => v.name === m.name).length > 1
                      ? " · 历史同名账号，请人工核对"
                      : ""}
                  </p>
                </div>
                <div className="flex gap-3 text-xs">
                  <button
                    disabled={busy}
                    className="text-slate-500 disabled:opacity-40"
                    onClick={() =>
                      mutate(
                        () =>
                          api(`/admin/members/${m.id}/status`, "POST", {
                            disabled: !m.disabled_at,
                          }),
                        m.disabled_at
                          ? "成员已恢复，需重新登录"
                          : "账号已停用，全部会话已退出",
                      )
                    }
                  >
                    {m.disabled_at ? "恢复账号" : "停用"}
                  </button>
                  <button
                    disabled={busy}
                    className="text-indigo-600 disabled:opacity-40"
                    onClick={() => {
                      setResetTarget(m);
                      setNextPassword("");
                      setError("");
                    }}
                  >
                    重置密码
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        {resetTarget && (
          <form
            className="space-y-3 rounded-xl border border-amber-100 bg-amber-50/50 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              mutate(async () => {
                await api(
                  `/admin/members/${resetTarget.id}/reset-password`,
                  "POST",
                  { password: nextPassword },
                );
                setResetTarget(null);
                setNextPassword("");
              }, "登录密码已重置，全部会话已退出；请单独交给本人并让其及时改密。");
            }}
          >
            <Field
              label={`重置 ${resetTarget.name} 的登录密码`}
              hint="只改本系统登录密码，不改变设备、数据库或软件密码"
            >
              <input
                type="password"
                required
                minLength={8}
                maxLength={128}
                value={nextPassword}
                onChange={(e) => setNextPassword(e.target.value)}
                autoComplete="new-password"
                disabled={busy}
                className={inputClass}
              />
            </Field>
            <div className="flex gap-3">
              <button disabled={busy} className={primary}>
                确认重置并退出全部会话
              </button>
              <button
                type="button"
                disabled={busy}
                className={secondary}
                onClick={() => {
                  setResetTarget(null);
                  setNextPassword("");
                }}
              >
                取消
              </button>
            </div>
          </form>
        )}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">未使用的邀请</h3>
          {invitations
            .filter(
              (i) =>
                !i.consumed_at &&
                !i.revoked_at &&
                Date.parse(i.expires_at) > Date.now(),
            )
            .map((i) => (
              <div
                className="flex items-center justify-between gap-2 text-xs text-slate-500"
                key={i.id}
              >
                <span>
                  {i.name} ·{" "}
                  {new Date(i.expires_at).toLocaleDateString("zh-CN")} 到期
                </span>
                <button
                  disabled={busy}
                  className="text-indigo-600"
                  onClick={() =>
                    mutate(async () => {
                      await api(
                        `/admin/invitations/${i.id}/revoke`,
                        "POST",
                        {},
                      );
                      if (issued?.id === i.id) setIssued(null);
                    }, "邀请已撤销")
                  }
                >
                  撤销
                </button>
              </div>
            ))}
        </div>
        <details className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
          <summary className="cursor-pointer">
            账号管理记录（最近 100 条）
          </summary>
          <div className="mt-3 space-y-2">
            {events.map((e) => (
              <p key={e.id}>
                {e.actor_name} · {labels[e.action] || e.action} ·{" "}
                {e.target_name} ·{" "}
                {new Date(e.created_at).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </p>
            ))}
          </div>
        </details>
        <p className="text-xs leading-6 text-slate-400">
          停用账号无法收回成员已保存的设备密码；涉及离职或泄露时，请另外在真实设备或服务中更换。
        </p>
        {message && (
          <p
            role="status"
            className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700"
          >
            {message}
          </p>
        )}
        <FormError error={error} />
        <button
          type="button"
          disabled={busy || loading}
          className={secondary}
          onClick={() => mutate(load, "已刷新")}
        >
          <RefreshCw className="h-4 w-4" />
          刷新列表
        </button>
      </div>
    </Modal>
  );
}
