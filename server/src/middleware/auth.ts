import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/auth.js";

// Extend Express Request to include instructor info
declare global {
  namespace Express {
    interface Request {
      instructorId?: number;
      instructorPhone?: string;
    }
  }
}

/**
 * Middleware that requires a valid JWT token.
 * Passes through if valid, returns 401 if not.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.instructorId = payload.instructorId;
  req.instructorPhone = payload.phone;
  next();
}

/**
 * Optional auth — sets instructor info if token present, but doesn't block.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) {
      req.instructorId = payload.instructorId;
      req.instructorPhone = payload.phone;
    }
  }
  next();
}
