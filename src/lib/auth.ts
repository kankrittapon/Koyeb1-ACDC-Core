import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config";

export type AuthTokenPayload = {
  sub: string;
  role: string;
  username: string | null;
};

export async function verifyPassword(
  password: string,
  passwordHash: string | null
): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: "30d"
  });
}

export function verifyAccessToken(token: string): AuthTokenPayload {
  return jwt.verify(token, config.JWT_SECRET) as AuthTokenPayload;
}
