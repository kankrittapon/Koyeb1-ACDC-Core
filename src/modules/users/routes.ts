import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { asyncHandler } from "../../lib/http";
import { supabaseAdmin } from "../../lib/supabase";

const supportedRoles = ["DEV", "BOSS", "SECRETARY", "NYK", "NKB", "NPK", "NNG", "USER", "GUEST"] as const;

function normalizeRoleInput(role: string): string {
  const normalized = role.trim().toUpperCase();
  return normalized === "ADMIN" ? "DEV" : normalized;
}

function parseSupportedRole(role: string): string | null {
  const normalized = normalizeRoleInput(role);
  if (!(supportedRoles as readonly string[]).includes(normalized)) {
    return null;
  }
  return normalized;
}

function isDevRole(role: string | null | undefined): boolean {
  const normalized = role?.trim().toUpperCase();
  return normalized === "DEV" || normalized === "ADMIN";
}

function canManageUsers(role: string | null | undefined): boolean {
  const normalized = role?.trim().toUpperCase();
  return normalized === "BOSS" || normalized === "SECRETARY" || isDevRole(role);
}

function canCreateOrAssignRole(input: {
  actorRole: string;
  targetCurrentRole?: string | null;
  targetNextRole: string;
}): boolean {
  const actor = normalizeRoleInput(input.actorRole);
  const current = input.targetCurrentRole ? normalizeRoleInput(input.targetCurrentRole) : null;
  const next = normalizeRoleInput(input.targetNextRole);

  if (actor === "DEV") {
    return true;
  }

  if (actor === "BOSS") {
    if (current === "DEV" || current === "BOSS") {
      return false;
    }
    if (next === "DEV" || next === "BOSS") {
      return false;
    }
    return true;
  }

  if (actor === "SECRETARY") {
    if (current === "DEV" || current === "BOSS" || current === "SECRETARY") {
      return false;
    }
    if (next === "DEV" || next === "BOSS" || next === "SECRETARY") {
      return false;
    }
    return true;
  }

  return false;
}

const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  role: z.string().default("USER"),
  nickname: z.string().nullable().optional(),
  lineUserId: z.string().nullable().optional(),
  lineDisplayName: z.string().nullable().optional()
});

const updateUserSchema = z.object({
  role: z.string().optional(),
  nickname: z.string().nullable().optional(),
  lineUserId: z.string().nullable().optional(),
  lineDisplayName: z.string().nullable().optional(),
  isActive: z.boolean().optional()
});

const createAliasSchema = z.object({
  alias: z.string().min(1).max(100)
});

export const usersRouter = Router();

usersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!canManageUsers(req.authUser?.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { data, error } = await supabaseAdmin
      .from("users")
      .select(
        "id, username, role, line_user_id, line_display_name, nickname, is_active, created_at, user_aliases(id, alias, created_at)"
      )
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    return res.json(data);
  })
);

usersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!canManageUsers(req.authUser?.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const body = createUserSchema.parse(req.body);
    const role = parseSupportedRole(body.role);
    if (!role) {
      return res.status(400).json({ error: `Unsupported role: ${body.role}` });
    }

    if (!canCreateOrAssignRole({ actorRole: req.authUser?.role ?? "GUEST", targetNextRole: role })) {
      return res.status(403).json({ error: "Forbidden to assign this role" });
    }

    const passwordHash = await bcrypt.hash(body.password, 10);

    const { data, error } = await supabaseAdmin
      .from("users")
      .insert({
        username: body.username,
        password_hash: passwordHash,
        role,
        nickname: body.nickname ?? null,
        line_user_id: body.lineUserId ?? null,
        line_display_name: body.lineDisplayName ?? null
      })
      .select(
        "id, username, role, line_user_id, line_display_name, nickname, is_active, created_at, user_aliases(id, alias, created_at)"
      )
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json(data);
  })
);

usersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!canManageUsers(req.authUser?.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const body = updateUserSchema.parse(req.body);
    const actorRole = req.authUser?.role ?? "GUEST";

    const { data: existingUser, error: existingUserError } = await supabaseAdmin
      .from("users")
      .select("id, role")
      .eq("id", req.params.id)
      .maybeSingle();

    if (existingUserError) {
      throw existingUserError;
    }

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (body.role !== undefined) {
      const nextRole = parseSupportedRole(body.role);
      if (!nextRole) {
        return res.status(400).json({ error: `Unsupported role: ${body.role}` });
      }
      if (
        !canCreateOrAssignRole({
          actorRole,
          targetCurrentRole: existingUser.role,
          targetNextRole: nextRole
        })
      ) {
        return res.status(403).json({ error: "Forbidden to change this role" });
      }
      updatePayload.role = nextRole;
    }
    if (body.nickname !== undefined) updatePayload.nickname = body.nickname;
    if (body.lineUserId !== undefined) updatePayload.line_user_id = body.lineUserId;
    if (body.lineDisplayName !== undefined) {
      updatePayload.line_display_name = body.lineDisplayName;
    }
    if (body.isActive !== undefined) updatePayload.is_active = body.isActive;

    const { data, error } = await supabaseAdmin
      .from("users")
      .update(updatePayload)
      .eq("id", req.params.id)
      .select(
        "id, username, role, line_user_id, line_display_name, nickname, is_active, created_at, user_aliases(id, alias, created_at)"
      )
      .single();

    if (error) {
      throw error;
    }

    return res.json(data);
  })
);

usersRouter.post(
  "/:id/aliases",
  asyncHandler(async (req, res) => {
    if (!canManageUsers(req.authUser?.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const body = createAliasSchema.parse(req.body);
    const alias = body.alias.trim();

    const { data, error } = await supabaseAdmin
      .from("user_aliases")
      .insert({
        user_id: req.params.id,
        alias
      })
      .select("id, alias, created_at")
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json(data);
  })
);

usersRouter.delete(
  "/:id/aliases/:aliasId",
  asyncHandler(async (req, res) => {
    if (!canManageUsers(req.authUser?.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { error } = await supabaseAdmin
      .from("user_aliases")
      .delete()
      .eq("id", req.params.aliasId)
      .eq("user_id", req.params.id);

    if (error) {
      throw error;
    }

    return res.status(204).send();
  })
);
