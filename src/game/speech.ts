import type { FloatingEvent, LawSpeechTemplates } from "./types.js";

export const SPEECH_TEMPLATE_COUNT = 5;
export const SPEECH_TEMPLATE_MAX_CODEPOINTS = 56;
export const SPEECH_DURATION_MS = 4_500;
export const SPEECH_COOLDOWN_MS = 5_000;
export const MAX_ACTIVE_SPEECH_BUBBLES = 5;
export const SPEECH_MIN_DELAY_MS = 1_000;
export const SPEECH_MAX_DELAY_MS = 5_000;
export const SPEECH_FREQUENCY_MIN = 0;
export const SPEECH_FREQUENCY_MAX = 100;
export const DEFAULT_SPEECH_FREQUENCY = 70;

const ALLOWED_PLACEHOLDERS = new Set(["law", "reason", "action", "item", "direction", "gain"]);

export const DEFAULT_LAW_SPEECH_TEMPLATES: LawSpeechTemplates = [
  "因{reason}，{action}能赚{gain}喵！",
  "按{law}，{reason}；{action}赚{gain}喵。",
  "这次{action}有{gain}收益，因为{reason}喵！",
  "我算过了：{action}赚{gain}，{reason}喵。",
  "因为{reason}，所以{action}，能赚{gain}喵！",
];

export interface SpeechTemplateValidation {
  ok: boolean;
  messages: string[];
}

export function validateSpeechTemplates(input: unknown): SpeechTemplateValidation {
  const messages: string[] = [];
  if (!Array.isArray(input) || input.length !== SPEECH_TEMPLATE_COUNT) {
    return { ok: false, messages: [`决策台词必须恰好有 ${SPEECH_TEMPLATE_COUNT} 句。`] };
  }
  input.forEach((raw, index) => {
    if (typeof raw !== "string") {
      messages.push(`决策台词 ${index + 1} 必须是文本。`);
      return;
    }
    if ([...raw].length > SPEECH_TEMPLATE_MAX_CODEPOINTS) messages.push(`决策台词 ${index + 1} 超过 ${SPEECH_TEMPLATE_MAX_CODEPOINTS} 个字符。`);
    if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) messages.push(`决策台词 ${index + 1} 含有换行或控制字符。`);
    if (!raw.includes("喵")) messages.push(`决策台词 ${index + 1} 必须包含“喵”。`);
    const placeholders = [...raw.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]);
    const stripped = raw.replace(/\{[^{}]+\}/gu, "");
    if (/[{}]/u.test(stripped)) messages.push(`决策台词 ${index + 1} 含有不完整占位符。`);
    const unknown = placeholders.filter((name) => !ALLOWED_PLACEHOLDERS.has(name));
    if (unknown.length) messages.push(`决策台词 ${index + 1} 含有未知占位符：${[...new Set(unknown)].join("、")}。`);
    if (!placeholders.includes("action")) messages.push(`决策台词 ${index + 1} 必须引用完整动作。`);
    if (!placeholders.includes("reason")) messages.push(`决策台词 ${index + 1} 必须引用实际原因。`);
    if (!placeholders.includes("gain")) messages.push(`决策台词 ${index + 1} 必须引用实际预计收益。`);
  });
  return { ok: messages.length === 0, messages };
}

export function safeSpeechTemplates(input: unknown): LawSpeechTemplates {
  return validateSpeechTemplates(input).ok
    ? [...(input as LawSpeechTemplates)] as LawSpeechTemplates
    : [...DEFAULT_LAW_SPEECH_TEMPLATES] as LawSpeechTemplates;
}

export function fillSpeechTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(law|reason|action|item|direction|gain)\}/gu, (_match, name: string) => values[name] ?? "");
}

export function speechHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function normalizeSpeechFrequency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPEECH_FREQUENCY;
  return Math.round(Math.max(SPEECH_FREQUENCY_MIN, Math.min(SPEECH_FREQUENCY_MAX, value)));
}

/**
 * Keep the frequency control perceptible even when many cats decide on the
 * same simulation tick. Without this admission cap, the global five-bubble
 * limit is saturated at both 70% and 100%, so most slider positions look the
 * same despite using different per-decision rolls.
 */
export function speechCapacityForFrequency(frequency: unknown): number {
  const normalized = normalizeSpeechFrequency(frequency);
  if (normalized === 0) return 0;
  return Math.max(1, Math.ceil(MAX_ACTIVE_SPEECH_BUBBLES * normalized / SPEECH_FREQUENCY_MAX));
}

export function speechRoll(key: string, frequency = DEFAULT_SPEECH_FREQUENCY): { speaks: boolean; templateIndex: number; delayMs: number } {
  const triggerHash = speechHash(`trigger|${key}`);
  const templateHash = speechHash(`template|${key}`);
  const delayHash = speechHash(`delay|${key}`);
  return {
    speaks: triggerHash % 100 < normalizeSpeechFrequency(frequency),
    templateIndex: templateHash % SPEECH_TEMPLATE_COUNT,
    delayMs: SPEECH_MIN_DELAY_MS + delayHash % (SPEECH_MAX_DELAY_MS - SPEECH_MIN_DELAY_MS + 1),
  };
}

export function formatSpeechGain(cents: number): string {
  return `${(Math.max(0, cents) / 100).toFixed(2)}金币`;
}

export function formatSpeechAction(type: "craft" | "pass", item: string, destination = ""): string {
  return type === "craft" ? `制作${item}` : `把${item}运到${destination || "下一站"}`;
}

export function speechEventIsVisible(event: FloatingEvent, simTime: number): boolean {
  return event.kind === "speech" && simTime >= event.createdAt && simTime < event.createdAt + event.duration;
}

export function speechEventIsQueuedOrVisible(event: FloatingEvent, simTime: number): boolean {
  return event.kind === "speech" && simTime < event.createdAt + event.duration;
}
