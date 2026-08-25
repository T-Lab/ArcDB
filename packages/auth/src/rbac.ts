export const PERMISSIONS = [
  "organization:read",
  "organization:manage",
  "project:read",
  "project:manage",
  "api_key:manage",
  "run:read",
  "run:write",
  "output:read",
  "output:write",
  "output:promote",
  "evidence:write",
  "effect:read",
  "effect:prepare",
  "effect:commit",
  "effect:remediate",
  "dataset:read",
  "dataset:export",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type OrganizationRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

const allPermissions: readonly Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, readonly Permission[]>> = {
  OWNER: allPermissions,
  ADMIN: allPermissions.filter((permission) => permission !== "organization:manage"),
  MEMBER: [
    "organization:read",
    "project:read",
    "run:read",
    "run:write",
    "output:read",
    "output:write",
    "evidence:write",
    "effect:read",
    "effect:prepare",
    "dataset:read",
  ],
  VIEWER: [
    "organization:read",
    "project:read",
    "run:read",
    "output:read",
    "effect:read",
    "dataset:read",
  ],
};

export interface AuthorizablePrincipal {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly permissions: readonly string[];
}

export class AuthorizationError extends Error {
  public readonly code = "FORBIDDEN";
  public readonly permission: Permission;

  public constructor(permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "AuthorizationError";
    this.permission = permission;
  }
}

export function permissionsForRole(role: OrganizationRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(
  principal: AuthorizablePrincipal,
  permission: Permission,
  scope: { readonly tenantId: string; readonly projectId?: string } = {
    tenantId: principal.tenantId,
  },
): boolean {
  if (principal.tenantId !== scope.tenantId) {
    return false;
  }
  if (
    principal.projectId !== undefined &&
    (scope.projectId === undefined || principal.projectId !== scope.projectId)
  ) {
    return false;
  }
  return principal.permissions.includes(permission);
}

export function authorize(
  principal: AuthorizablePrincipal,
  permission: Permission,
  scope?: { readonly tenantId: string; readonly projectId?: string },
): void {
  if (!hasPermission(principal, permission, scope)) {
    throw new AuthorizationError(permission);
  }
}

export function assertKnownPermissions(
  permissions: readonly string[],
): asserts permissions is readonly Permission[] {
  const known = new Set<string>(PERMISSIONS);
  const invalid = permissions.find((permission) => !known.has(permission));
  if (invalid !== undefined) {
    throw new TypeError(`Unknown permission: ${invalid}`);
  }
}
