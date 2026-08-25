import type {
  ApiKeyRecord,
  JsonObject,
  MembershipRecord,
  OrganizationRecord,
  OrganizationRole,
  ProjectRecord,
  UserRecord,
} from "../types.js";
import {
  json,
  normalizeRows,
  optionalRow,
  type RawRow,
  Repository,
  requiredRow,
} from "./helpers.js";

export interface CreateOrganizationInput {
  readonly id?: string;
  readonly name: string;
  readonly slug: string;
  readonly settings?: JsonObject;
}

export class OrganizationsRepository extends Repository {
  public async create(input: CreateOrganizationInput): Promise<OrganizationRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO organizations (id, name, slug, settings)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb)
       RETURNING *`,
      [input.id ?? null, input.name, input.slug, json(input.settings)],
    );
    return requiredRow(result.rows, "organization");
  }

  public async get(id: string): Promise<OrganizationRecord | null> {
    const result = await this.executor.query<RawRow>("SELECT * FROM organizations WHERE id = $1", [
      id,
    ]);
    return optionalRow(result.rows);
  }

  public async getBySlug(slug: string): Promise<OrganizationRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM organizations WHERE slug = $1",
      [slug],
    );
    return optionalRow(result.rows);
  }
}

export interface UpsertUserInput {
  readonly id?: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash?: string;
}

export class UsersRepository extends Repository {
  public async upsertByEmail(input: UpsertUserInput): Promise<UserRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), lower(trim($2)), $3, $4)
       ON CONFLICT (lower(email)) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)
       RETURNING *`,
      [input.id ?? null, input.email, input.displayName, input.passwordHash ?? null],
    );
    return requiredRow(result.rows, "user");
  }

  public async get(id: string): Promise<UserRecord | null> {
    const result = await this.executor.query<RawRow>("SELECT * FROM users WHERE id = $1", [id]);
    return optionalRow(result.rows);
  }
}

export class MembershipsRepository extends Repository {
  public async add(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly role: OrganizationRole;
  }): Promise<MembershipRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [input.tenantId, input.userId, input.role],
    );
    return requiredRow(result.rows, "membership");
  }

  public async listForUser(userId: string): Promise<readonly MembershipRecord[]> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM organization_memberships WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    return normalizeRows(result.rows);
  }
}

export interface CreateProjectInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly retentionDays?: number;
  readonly settings?: JsonObject;
}

export class ProjectsRepository extends Repository {
  public async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO projects (id, tenant_id, name, slug, retention_days, settings)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.name,
        input.slug,
        input.retentionDays ?? null,
        json(input.settings),
      ],
    );
    return requiredRow(result.rows, "project");
  }

  public async get(input: {
    readonly tenantId: string;
    readonly id: string;
  }): Promise<ProjectRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM projects WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async list(tenantId: string): Promise<readonly ProjectRecord[]> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId],
    );
    return normalizeRows(result.rows);
  }
}

export interface CreateApiKeyInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly name: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly lastFour: string;
  readonly permissions: readonly string[];
  readonly createdBy?: string;
  readonly expiresAt?: string;
}

export class ApiKeysRepository extends Repository {
  public async create(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO api_keys (
         id, tenant_id, project_id, name, prefix, key_hash, last_four,
         permissions, created_by, expires_at
       ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId ?? null,
        input.name,
        input.prefix,
        input.keyHash,
        input.lastFour,
        [...input.permissions],
        input.createdBy ?? null,
        input.expiresAt ?? null,
      ],
    );
    return requiredRow(result.rows, "api key");
  }

  /** Must be called from Database.withSystem during pre-authentication lookup. */
  public async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM api_keys WHERE prefix = $1 LIMIT 1",
      [prefix],
    );
    return optionalRow(result.rows);
  }

  public async list(input: {
    readonly tenantId: string;
    readonly projectId?: string;
  }): Promise<readonly ApiKeyRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM api_keys
       WHERE tenant_id = $1 AND ($2::uuid IS NULL OR project_id = $2)
       ORDER BY created_at DESC`,
      [input.tenantId, input.projectId ?? null],
    );
    return normalizeRows(result.rows);
  }

  public async markUsed(id: string): Promise<void> {
    await this.executor.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]);
  }

  public async revoke(input: { readonly tenantId: string; readonly id: string }): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return result.rowCount === 1;
  }

  public async rotate(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly prefix: string;
    readonly keyHash: string;
    readonly lastFour: string;
    readonly expiresAt?: string;
  }): Promise<ApiKeyRecord> {
    const current = await this.executor.query<RawRow>(
      `SELECT * FROM api_keys
       WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [input.tenantId, input.id],
    );
    const previous = requiredRow<ApiKeyRecord>(current.rows, "active API key");
    await this.executor.query(
      "UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return this.create({
      tenantId: previous.tenantId,
      ...(previous.projectId === undefined ? {} : { projectId: previous.projectId }),
      name: previous.name,
      prefix: input.prefix,
      keyHash: input.keyHash,
      lastFour: input.lastFour,
      permissions: previous.permissions,
      ...(previous.createdBy === undefined ? {} : { createdBy: previous.createdBy }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
  }
}
