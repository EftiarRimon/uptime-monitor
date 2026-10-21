/* global localStorage, document */
import { test, expect } from "@playwright/test";
import { URL } from "node:url";

const identity = {
  user: { id: "1", name: "Alex", email: "alex@example.com" },
  workspace: { id: "1", name: "Acme Engineering", slug: "acme" },
  role: "owner",
};
const monitor = {
  id: "7",
  name: "Production API",
  url: "https://api.example.com/health",
  interval_seconds: 60,
  is_paused: false,
  last_status: "up",
  last_checked_at: null,
};

async function dashboard(
  page,
  {
    session = identity,
    monitors = () => [monitor],
    incidents = [],
    override = async () => false,
  } = {},
) {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "dashboard-test-token"),
  );
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    if (await override(route, url)) return;
    if (url.pathname === "/auth/me") return route.fulfill({ json: session });
    if (url.pathname === "/auth/refresh")
      return route.fulfill({
        status: 401,
        json: { message: "Session expired" },
      });
    if (url.pathname === "/auth/logout") return route.fulfill({ status: 204 });
    if (url.pathname === "/monitors")
      return route.fulfill({ json: { monitors: monitors() } });
    if (url.pathname === "/incidents")
      return route.fulfill({ json: { incidents } });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
}

test("session restoration and loading do not flash sign-in or empty results", async ({
  page,
}) => {
  let releaseIdentity;
  let releaseMonitors;
  const identityGate = new Promise((resolve) => {
    releaseIdentity = resolve;
  });
  const monitorGate = new Promise((resolve) => {
    releaseMonitors = resolve;
  });
  await dashboard(page, {
    override: async (route, url) => {
      if (url.pathname === "/auth/me") {
        await identityGate;
        await route.fulfill({ json: identity });
        return true;
      }
      if (url.pathname === "/monitors") {
        await monitorGate;
        await route.fulfill({ json: { monitors: [] } });
        return true;
      }
      return false;
    },
  });
  try {
    await page.goto("/");
    await expect(page.getByText("Restoring your workspace...")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toHaveCount(0);
    releaseIdentity();
    await expect(page.getByText("Loading monitors...")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No monitors yet" }),
    ).toHaveCount(0);
    await expect(page.locator(".stats strong").first()).toHaveText("-");
    releaseMonitors();
    await expect(
      page.getByRole("heading", { name: "No monitors yet" }),
    ).toBeVisible();
    await expect(
      page.getByText("No incidents recorded in this workspace."),
    ).toBeVisible();
    await expect(page.locator(".workspace-name")).toHaveText(
      "Acme Engineering",
    );
  } finally {
    releaseIdentity();
    releaseMonitors();
  }
});

test("workspace restoration can be retried without losing the saved session", async ({
  page,
}) => {
  let unavailable = true;
  await dashboard(page, {
    override: async (route, url) => {
      if (url.pathname === "/auth/me" && unavailable) {
        await route.fulfill({
          status: 503,
          json: { message: "Workspace service unavailable" },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unable to load your workspace" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
    "dashboard-test-token",
  );
  unavailable = false;
  await page.getByRole("button", { name: "Retry workspace" }).click();
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
});

test("incident failure leaves monitors usable and the unknown count unset", async ({
  page,
}) => {
  let unavailable = true;
  await dashboard(page, {
    override: async (route, url) => {
      if (url.pathname === "/incidents" && unavailable) {
        await route.fulfill({
          status: 503,
          json: { message: "Incident service unavailable" },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
  await expect(page.locator(".incidents .error")).toContainText(
    "Incident service unavailable",
  );
  await expect(page.locator(".stats strong").nth(2)).toHaveText("-");
  unavailable = false;
  await page.getByRole("button", { name: "Retry incidents" }).click();
  await expect(
    page.getByText("No incidents recorded in this workspace."),
  ).toBeVisible();
  await expect(page.locator(".stats strong").nth(2)).toHaveText("0");
});

test("failed refresh keeps monitors visible and session intact until retry succeeds", async ({
  page,
}) => {
  let unavailable = false;
  await dashboard(page, {
    override: async (route, url) => {
      if (url.pathname === "/monitors" && unavailable) {
        await route.fulfill({
          status: 503,
          body: "<html>Unavailable</html>",
          contentType: "text/html",
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
  unavailable = true;
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(page.locator(".list .error")).toContainText(
    "Showing last loaded monitors.",
  );
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
    "dashboard-test-token",
  );
  unavailable = false;
  await page.getByRole("button", { name: "Retry monitors" }).click();
  await expect(page.locator(".list .error")).toHaveCount(0);
});

test("dashboard automatically refreshes after 30 seconds", async ({ page }) => {
  await page.clock.install();
  let name = monitor.name;
  await dashboard(page, { monitors: () => [{ ...monitor, name }] });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
  name = "Automatically updated API";
  await page.clock.runFor(30_000);
  await expect(page.getByRole("link", { name })).toBeVisible();
});

test("expired sessions clear dashboard data and return to sign-in", async ({
  page,
}) => {
  let expired = false;
  await dashboard(page, {
    override: async (route, url) => {
      if (url.pathname === "/monitors" && expired) {
        await route.fulfill({
          status: 401,
          json: { message: "Session expired" },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
  expired = true;
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your session has expired. Sign in again."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Production API" })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe(
    null,
  );
});

test("failed sign-in preserves credentials and enables retry on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("http://localhost:3001/auth/login", async (route) => {
    await gate;
    await route.abort("failed");
  });
  try {
    await page.goto("/");
    await page.getByLabel("Email").fill("alex@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in to dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Signing in..." }),
    ).toBeDisabled();
    release();
    await expect(page.locator(".login .error")).toContainText(
      "Unable to reach the service.",
    );
    await expect(
      page.getByRole("button", { name: "Sign in to dashboard" }),
    ).toBeEnabled();
    await expect(page.getByLabel("Email")).toHaveValue("alex@example.com");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    release();
  }
});

test("viewer dashboard hides write controls and fits long workspace and monitor names on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const name = "ProductionAPI".repeat(12);
  await dashboard(page, {
    session: {
      ...identity,
      workspace: { ...identity.workspace, name: "Engineering".repeat(15) },
      role: "viewer",
    },
    monitors: () => [{ ...monitor, name }],
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(
    page.getByText("You have viewer access.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add monitor" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("viewer-mobile.png"),
    fullPage: true,
  });
});

test("failed edits retain input and a successful retry resets the form", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let current = { ...monitor };
  let fail = true;
  await dashboard(page, {
    monitors: () => [current],
    override: async (route, url) => {
      if (
        url.pathname === "/monitors/7" &&
        route.request().method() === "PATCH"
      ) {
        if (fail)
          await route.fulfill({
            status: 400,
            json: { message: "Monitor update rejected" },
          });
        else {
          current = { ...current, name: route.request().postDataJSON().name };
          await route.fulfill({ json: { monitor: current } });
        }
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await page.getByLabel("Name", { exact: true }).fill("Updated Production API");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Monitor update rejected")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Updated Production API",
  );
  fail = false;
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Monitor updated.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Updated Production API" }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("owner-mobile.png"),
    fullPage: true,
  });
});
