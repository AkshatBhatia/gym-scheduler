import { Router, Request, Response } from "express";
import { getTimezone, setTimezone } from "../services/timezone.js";

const router = Router();

// GET /api/settings/timezone
router.get("/timezone", (_req: Request, res: Response) => {
  res.json({ timezone: getTimezone() });
});

// PUT /api/settings/timezone
router.put("/timezone", (req: Request, res: Response) => {
  try {
    const { timezone } = req.body;
    if (!timezone) {
      res.status(400).json({ error: "timezone is required" });
      return;
    }
    setTimezone(timezone);
    res.json({ timezone: getTimezone() });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// GET /api/settings/instructor-phone
router.get("/instructor-phone", (_req: Request, res: Response) => {
  res.json({ phone: process.env.INSTRUCTOR_PHONE_NUMBER || '' });
});

export default router;
