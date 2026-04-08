import { AuthTokenPayload } from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthTokenPayload;
      isInternalCall?: boolean;
    }
  }
}

export {};
