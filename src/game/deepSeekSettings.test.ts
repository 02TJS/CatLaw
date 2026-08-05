import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCatWorkshopApp } from "../../server/app";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startApi(persistApiKey?: (apiKey: string) => boolean | Promise<boolean>) {
  const server = createServer(createCatWorkshopApp({ webDist: process.cwd(), persistApiKey }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  return `http://127.0.0.1:${address.port}`;
}

describe("DeepSeek startup key settings", () => {
  it("changes an unconfigured server to configured without echoing the secret", async () => {
    let persistedValue = "";
    const origin = await startApi((value) => {
      persistedValue = value;
      return true;
    });
    const secret = `sk-${"a".repeat(32)}`;

    const before = await fetch(`${origin}/api/health`).then((response) => response.json()) as { configured: boolean; keyStorage: string };
    expect(before).toMatchObject({ configured: false, keyStorage: "secure-local" });

    const savedResponse = await fetch(`${origin}/api/settings/deepseek-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ apiKey: secret }),
    });
    const savedText = await savedResponse.text();
    expect(savedResponse.status).toBe(200);
    expect(savedText).not.toContain(secret);
    expect(JSON.parse(savedText)).toEqual({ ok: true, configured: true, persisted: true });
    expect(persistedValue).toBe(secret);

    const after = await fetch(`${origin}/api/health`).then((response) => response.json()) as { configured: boolean };
    expect(after.configured).toBe(true);
  });

  it("rejects malformed keys and non-local browser origins", async () => {
    const origin = await startApi();
    const malformed = await fetch(`${origin}/api/settings/deepseek-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ apiKey: "not-a-key" }),
    });
    expect(malformed.status).toBe(400);

    const foreign = await fetch(`${origin}/api/settings/deepseek-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ apiKey: `sk-${"b".repeat(32)}` }),
    });
    expect(foreign.status).toBe(403);
  });

  it("does not compile through the local fallback while startup setup is incomplete", async () => {
    const origin = await startApi();
    const response = await fetch(`${origin}/api/laws/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ text: "制定一条法规", existingLaws: [] }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "请先设置 DEEPSEEK_API_KEY" });
  });
});
