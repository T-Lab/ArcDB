import { generateApiKey, getApiKeyPrefix, hashApiKey, permissionsForRole } from "@arcdb/auth";
import { createDatabase } from "../database.js";
import { createRepositories } from "../repositories/index.js";

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
  return normalized.length >= 2 ? normalized : `arcdb-${normalized || "local"}`;
}

const connectionString =
  process.env.ARCDB_ADMIN_DATABASE_URL ??
  process.env.ARCDB_DATABASE_URL ??
  process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("ARCDB_ADMIN_DATABASE_URL, ARCDB_DATABASE_URL, or DATABASE_URL is required");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("The development seed command is disabled in production");
}
if (process.env.ARCDB_ALLOW_DEV_BOOTSTRAP !== "true") {
  throw new Error("The development seed command requires ARCDB_ALLOW_DEV_BOOTSTRAP=true");
}

const organizationName = process.env.ARCDB_BOOTSTRAP_ORGANIZATION ?? "ArcDB Local";
const projectName = process.env.ARCDB_BOOTSTRAP_PROJECT ?? "SQL Change Agent";
const email = (process.env.ARCDB_BOOTSTRAP_EMAIL ?? "admin@arcdb.local").trim().toLowerCase();
const organizationId =
  process.env.ARCDB_BOOTSTRAP_ORGANIZATION_ID ?? "019c91e8-43a6-7ec0-a000-000000000001";
const projectId = process.env.ARCDB_BOOTSTRAP_PROJECT_ID ?? "019c91e8-43a6-7ec0-a000-000000000002";
const userId = process.env.ARCDB_BOOTSTRAP_USER_ID ?? "019c91e8-43a6-7ec0-a000-000000000003";
const configuredKey = process.env.ARCDB_BOOTSTRAP_API_KEY;
const generated = configuredKey === undefined ? generateApiKey() : null;
const plaintext = configuredKey ?? generated?.plaintext;
if (plaintext === undefined) {
  throw new Error("Unable to initialize bootstrap API key");
}

const database = createDatabase({
  connectionString,
  systemConnectionString: connectionString,
  applicationName: "arcdb-seed",
  max: 2,
});
const repositories = createRepositories(database);
try {
  const seeded = await database.withSystem(async () => {
    const organizationSlug = slug(organizationName);
    const organization =
      (await repositories.organizations.getBySlug(organizationSlug)) ??
      (await repositories.organizations.create({
        id: organizationId,
        name: organizationName,
        slug: organizationSlug,
        settings: { seeded: true },
      }));
    const user = await repositories.users.upsertByEmail({
      id: userId,
      email,
      displayName: "ArcDB Administrator",
    });
    await repositories.memberships.add({
      tenantId: organization.id,
      userId: user.id,
      role: "OWNER",
    });
    const projectSlug = slug(projectName);
    const project =
      (await repositories.projects.list(organization.id)).find(
        (item) => item.slug === projectSlug,
      ) ??
      (await repositories.projects.create({
        id: projectId,
        tenantId: organization.id,
        name: projectName,
        slug: projectSlug,
        settings: { seeded: true },
      }));
    const prefix = getApiKeyPrefix(plaintext);
    const existingKey = await repositories.apiKeys.findByPrefix(prefix);
    if (existingKey === null) {
      await repositories.apiKeys.create({
        tenantId: organization.id,
        projectId: project.id,
        name: "Local bootstrap key",
        prefix,
        keyHash: await hashApiKey(plaintext),
        lastFour: plaintext.slice(-4),
        permissions: permissionsForRole("OWNER"),
        createdBy: user.id,
      });
    }
    return {
      organizationId: organization.id,
      projectId: project.id,
      userId: user.id,
      apiKeyPrefix: prefix,
    };
  });
  process.stdout.write(`${JSON.stringify({ event: "database_seeded", ...seeded })}\n`);
  if (generated !== null) {
    process.stdout.write(
      `${JSON.stringify({ event: "bootstrap_api_key_created", apiKey: generated.plaintext })}\n`,
    );
  }
} finally {
  await database.close();
}
