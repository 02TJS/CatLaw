import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "node:path";
import { z } from "zod";
import { compileLaw, compileRequestSchema } from "./lawCompiler.js";

export interface CatWorkshopAppOptions {
  webDist: string;
  apiKey?: string;
  baseUrl?: string;
  persistApiKey?: (apiKey: string) => boolean | Promise<boolean>;
  persistBaseUrl?: (baseUrl: string) => boolean | Promise<boolean>;
}

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const apiKeySchema = z.string()
  .trim()
  .min(20, "密钥长度不正确")
  .max(512, "密钥长度不正确")
  .regex(/^sk-[A-Za-z0-9_-]+$/, "请输入以 sk- 开头的 API 密钥");

const apiKeyRequestSchema = z.object({
  apiKey: z.string()
    .trim()
    .min(20, "密钥长度不正确")
    .max(512, "密钥长度不正确")
    .regex(/^sk-[A-Za-z0-9_-]+$/, "请输入以 sk- 开头的 DeepSeek API 密钥"),
}).strict();

const deepSeekSettingsRequestSchema = z.object({
  apiKey: z.union([apiKeySchema, z.literal("")]).optional(),
  baseUrl: z.string().trim().min(1, "请输入 API URL").max(2_048, "API URL 过长"),
}).strict();

export function normalizeDeepSeekBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_DEEPSEEK_BASE_URL;
  const parsed = new URL(raw);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) throw new Error("API URL 只支持 HTTP 或 HTTPS");
  if (parsed.username || parsed.password) throw new Error("API URL 不能包含用户名或密码");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "") || "";
  return parsed.toString().replace(/\/$/, "");
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLocalBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function createCatWorkshopApp({ webDist, apiKey, baseUrl, persistApiKey, persistBaseUrl }: CatWorkshopAppOptions): express.Express {
  const app = express();
  let currentApiKey = apiKey?.trim() || undefined;
  let currentBaseUrl = normalizeDeepSeekBaseUrl(baseUrl);

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

  app.get("/api/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ok: true,
      model: "deepseek-v4-flash",
      configured: Boolean(currentApiKey),
      keyStorage: persistApiKey ? "secure-local" : "session",
      baseUrl: currentBaseUrl,
    });
  });

  app.post("/api/settings/deepseek", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!isLoopback(request.socket.remoteAddress) || !isLocalBrowserOrigin(request.get("origin"))) {
      response.status(403).json({ error: "只允许从本机游戏页面设置模型连接" });
      return;
    }
    const parsed = deepSeekSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "模型连接设置不正确" });
      return;
    }
    const nextApiKey = parsed.data.apiKey?.trim() || currentApiKey;
    if (!nextApiKey) {
      response.status(400).json({ error: "首次配置时必须输入 API 密钥" });
      return;
    }
    let nextBaseUrl: string;
    try {
      nextBaseUrl = normalizeDeepSeekBaseUrl(parsed.data.baseUrl);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "API URL 不正确" });
      return;
    }
    try {
      if (parsed.data.apiKey?.trim() && persistApiKey) await persistApiKey(nextApiKey);
      if (persistBaseUrl) await persistBaseUrl(nextBaseUrl);
      currentApiKey = nextApiKey;
      currentBaseUrl = nextBaseUrl;
      response.json({
        ok: true,
        configured: true,
        persisted: Boolean(persistApiKey && persistBaseUrl),
        baseUrl: currentBaseUrl,
      });
    } catch {
      response.status(500).json({ error: "模型连接设置无法保存；未更改当前设置" });
    }
  });

  app.post("/api/settings/deepseek-key", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!isLoopback(request.socket.remoteAddress) || !isLocalBrowserOrigin(request.get("origin"))) {
      response.status(403).json({ error: "只允许从本机游戏页面设置密钥" });
      return;
    }
    const parsed = apiKeyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "密钥格式不正确" });
      return;
    }

    let persisted = false;
    try {
      persisted = persistApiKey ? await persistApiKey(parsed.data.apiKey) : false;
      currentApiKey = parsed.data.apiKey;
      response.json({ ok: true, configured: true, persisted });
    } catch {
      response.status(500).json({ error: "密钥无法保存到本机安全存储；未更改当前设置" });
    }
  });

  app.post("/api/laws/compile", async (request, response) => {
    if (!currentApiKey) {
      response.status(503).json({ error: "请先设置 DEEPSEEK_API_KEY" });
      return;
    }
    const parsed = compileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "法条请求格式不正确", details: parsed.error.issues.map((issue) => issue.message) });
      return;
    }
    try {
      const draft = await compileLaw(parsed.data, currentApiKey, { baseUrl: currentBaseUrl });
      response.json(draft);
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "法条编译失败" });
    }
  });

  app.use(express.static(webDist));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(webDist, "index.html")));
  return app;
}
