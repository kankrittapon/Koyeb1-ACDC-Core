import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { asyncHandler } from "../../lib/http";
import { supabaseAdmin } from "../../lib/supabase";

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
  asyncHandler(async (_req, res) => {
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
    const body = createUserSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 10);

    const { data, error } = await supabaseAdmin
      .from("users")
      .insert({
        username: body.username,
        password_hash: passwordHash,
        role: body.role,
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
    const body = updateUserSchema.parse(req.body);

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (body.role !== undefined) updatePayload.role = body.role;
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
