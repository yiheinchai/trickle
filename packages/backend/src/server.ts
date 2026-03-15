import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

import ingestRouter from "./routes/ingest";
import functionsRouter from "./routes/functions";
import typesRouter from "./routes/types";
import errorsRouter from "./routes/errors";
import tailRouter from "./routes/tail";
import codegenRouter from "./routes/codegen";
import mockRouter from "./routes/mock";
import diffRouter from "./routes/diff";
import dashboardRouter from "./routes/dashboard";
import coverageRouter from "./routes/coverage";
import auditRouter from "./routes/audit";
import searchRouter from "./routes/search";
import cloudRouter from "./routes/cloud";

const app = express();

// ── Production middleware ──

// CORS — allow all origins for local dev, restrict in production
const allowedOrigins = process.env.TRICKLE_CORS_ORIGINS?.split(",") || [];
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : {}));

// Body size limits
app.use(express.json({ limit: "10mb" }));

// Rate limiting — simple in-memory token bucket per IP
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.TRICKLE_RATE_LIMIT || "300", 10); // 300 req/min default

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV !== "production" && !process.env.TRICKLE_RATE_LIMIT) {
    return next(); // Skip rate limiting in dev unless explicitly enabled
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateLimits.get(ip);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(ip, bucket);
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Rate limit exceeded. Try again later." });
    return;
  }

  // Periodic cleanup of old entries
  if (rateLimits.size > 10000) {
    for (const [key, val] of rateLimits) {
      if (now > val.resetAt) rateLimits.delete(key);
    }
  }

  next();
}

app.use("/api/v1", rateLimit);

// Request logging in production
if (process.env.NODE_ENV === "production") {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const start = Date.now();
    _res.on("finish", () => {
      const ms = Date.now() - start;
      if (ms > 1000 || _res.statusCode >= 400) {
        console.log(`${req.method} ${req.path} ${_res.statusCode} ${ms}ms`);
      }
    });
    next();
  });
}

// ── Routes ──

app.use("/api/ingest", ingestRouter);
app.use("/api/functions", functionsRouter);
app.use("/api/types", typesRouter);
app.use("/api/errors", errorsRouter);
app.use("/api/tail", tailRouter);
app.use("/api/codegen", codegenRouter);
app.use("/api/mock-config", mockRouter);
app.use("/api/diff", diffRouter);
app.use("/dashboard", dashboardRouter);
app.use("/api/coverage", coverageRouter);
app.use("/api/audit", auditRouter);
app.use("/api/search", searchRouter);
app.use("/api/v1", cloudRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString(), version: process.env.npm_package_version || "dev" });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[trickle] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

export { app };
