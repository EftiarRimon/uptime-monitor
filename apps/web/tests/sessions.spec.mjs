/* global localStorage */
import { test, expect } from "@playwright/test";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

const identity = {
  user: { id: "1", name: "Alex", email: "alex@example.com" },
  workspace: { id: "1", name: "Acme", slug: "acme" },
  role: "owner",
};
const renewed = { ...identity, accessToken: "renewed-access" };
const monitor = {
  id: "7",
  name: "Production API",
  url: "https://example.com",
  interval_seconds: 60,
  is_paused: false,
  last_status: "pending",
  last_checked_at: null,
};
const unauthorized = (route) =>
  route.fulfill({ status: 401, json: { message: "Access expired" } });
const defaults = (route, path) =>
  path === "/auth/me"
    ? route.fulfill({ json: identity })
    : path === "/monitors"
      ? route.fulfill({ json: { monitors: [monitor] } })
      : path === "/incidents"
        ? route.fulfill({ json: { incidents: [] } })
        : route.fulfill({ status: 404, json: { message: "Not found" } });

test("parallel expired requests share one renewal and retry with the new access token", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "expired-access"),
  );
  let renewals = 0;
  let rejected = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/refresh") {
      renewals++;
      await gate;
      return route.fulfill({ json: renewed });
    }
    if (
      (path === "/monitors" || path === "/incidents") &&
      route.request().headers().authorization === "Bearer expired-access"
    ) {
      rejected++;
      return unauthorized(route);
    }
    return defaults(route, path);
  });
  try {
    await page.goto("/");
    await expect.poll(() => rejected).toBe(2);
    await expect.poll(() => renewals).toBe(1);
    release();
    await expect(page.getByRole("link", { name: monitor.name })).toBeVisible();
    await expect(
      page.getByText("No incidents recorded in this workspace."),
    ).toBeVisible();
    expect(renewals).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
      "renewed-access",
    );
  } finally {
    release();
  }
});

test("a refresh cookie can restore a saved session without a stored access token", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("pulseopsSession", "1"));
  let renewals = 0;
  await page.route("http://localhost:3001/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/refresh") {
      renewals++;
      return route.fulfill({ json: renewed });
    }
    return defaults(route, path);
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: monitor.name })).toBeVisible();
  expect(renewals).toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual([
    "accessToken",
    "pulseopsSession",
  ]);
});

test("temporary renewal failure keeps the saved session available for retry", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "expired-access"),
  );
  let unavailable = true;
  await page.route("http://localhost:3001/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/refresh")
      return unavailable
        ? route.fulfill({
            status: 503,
            json: { message: "Renewal temporarily unavailable" },
          })
        : route.fulfill({ json: renewed });
    if (route.request().headers().authorization === "Bearer expired-access")
      return unauthorized(route);
    return defaults(route, path);
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unable to load your workspace" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
    "expired-access",
  );
  unavailable = false;
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(page.getByRole("link", { name: monitor.name })).toBeVisible();
});

test("denied renewal returns to sign-in without a retry loop", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "expired-access"),
  );
  let renewals = 0;
  await page.route("http://localhost:3001/**", (route) => {
    if (new URL(route.request().url()).pathname === "/auth/refresh") renewals++;
    return unauthorized(route);
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(renewals).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
    null,
  );
});

test("history pages renew an expired access token before retrying", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "expired-access"),
  );
  let renewals = 0;
  await page.route("http://localhost:3001/**", (route) => {
    if (new URL(route.request().url()).pathname === "/auth/refresh") {
      renewals++;
      return route.fulfill({ json: renewed });
    }
    if (route.request().headers().authorization === "Bearer expired-access")
      return unauthorized(route);
    return route.fulfill({
      json: {
        monitor,
        period: {
          startsAt: "2026-10-20T12:00:00Z",
          endsAt: "2026-10-21T12:00:00Z",
          bucketSeconds: 3600,
        },
        summary: {
          totalChecks: 0,
          failedChecks: 0,
          uptimePercent: null,
          avgLatencyMs: null,
        },
        series: Array.from({ length: 24 }, (_, index) => ({
          bucketStart: new Date(
            Date.UTC(2026, 9, 20, 12 + index),
          ).toISOString(),
          totalChecks: 0,
          uptimePercent: null,
          avgLatencyMs: null,
        })),
        checks: [],
        incidents: [],
      },
    });
  });
  await page.goto("/monitors/7");
  await expect(
    page.getByRole("heading", { name: monitor.name, exact: true }),
  ).toBeVisible();
  expect(renewals).toBe(1);
});

test("logout waits for an in-flight rotation and prevents session resurrection", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "expired-access"),
  );
  let expire = false;
  let refreshing = false;
  let loggedOut = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/refresh") {
      refreshing = true;
      await gate;
      return route.fulfill({ json: renewed });
    }
    if (path === "/auth/logout") {
      loggedOut = true;
      return route.fulfill({ status: 204 });
    }
    if (expire && path !== "/auth/me") return unauthorized(route);
    return defaults(route, path);
  });
  try {
    await page.goto("/");
    await expect(page.getByRole("link", { name: monitor.name })).toBeVisible();
    expire = true;
    await page.getByRole("button", { name: "Refresh dashboard" }).click();
    await expect.poll(() => refreshing).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Signing out..." }),
    ).toBeDisabled();
    expect(loggedOut).toBe(false);
    release();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    expect(loggedOut).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
      null,
    );
    expect(
      await page.evaluate(() => localStorage.getItem("pulseopsSession")),
    ).toBe(null);
  } finally {
    release();
  }
});

test("two tabs serialize refresh so rotation is not mistaken for replay", async ({
  context,
}) => {
  await context.addInitScript(() => {
    if (!localStorage.getItem("accessToken"))
      localStorage.setItem("accessToken", "expired-access");
  });
  let rejected = 0;
  let renewals = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await context.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/refresh") {
      renewals++;
      await gate;
      return route.fulfill({ json: renewed });
    }
    if (
      (path === "/monitors" || path === "/incidents") &&
      route.request().headers().authorization === "Bearer expired-access"
    ) {
      rejected++;
      return unauthorized(route);
    }
    return defaults(route, path);
  });
  const first = await context.newPage();
  const second = await context.newPage();
  try {
    await Promise.all([first.goto("/"), second.goto("/")]);
    await expect.poll(() => rejected).toBe(4);
    release();
    await expect(first.getByRole("link", { name: monitor.name })).toBeVisible();
    await expect(
      second.getByRole("link", { name: monitor.name }),
    ).toBeVisible();
    expect(renewals).toBe(1);
  } finally {
    release();
  }
});

test("an account switch in another tab replaces the workspace and clears previous data", async ({
  context,
}) => {
  const tokenA = `header.${Buffer.from(JSON.stringify({ sessionId: "session-a" })).toString("base64url")}.signature`;
  const tokenB = `header.${Buffer.from(JSON.stringify({ sessionId: "session-b" })).toString("base64url")}.signature`;
  await context.addInitScript((value) => {
    if (!localStorage.getItem("accessToken"))
      localStorage.setItem("accessToken", value);
  }, tokenA);
  await context.route("http://localhost:3001/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const switched =
      route.request().headers().authorization === `Bearer ${tokenB}`;
    if (!switched) return defaults(route, path);
    if (path === "/auth/me")
      return route.fulfill({
        json: {
          ...identity,
          user: { ...identity.user, id: "2" },
          workspace: { id: "2", name: "Beta workspace", slug: "beta" },
        },
      });
    if (path === "/monitors")
      return route.fulfill({
        json: { monitors: [{ ...monitor, id: "8", name: "Beta API" }] },
      });
    if (path === "/incidents")
      return route.fulfill({ json: { incidents: [] } });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await expect(first.getByRole("link", { name: monitor.name })).toBeVisible();
  await second.goto("/");
  await second.evaluate(
    (value) => localStorage.setItem("accessToken", value),
    tokenB,
  );
  await expect(first.locator(".workspace-name")).toHaveText("Beta workspace");
  await expect(first.getByRole("link", { name: "Beta API" })).toBeVisible();
  await expect(first.getByRole("link", { name: monitor.name })).toHaveCount(0);
});
