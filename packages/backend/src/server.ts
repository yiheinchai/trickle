import express from "express";
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

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use("/api/ingest", ingestRouter);
app.use("/api/functions", functionsRouter);
app.use("/api/types", typesRouter);
app.use("/api/errors", errorsRouter);
app.use("/api/tail", tailRouter);
app.use("/api/codegen", codegenRouter);
app.use("/api/mock-config", mockRouter);
app.use("/api/diff", diffRouter);
app.use("/dashboard", dashboardRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

export { app };
