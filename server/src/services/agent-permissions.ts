export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canReadQuotaWindows: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    canReadQuotaWindows: role === "ceo",
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canReadQuotaWindows:
      typeof record.canReadQuotaWindows === "boolean"
        ? record.canReadQuotaWindows
        : defaults.canReadQuotaWindows,
  };
}
