import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { CURRENT_SCHEMA_MIGRATION } from "./schema-version.js";

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly systemConnectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  readonly applicationName?: string;
  readonly ssl?: PoolConfig["ssl"];
  readonly onPoolError?: (error: Error) => void;
}

export interface TransactionOptions {
  readonly isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  readonly readOnly?: boolean;
}

export interface TenantContext {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly system: boolean;
}

interface TransactionContext extends TenantContext {
  readonly client: PoolClient;
  tenantId: string;
  projectId?: string;
  system: boolean;
}

type RuntimeRoleProfile = {
  readonly has_role_memberships: boolean;
  readonly owns_database_or_public_objects: boolean;
  readonly role_name: string;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
  readonly rolreplication: boolean;
  readonly rolsuper: boolean;
};

type RuntimeDatabaseProfile = {
  readonly database_name: string;
  readonly schema_current: boolean;
  readonly server_address: string | null;
  readonly server_port: number | null;
};

export class DatabaseError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(message: string, code = "DATABASE_ERROR", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseError";
    this.code = code;
    this.retryable = code === "40001" || code === "40P01" || code === "55P03";
  }
}

export class TenantContextError extends DatabaseError {
  public constructor(message: string) {
    super(message, "TENANT_CONTEXT_ERROR");
    this.name = "TenantContextError";
  }
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TenantContextError(`${label} must be a UUID`);
  }
}

function databaseCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "DATABASE_ERROR";
}

export class Database implements SqlExecutor {
  readonly #pool: Pool;
  readonly #systemPool: Pool;
  readonly #storage = new AsyncLocalStorage<TransactionContext>();

  public constructor(options: DatabaseOptions) {
    const poolConfig = {
      max: options.max ?? 20,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      statement_timeout: options.statementTimeoutMillis ?? 30_000,
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    } satisfies PoolConfig;
    this.#pool = new Pool({
      ...poolConfig,
      connectionString: options.connectionString,
      application_name: options.applicationName ?? "arcdb",
    });
    this.#systemPool = new Pool({
      ...poolConfig,
      connectionString: options.systemConnectionString,
      application_name: `${options.applicationName ?? "arcdb"}-system`,
    });
    const handlePoolError = (error: Error): void => {
      if (options.onPoolError !== undefined) {
        options.onPoolError(error);
        return;
      }
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          event: "postgres_idle_client_error",
          code: databaseCode(error),
          message: error.message,
        })}\n`,
      );
    };
    this.#pool.on("error", handlePoolError);
    this.#systemPool.on("error", handlePoolError);
  }

  public async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const context = this.#storage.getStore();
      if (context !== undefined) {
        return await context.client.query<Row>(text, [...values]);
      }
      return await this.#pool.query<Row>(text, [...values]);
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError("PostgreSQL query failed", databaseCode(error), error);
    }
  }

  public get context(): TenantContext | undefined {
    const context = this.#storage.getStore();
    if (context === undefined) {
      return undefined;
    }
    return {
      tenantId: context.tenantId,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      system: context.system,
    };
  }

  public async transaction<T>(
    callback: (executor: SqlExecutor) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const active = this.#storage.getStore();
    if (active !== undefined) {
      const savepoint = `arcdb_nested_${crypto.randomUUID().replaceAll("-", "")}`;
      await active.client.query(`SAVEPOINT ${savepoint}`);
      try {
        const value = await callback(this);
        await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    return this.#transactionOnPool(this.#pool, false, callback, options);
  }

  async #transactionOnPool<T>(
    pool: Pool,
    system: boolean,
    callback: (executor: SqlExecutor) => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const client = await pool.connect();
    const isolation = options.isolationLevel ?? "READ COMMITTED";
    try {
      await client.query("BEGIN");
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      if (options.readOnly === true) {
        await client.query("SET TRANSACTION READ ONLY");
      }
      const context: TransactionContext = {
        client,
        tenantId: "",
        system,
      };
      const result = await this.#storage.run(context, () => callback(this));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public withTenant<T>(
    tenantId: string,
    callback: (executor: SqlExecutor) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  public withTenant<T>(
    tenantId: string,
    projectId: string,
    callback: (executor: SqlExecutor) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  public async withTenant<T>(
    tenantId: string,
    projectIdOrCallback: string | ((executor: SqlExecutor) => Promise<T>),
    callbackOrOptions?: ((executor: SqlExecutor) => Promise<T>) | TransactionOptions,
    maybeOptions: TransactionOptions = {},
  ): Promise<T> {
    assertUuid(tenantId, "tenantId");
    const projectId = typeof projectIdOrCallback === "string" ? projectIdOrCallback : undefined;
    const callback =
      typeof projectIdOrCallback === "function"
        ? projectIdOrCallback
        : typeof callbackOrOptions === "function"
          ? callbackOrOptions
          : undefined;
    const options =
      typeof projectIdOrCallback === "function"
        ? ((callbackOrOptions as TransactionOptions | undefined) ?? {})
        : maybeOptions;
    if (callback === undefined) {
      throw new TypeError("withTenant requires a callback");
    }
    if (projectId !== undefined) {
      assertUuid(projectId, "projectId");
    }

    const active = this.#storage.getStore();
    if (active !== undefined) {
      if (active.system || active.tenantId !== tenantId || active.projectId !== projectId) {
        throw new TenantContextError("Cannot change tenant scope inside an active transaction");
      }
      return callback(this);
    }

    return this.transaction(async (executor) => {
      const context = this.#storage.getStore();
      if (context === undefined) {
        throw new TenantContextError("Tenant transaction context was not initialized");
      }
      context.tenantId = tenantId;
      if (projectId !== undefined) {
        context.projectId = projectId;
      }
      await executor.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await executor.query("SELECT set_config('app.project_id', $1, true)", [projectId ?? ""]);
      return callback(executor);
    }, options);
  }

  /**
   * Runs trusted control-plane work through the separately configured privileged
   * connection pool. Keep the callback small; public request handlers should use
   * this only to resolve an API-key prefix.
   */
  public async withSystem<T>(
    callback: (executor: SqlExecutor) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    if (this.#storage.getStore() !== undefined) {
      throw new TenantContextError("Cannot enter system scope inside an active transaction");
    }
    return this.#transactionOnPool(this.#systemPool, true, callback, options);
  }

  async #runtimeRoleProfiles(): Promise<{
    readonly application: RuntimeRoleProfile;
    readonly system: RuntimeRoleProfile;
  }> {
    const query = `SELECT current_user AS role_name, rolsuper, rolcreatedb, rolcreaterole,
                          rolinherit, rolreplication, rolbypassrls,
                          EXISTS (
                            SELECT 1
                              FROM pg_auth_members membership
                             WHERE membership.member = current_user::regrole
                          ) AS has_role_memberships,
                          (
                            EXISTS (
                              SELECT 1 FROM pg_database database
                               WHERE database.datname = current_database()
                                 AND database.datdba = current_user::regrole
                            ) OR EXISTS (
                              SELECT 1 FROM pg_namespace namespace
                               WHERE namespace.nspname = 'public'
                                 AND namespace.nspowner = current_user::regrole
                            ) OR EXISTS (
                              SELECT 1
                                FROM pg_class relation
                                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                               WHERE namespace.nspname = 'public'
                                 AND relation.relowner = current_user::regrole
                            ) OR EXISTS (
                              SELECT 1
                                FROM pg_proc function
                                JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
                               WHERE namespace.nspname = 'public'
                                 AND function.proowner = current_user::regrole
                            )
                          ) AS owns_database_or_public_objects
                     FROM pg_roles
                    WHERE rolname = current_user`;
    const [applicationResult, systemResult] = await Promise.all([
      this.#pool.query<RuntimeRoleProfile>(query),
      this.#systemPool.query<RuntimeRoleProfile>(query),
    ]);
    const application = applicationResult.rows[0];
    const system = systemResult.rows[0];
    if (application === undefined || system === undefined) {
      throw new DatabaseError(
        "PostgreSQL did not return both runtime role profiles",
        "DATABASE_ROLE_MISCONFIGURED",
      );
    }
    return { application, system };
  }

  /** Fails closed when tenant and control-plane pools do not use the intended role classes. */
  public async assertRuntimeRoleSeparation(): Promise<void> {
    const { application, system } = await this.#runtimeRoleProfiles();
    const applicationIsConstrained =
      !application.rolsuper &&
      !application.rolcreatedb &&
      !application.rolcreaterole &&
      !application.has_role_memberships &&
      !application.owns_database_or_public_objects &&
      !application.rolinherit &&
      !application.rolreplication &&
      !application.rolbypassrls;
    const systemIsConstrained =
      !system.rolsuper &&
      !system.rolcreatedb &&
      !system.rolcreaterole &&
      !system.has_role_memberships &&
      !system.owns_database_or_public_objects &&
      !system.rolinherit &&
      !system.rolreplication &&
      system.rolbypassrls;
    if (
      !applicationIsConstrained ||
      !systemIsConstrained ||
      application.role_name === system.role_name
    ) {
      throw new DatabaseError(
        `PostgreSQL runtime roles are unsafe: application=${application.role_name}, system=${system.role_name}`,
        "DATABASE_ROLE_MISCONFIGURED",
      );
    }
  }

  async #runtimeDatabaseProfiles(): Promise<{
    readonly application: RuntimeDatabaseProfile;
    readonly system: RuntimeDatabaseProfile;
  }> {
    const query = `SELECT current_database() AS database_name,
                          inet_server_addr()::text AS server_address,
                          inet_server_port() AS server_port,
                          EXISTS (
                            SELECT 1
                              FROM arcdb_schema_migrations
                             WHERE version = $1 AND checksum = $2
                          ) AS schema_current`;
    const values = [CURRENT_SCHEMA_MIGRATION.version, CURRENT_SCHEMA_MIGRATION.checksum];
    const [applicationResult, systemResult] = await Promise.all([
      this.#pool.query<RuntimeDatabaseProfile>(query, values),
      this.#systemPool.query<RuntimeDatabaseProfile>(query, values),
    ]);
    const application = applicationResult.rows[0];
    const system = systemResult.rows[0];
    if (application === undefined || system === undefined) {
      throw new DatabaseError(
        "PostgreSQL did not return both runtime database profiles",
        "DATABASE_SCHEMA_MISCONFIGURED",
      );
    }
    return { application, system };
  }

  /** Verifies both runtime pools reach the same database with the schema required by this build. */
  public async assertSchemaReady(): Promise<void> {
    const { application, system } = await this.#runtimeDatabaseProfiles();
    const sameDatabase =
      application.database_name === system.database_name &&
      application.server_address === system.server_address &&
      application.server_port === system.server_port;
    if (!sameDatabase || !application.schema_current || !system.schema_current) {
      throw new DatabaseError(
        `PostgreSQL schema is not ready for ${CURRENT_SCHEMA_MIGRATION.version}`,
        "DATABASE_SCHEMA_MISCONFIGURED",
      );
    }
  }

  public async healthcheck(): Promise<boolean> {
    try {
      const [application, system] = await Promise.all([
        this.#pool.query<{ ok: number }>("SELECT 1 AS ok"),
        this.#systemPool.query<{ ok: number }>("SELECT 1 AS ok"),
      ]);
      if (application.rows[0]?.ok !== 1 || system.rows[0]?.ok !== 1) return false;
      await this.assertRuntimeRoleSeparation();
      await this.assertSchemaReady();
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#systemPool.end()]);
  }
}

export function createDatabase(options: DatabaseOptions): Database {
  return new Database(options);
}
