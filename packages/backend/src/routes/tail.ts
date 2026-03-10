import { Router, Request, Response } from "express";
import { sseBroker } from "../services/sse-broker";

const router = Router();

// GET / — SSE endpoint
router.get("/", (req: Request, res: Response) => {
  const filter = req.query.filter as string | undefined;
  sseBroker.addClient(res, filter);
});

export default router;
