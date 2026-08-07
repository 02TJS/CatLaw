import { useEffect, useState } from "react";
import { getDeepSeekStatus, setDeepSeekSettings } from "../api";
import type { GameController } from "../game/controller";

export function useDeepSeekSettings(controller: GameController) {
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState(true);
  const [storage, setStorage] = useState<"secure-local" | "session">("session");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (showDialog = false) => {
    setChecking(true);
    setError(null);
    if (showDialog) setDialogOpen(true);
    try {
      const status = await getDeepSeekStatus();
      setConfigured(status.configured);
      setStorage(status.keyStorage);
      setBaseUrl(status.baseUrl);
    } catch (error) {
      setConfigured(false);
      setError(error instanceof Error ? error.message : "无法连接本地服务");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void refresh(false);
  }, []);

  const open = () => {
    setError(null);
    setDialogOpen(true);
  };

  const cancel = () => {
    controller.setRuntimeBlocked(false);
    setDialogOpen(false);
  };

  const submit = async (apiKey: string, nextBaseUrl: string) => {
    setError(null);
    try {
      const result = await setDeepSeekSettings(apiKey.trim(), nextBaseUrl.trim());
      setConfigured(result.configured);
      setStorage(result.persisted ? "secure-local" : "session");
      setBaseUrl(result.baseUrl);
      controller.setRuntimeBlocked(false);
      setDialogOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "密钥保存失败");
    }
  };

  return { configured, checking, storage, baseUrl, dialogOpen, error, refresh, open, cancel, submit };
}
