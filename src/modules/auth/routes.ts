import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http";
import { signAccessToken, verifyPassword } from "../../lib/auth";
import { supabaseAdmin } from "../../lib/supabase";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export const authRouter = Router();

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const { data: user, error } = await supabaseAdmin
      .from("users")
      .select("id, username, password_hash, role, is_active")
      .eq("username", body.username)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const isValid =
      !!user &&
      user.is_active === true &&
      (await verifyPassword(body.password, user.password_hash));

    if (!isValid || !user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = signAccessToken({
      sub: user.id,
      role: user.role,
      username: user.username
    });

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  })
);
