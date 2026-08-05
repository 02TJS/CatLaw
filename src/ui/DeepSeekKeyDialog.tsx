import { FormEvent, useEffect, useRef, useState } from "react";

interface DeepSeekKeyDialogProps {
  open: boolean;
  required: boolean;
  checking: boolean;
  storage: "secure-local" | "session";
  error: string | null;
  onCancel: () => void;
  onRetry: () => void;
  onSubmit: (apiKey: string) => Promise<void>;
}

export function DeepSeekKeyDialog({
  open,
  required,
  checking,
  storage,
  error,
  onCancel,
  onRetry,
  onSubmit,
}: DeepSeekKeyDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setVisible(false);
      return;
    }
    if (!checking) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [checking, open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || checking) return;
    setSaving(true);
    try {
      await onSubmit(apiKey);
      setApiKey("");
    } finally {
      setSaving(false);
    }
  };

  return <div className="api-key-backdrop" data-testid="deepseek-key-dialog" role="presentation">
    <section className="api-key-dialog" role="dialog" aria-modal="true" aria-labelledby="deepseek-key-title">
      <div className="api-key-mark" aria-hidden="true">🔑</div>
      <div className="api-key-heading">
        <span>本地模型连接</span>
        <h1 id="deepseek-key-title">设置 DEEPSEEK_API_KEY</h1>
        <p>{required
          ? "制定新法规前，需要先连接 DeepSeek。密钥只会发送给本机后端，不会写入游戏存档、浏览器存储或日志。"
          : "输入新密钥会替换本机当前使用的 DeepSeek 密钥。"}</p>
      </div>

      {checking ? <div className="api-key-checking" data-testid="deepseek-key-checking">正在检查本地服务…</div> : <form onSubmit={submit}>
        <label htmlFor="deepseek-api-key">DeepSeek API 密钥</label>
        <div className="api-key-input-row">
          <input
            ref={inputRef}
            id="deepseek-api-key"
            data-testid="deepseek-key-input"
            type={visible ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-…"
            autoComplete="new-password"
            spellCheck={false}
            minLength={20}
            maxLength={512}
            required
          />
          <button type="button" className="api-key-reveal" onClick={() => setVisible((value) => !value)} aria-label={visible ? "隐藏密钥" : "显示密钥"}>
            {visible ? "隐藏" : "显示"}
          </button>
        </div>
        <small>{storage === "secure-local"
          ? "桌面版将使用 Windows 本机加密安全保存；下次启动无需重输。"
          : "网页版只在当前本地服务进程中保存；服务重启后需要重新输入。"}</small>
        {error && <div className="api-key-error" role="alert" data-testid="deepseek-key-error">{error}</div>}
        <div className="api-key-actions">
          {!required && <button type="button" className="api-key-secondary" data-testid="deepseek-key-use-existing" onClick={onCancel}>使用现有密钥进入</button>}
          {error?.includes("本地服务") && <button type="button" className="api-key-secondary" onClick={onRetry}>重新检查</button>}
          <button type="submit" className="api-key-primary" data-testid="deepseek-key-save" disabled={saving || apiKey.trim().length < 20}>
            {saving ? "正在安全保存…" : required ? "保存并进入工坊" : "更换密钥"}
          </button>
        </div>
      </form>}
    </section>
  </div>;
}
