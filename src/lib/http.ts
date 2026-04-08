import { Request, Response, NextFunction } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

export function getRequestId(req: Request): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0
    ? value
    : `k1_${Date.now()}`;
}
