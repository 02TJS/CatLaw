import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "node:path";
import { compileLaw, compileRequestSchema } from "./lawCompiler.js";

export interface CatWorkshopAppOptions {
  webDist: string;
  apiKey?: string;
}

export function createCatWorkshopApp({ webDist, apiKey }: CatWorkshopAppOptions): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, model: "deepseek-v4-flash", configured: Boolean(apiKey) });
  });

  app.post("/api/laws/compile", async (request, response) => {
    const parsed = compileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "法条请求格式不正确", details: parsed.error.issues.map((issue) => issue.message) });
      return;
    }
    try {
      const draft = await compileLaw(parsed.data, apiKey);
      response.json(draft);
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "法条编译失败" });
    }
  });

  app.use(express.static(webDist));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(webDist, "index.html")));
  return app;
}

