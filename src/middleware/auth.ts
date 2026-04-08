import { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { verifyAccessToken } from "../lib/auth";

function extractBearerToken(headerValue?: string): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

export function requireAccess(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const internalApiKey = req.header("x-internal-api-key");
  if (internalApiKey && internalApiKey === config.INTERNAL_API_KEY) {
    req.isInternalCall = true;
    return next();
  }

  const token = extractBearerToken(req.header("authorization"));
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    req.authUser = verifyAccessToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.isInternalCall) {
      return next();
    }

    const role = req.authUser?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return next();
  };
}
