import { test, expect } from "@playwright/test";

const operational = {
  status: "operational",
  workspace: { name: "Acme Engineering" },
  monitors: [
    { id: "1", name: "Production API", last_status: "up" },
    { id: "2", name: "Marketing Site", last_status: "up" },
  ],
  incidents: [],
};

const degraded = {
  status: "degraded",
  workspace: { name: "Acme Engineering" },
  monitors: [{ id: "1", name: "Production API", last_status: "down" }],
  incidents: [
    {
      id: "10",
      title: "API unavailable",
      error_message: "HTTP 500",
      status: "open",
      started_at: "2026-10-20T10:00:00.000Z",
    },
  ],
};

test("public status page shows healthy services without signing in", async ({
  page,
}) => {
  await page.route("http://localhost:3001/status/**", (route) =>
    route.fulfill({ json: operational }),
  );
  await page.goto("/status/acme");
  await expect(
    page.getByRole("heading", { name: "All systems operational" }),
  ).toBeVisible();
  await expect(page.getByText("Production API", { exact: true })).toBeVisible();
  await expect(page.getByText("Marketing Site", { exact: true })).toBeVisible();
  await expect(page.getByText("2 services")).toBeVisible();
  await expect(page.getByText("No incidents reported.")).toBeVisible();
});

test("public status page shows degraded state and recent incidents", async ({
  page,
}) => {
  await page.route("http://localhost:3001/status/**", (route) =>
    route.fulfill({ json: degraded }),
  );
  await page.goto("/status/acme");
  await expect(
    page.getByRole("heading", { name: "Some systems are degraded" }),
  ).toBeVisible();
  await expect(page.getByText("API unavailable")).toBeVisible();
  await expect(page.getByText("HTTP 500")).toBeVisible();
  await expect(page.getByText("No incidents reported.")).toHaveCount(0);
});

test("unknown or private status page shows an error, not data", async ({
  page,
}) => {
  await page.route("http://localhost:3001/status/**", (route) =>
    route.fulfill({ status: 404, json: { message: "Status page not found" } }),
  );
  await page.goto("/status/missing");
  await expect(
    page.getByRole("heading", { name: "Status page unavailable" }),
  ).toBeVisible();
  await expect(page.getByText("Status page not found")).toBeVisible();
  await expect(page.getByText("Production API")).toHaveCount(0);
});
