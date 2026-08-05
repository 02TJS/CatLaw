import { BoundedLruCache } from "../game/boundedLru";

export const MAX_EMOJI_CANVAS_CACHE_ENTRIES = 128;

export class EmojiCanvasCache<T> {
  private readonly entries: BoundedLruCache<string, T>;
  private ratio: number | null = null;

  constructor(maxEntries = MAX_EMOJI_CANVAS_CACHE_ENTRIES) {
    this.entries = new BoundedLruCache(maxEntries);
  }

  get size(): number {
    return this.entries.size;
  }

  get(emoji: string, size: number, dpr: number, create: (ratio: number) => T): T {
    const ratio = Math.max(1, Math.round(dpr * 100) / 100);
    if (this.ratio !== ratio) {
      this.entries.clear();
      this.ratio = ratio;
    }
    const key = `${emoji}|${size}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const value = create(ratio);
    this.entries.set(key, value);
    return value;
  }
}
