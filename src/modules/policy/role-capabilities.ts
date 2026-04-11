export type RoleCapability =
  | "manage_calendar"
  | "request_summary"
  | "message_staff"
  | "file_purge"
  | "send_file_for_review"
  | "request_acknowledgement"
  | "receive_acknowledgement"
  | "use_ai_mode"
  | "is_secretary"
  | "requires_secretary_review";

type CanonicalRole =
  | "DEV"
  | "BOSS"
  | "SECRETARY"
  | "NYK"
  | "NKB"
  | "NPK"
  | "NNG"
  | "USER"
  | "GUEST";

const roleCapabilityRegistry: Record<CanonicalRole, ReadonlySet<RoleCapability>> = {
  DEV: new Set([
    "manage_calendar",
    "request_summary",
    "message_staff",
    "file_purge",
    "send_file_for_review",
    "use_ai_mode"
  ]),
  BOSS: new Set([
    "manage_calendar",
    "request_summary",
    "message_staff",
    "send_file_for_review",
    "request_acknowledgement",
    "use_ai_mode"
  ]),
  SECRETARY: new Set([
    "manage_calendar",
    "request_summary",
    "message_staff",
    "send_file_for_review",
    "use_ai_mode",
    "is_secretary"
  ]),
  NYK: new Set([
    "send_file_for_review",
    "receive_acknowledgement",
    "requires_secretary_review"
  ]),
  NKB: new Set([
    "send_file_for_review",
    "receive_acknowledgement",
    "requires_secretary_review"
  ]),
  NPK: new Set([
    "send_file_for_review",
    "receive_acknowledgement",
    "requires_secretary_review"
  ]),
  NNG: new Set([
    "send_file_for_review",
    "receive_acknowledgement",
    "requires_secretary_review"
  ]),
  USER: new Set(["use_ai_mode"]),
  GUEST: new Set()
};

export function normalizeCapabilityRole(role: string | null | undefined): CanonicalRole | string {
  const normalized = (role ?? "GUEST").trim().toUpperCase();

  if (normalized === "ADMIN") {
    return "DEV";
  }

  if (normalized in roleCapabilityRegistry) {
    return normalized as CanonicalRole;
  }

  return normalized;
}

export function getRoleCapabilities(role: string | null | undefined): ReadonlySet<RoleCapability> {
  const normalized = normalizeCapabilityRole(role);
  if (typeof normalized === "string" && normalized in roleCapabilityRegistry) {
    return roleCapabilityRegistry[normalized as CanonicalRole];
  }
  return new Set<RoleCapability>();
}

export function hasRoleCapability(role: string | null | undefined, capability: RoleCapability): boolean {
  return getRoleCapabilities(role).has(capability);
}

export function canManageCalendar(role: string): boolean {
  return hasRoleCapability(role, "manage_calendar");
}

export function canRequestSummary(role: string): boolean {
  return hasRoleCapability(role, "request_summary");
}

export function canMessageStaff(role: string): boolean {
  return hasRoleCapability(role, "message_staff");
}

export function canManageFilePurge(role: string): boolean {
  return hasRoleCapability(role, "file_purge");
}

export function canSendFileForReview(role: string): boolean {
  return hasRoleCapability(role, "send_file_for_review");
}

export function canRequestAcknowledgement(role: string): boolean {
  return hasRoleCapability(role, "request_acknowledgement");
}

export function canReceiveAcknowledgement(role: string): boolean {
  return hasRoleCapability(role, "receive_acknowledgement");
}

export function canUseAIMode(role: string): boolean {
  return hasRoleCapability(role, "use_ai_mode");
}

export function isSecretaryRole(role: string): boolean {
  return hasRoleCapability(role, "is_secretary");
}

export function requiresSecretaryReview(role: string): boolean {
  return hasRoleCapability(role, "requires_secretary_review");
}
