import { useCallback, useEffect, useRef, useState } from "react";
export async function api(route, method = "GET", data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch("/worklog/api" + route, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers:
        method === "GET"
          ? {}
          : { "Content-Type": "application/json", "X-Worklog-Request": "1" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(
        method === "GET"
          ? "同步超时，请重试"
          : "请求超时，请先刷新确认是否已保存",
      );
    throw new Error("网络连接失败，请检查网络后重试");
  } finally {
    clearTimeout(timer);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("服务暂不可用，请稍后重试");
  }
  if (!response.ok)
    throw Object.assign(new Error(result.error || "请求失败"), {
      status: response.status,
    });
  return result;
}
export function useWorkbench() {
  const [state, setState] = useState({ user: null, projects: [], records: [] }),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const serial = useRef(0),
    inflight = useRef(null);
  const refresh = useCallback(async (force = false) => {
    if (!force && inflight.current) return inflight.current;
    const seq = ++serial.current;
    const work = api("/state")
      .then((next) => {
        if (seq === serial.current) {
          setState(next);
          setLoaded(true);
          setError("");
        }
        return next;
      })
      .catch((e) => {
        if (seq === serial.current) setError(e.message);
        throw e;
      })
      .finally(() => {
        if (seq === serial.current) inflight.current = null;
      });
    inflight.current = work;
    return work;
  }, []);
  useEffect(() => {
    refresh().catch(() => {});
    const onVisible = () => {
      if (!document.hidden) refresh().catch(() => {});
    };
    const timer = setInterval(onVisible, 30000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      serial.current++;
    };
  }, [refresh]);
  return { state, loaded, error, refresh };
}
