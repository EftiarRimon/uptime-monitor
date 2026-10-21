/* global localStorage, document */
import { test, expect } from "@playwright/test";
import { URL } from "node:url";

function history(hours = 24, empty = false) {
  const count = hours === 24 ? 24 : hours === 168 ? 28 : 30;
  const bucketSeconds = (hours * 3600) / count;
  const endsAt = "2026-10-21T12:00:00.000Z";
  const start = new Date(endsAt).getTime() - hours * 3600_000;
  const monitor = {
    id: "7",
    name: "Production API",
    url: "https://api.example.com/health",
    last_status: "down",
    interval_seconds: 60,
    is_paused: false,
    last_checked_at: endsAt,
  };
  return {
    monitor,
    period: {
      hours,
      startsAt: new Date(start).toISOString(),
      endsAt,
      bucketSeconds,
    },
    summary: {
      totalChecks: empty ? 0 : 3,
      successfulChecks: empty ? 0 : 2,
      failedChecks: empty ? 0 : 1,
      uptimePercent: empty ? null : 200 / 3,
      avgLatencyMs: empty ? null : 200,
    },
    series: Array.from({ length: count }, (_, index) => ({
      bucketStart: new Date(start + index * bucketSeconds * 1000).toISOString(),
      totalChecks: !empty && index === count - 1 ? 3 : 0,
      uptimePercent: !empty && index === count - 1 ? 200 / 3 : null,
      avgLatencyMs: !empty && index === count - 1 ? 200 : null,
    })),
    checks: empty
      ? []
      : [
          {
            id: "17",
            status: "down",
            status_code: 503,
            response_time_ms: 10000,
            error_message: "HTTP 503",
            checked_at: endsAt,
          },
        ],
    incidents: empty
      ? []
      : [
          {
            id: "27",
            title: "API unavailable",
            status: "open",
            error_message: "HTTP 503",
            started_at: endsAt,
            resolved_at: null,
          },
        ],
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "browser-test-token"),
  );
});

test("navigate from dashboard, inspect charts, and change every period", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/me")
      return route.fulfill({
        json: {
          user: { id: "1", name: "Alex", email: "alex@example.com" },
          workspace: { id: "1", name: "Acme", slug: "acme" },
          role: "owner",
        },
      });
    if (url.pathname === "/monitors")
      return route.fulfill({ json: { monitors: [history().monitor] } });
    if (url.pathname === "/incidents")
      return route.fulfill({ json: { incidents: [] } });
    return route.fulfill({
      json: history(Number(url.searchParams.get("hours"))),
    });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Production API" }).click();
  await expect(
    page.getByRole("heading", { name: "Production API" }),
  ).toBeVisible();
  await expect(page.locator(".stats")).toContainText("66.67%");
  await expect(page.locator(".stats")).toContainText("200 ms");
  await expect(
    page.getByRole("group", { name: "Uptime per time bucket" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Incident timeline" }),
  ).toBeVisible();
  await expect(page.getByText("API unavailable")).toBeVisible();
  await page.locator(".history-chart .chart-point").first().focus();
  await expect(page.locator(".chart-caption").first()).toContainText("No data");
  for (const [hours, interval] of [
    ["168", "6-hour"],
    ["720", "24-hour"],
    ["24", "1-hour"],
  ]) {
    await page.getByLabel("Period").selectOption(hours);
    await expect(page.locator(".bucket-table summary")).toContainText(interval);
  }
  await page.locator(".bucket-table summary").click();
  await expect(
    page.getByRole("table", {
      name: "Aggregated checks for the selected period",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Production API" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("empty history stays readable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("http://localhost:3001/**", (route) =>
    route.fulfill({ json: history(24, true) }),
  );
  await page.goto("/monitors/7");
  await expect(page.locator(".stats strong").first()).toHaveText("No data");
  await expect(
    page.getByText("No checks recorded in this period."),
  ).toBeVisible();
  await expect(page.getByText("No incidents in this period.")).toBeVisible();
  await expect(
    page.getByText("No successful checks in this period."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("API failure can be retried", async ({ page }) => {
  let requests = 0;
  await page.route("http://localhost:3001/**", (route) =>
    ++requests === 1
      ? route.fulfill({
          status: 503,
          json: { message: "History is temporarily unavailable" },
        })
      : route.fulfill({ json: history() }),
  );
  await page.goto("/monitors/7");
  await expect(page.locator('.error[role="alert"]')).toContainText(
    "History is temporarily unavailable",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Production API" }),
  ).toBeVisible();
});

test("expired session explains how to sign in again", async ({ page }) => {
  await page.route("http://localhost:3001/**", (route) =>
    route.fulfill({ status: 401, json: { message: "Session expired" } }),
  );
  await page.goto("/monitors/7");
  await expect(page.locator('.error[role="alert"]')).toContainText(
    "Your session has expired.",
  );
  await expect(
    page.getByRole("link", { name: "Go to dashboard" }),
  ).toHaveAttribute("href", "/");
});
