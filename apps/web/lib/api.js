/* global process, fetch, localStorage, navigator, window, CustomEvent, atob */
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
export const apiBase = API;

let refreshPromise = null;
let generation = 0;
const cancelled = () =>
  Object.assign(new Error("Request cancelled"), { name: "AbortError" });

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function rememberSession(session) {
  localStorage.setItem("accessToken", session.accessToken);
  localStorage.setItem("pulseopsSession", "1");
  window.dispatchEvent(
    new CustomEvent("pulseops:session", { detail: session }),
  );
}
export function forgetSession() {
  generation += 1;
  localStorage.removeItem("accessToken");
  localStorage.removeItem("pulseopsSession");
}
const withSessionLock = (callback) =>
  navigator.locks
    ? navigator.locks.request("pulseops-session", callback)
    : callback();

// Used only to detect account switches between tabs; the API validates all claims.
export function sameSession(left, right) {
  try {
    const decode = (token) =>
      JSON.parse(
        atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      ).sessionId;
    const id = decode(left);
    return typeof id === "string" && id === decode(right);
  } catch {
    return false;
  }
}

async function send(path, { token, method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      signal,
      credentials: "include",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(
      "Unable to reach the service. Check your connection and try again.",
      0,
    );
  }
  if (response.status === 204) return null;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      "The service returned an unexpected response. Try again.",
      response.status,
    );
  }
  if (!response.ok)
    throw new ApiError(
      typeof result?.message === "string"
        ? result.message
        : "Unable to complete the request. Try again.",
      response.status,
    );
  return result;
}

export function refreshSession(failedToken = null) {
  if (!refreshPromise) {
    const started = generation;
    refreshPromise = withSessionLock(async () => {
      if (started !== generation) throw cancelled();
      const current = localStorage.getItem("accessToken");
      if (failedToken && current && current !== failedToken)
        return { accessToken: current };
      const session = await send("/auth/refresh", { method: "POST" });
      if (started !== generation) throw cancelled();
      if (typeof session?.accessToken !== "string")
        throw new ApiError("Unable to renew the session. Try again.", 502);
      rememberSession(session);
      return session;
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function login(mode, body) {
  generation += 1;
  return withSessionLock(async () => {
    const session = await send(`/auth/${mode}`, { method: "POST", body });
    rememberSession(session);
    return session;
  });
}

export async function logout() {
  generation += 1;
  await withSessionLock(() =>
    send("/auth/logout", {
      method: "POST",
      token: localStorage.getItem("accessToken"),
    }),
  );
  forgetSession();
}

export async function request(path, options = {}) {
  const started = generation;
  const token = options.token
    ? localStorage.getItem("accessToken") || options.token
    : null;
  try {
    return await send(path, { ...options, token });
  } catch (error) {
    if (
      error.status !== 401 ||
      !token ||
      [
        "/auth/login",
        "/auth/register",
        "/auth/logout",
        "/auth/refresh",
      ].includes(path)
    )
      throw error;
    const session = await refreshSession(token);
    if (options.signal?.aborted || started !== generation) throw cancelled();
    return send(path, { ...options, token: session.accessToken });
  }
}
