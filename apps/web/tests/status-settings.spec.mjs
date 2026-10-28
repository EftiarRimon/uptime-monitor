/* global localStorage */
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

const panel = (page) =>
  page.locator("section.status-settings").filter({
    has: page.getByRole("heading", { name: "Status page", exact: true }),
  });

async function dashboard(page, { role = "owner", onSettings }) {
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "status-settings-token"),
  );
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/me")
      return route.fulfill({ json: { ...identity, role } });
    if (path === "/monitors")
      return route.fulfill({ json: { monitors: [monitor] } });
    if (path === "/incidents")
      return route.fulfill({ json: { incidents: [] } });
    if (path === "/status/settings") return onSettings(route);
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
}

test("owner can choose a slug and publish the status page", async ({
  page,
}) => {
  let saved;
  await dashboard(page, {
    onSettings: (route) => {
      if (route.request().method() === "PATCH") {
        saved = route.request().postDataJSON();
        return route.fulfill({
          json: { settings: { status_slug: "acme-eng", status_public: true } },
        });
      }
      return route.fulfill({
        json: { settings: { status_slug: "", status_public: false } },
      });
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Status page" }),
  ).toBeVisible();
  await expect(panel(page)).toContainText("Private");
  await page.getByLabel("Public slug").fill("acme-eng");
  await page.getByLabel("Publish this status page").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Status page settings saved.")).toBeVisible();
  await expect(panel(page)).toContainText("Published");
  await expect(panel(page).locator(".hint")).toContainText("/status/acme-eng");
  expect(saved).toEqual({ slug: "acme-eng", isPublic: true });
});

test("a rejected slug shows the server error and keeps the input", async ({
  page,
}) => {
  await dashboard(page, {
    onSettings: (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 409,
            json: { message: "That slug is already taken" },
          })
        : route.fulfill({
            json: { settings: { status_slug: "acme", status_public: false } },
          }),
  });
  await page.goto("/");
  await page.getByLabel("Public slug").fill("taken-name");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "That slug is already taken",
  );
  await expect(page.getByLabel("Public slug")).toHaveValue("taken-name");
  await expect(page.getByText("Status page settings saved.")).toHaveCount(0);
});

test("viewers do not see the status page settings", async ({ page }) => {
  await dashboard(page, {
    role: "viewer",
    onSettings: (route) =>
      route.fulfill({
        json: { settings: { status_slug: "acme", status_public: true } },
      }),
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Production API" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Status page" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Public slug")).toHaveCount(0);
});
