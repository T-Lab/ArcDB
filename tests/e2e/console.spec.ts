import { expect, test } from "@playwright/test";

const projectId = "019c91e8-43a6-7ec0-a000-000000000002";

test("selects a real project and renders API-backed dashboard counts", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/overview\\?projectId=${projectId}$`, "u"));
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByLabel("Select project")).toHaveValue(projectId);
  await expect(
    page.getByRole("article").filter({ hasText: "Runs · 24h" }).getByText("3", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article")
      .filter({ hasText: "Needs attention" })
      .getByText("2", { exact: true }),
  ).toBeVisible();
  expect(await page.content()).not.toContain("arcdb_e2e_server_only_credential");
});

test("navigates from the trace explorer to an API-backed span timeline", async ({ page }) => {
  await page.goto(`/traces?projectId=${projectId}`);
  await expect(page.getByRole("heading", { name: "Traces" })).toBeVisible();
  await page.getByRole("link", { name: "shadow-database-verification" }).click();
  await expect(page.getByRole("heading", { name: "shadow-database-verification" })).toBeVisible();
  await expect(page.getByTitle("apply migration in shadow")).toBeVisible();
  await expect(
    page.getByRole("group").filter({ hasText: "apply migration in shadow" }),
  ).toContainText("OK");
});
