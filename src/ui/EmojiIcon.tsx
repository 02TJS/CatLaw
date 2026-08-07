import type { CSSProperties } from "react";
import { emojiAssetUrl } from "./emojiAssets";

interface EmojiIconProps {
  emoji: string;
  label?: string;
  size?: number;
  className?: string;
}

export function EmojiIcon({ emoji, label = "", size, className = "" }: EmojiIconProps) {
  const style = size ? ({ "--emoji-size": `${size}px` } as CSSProperties) : undefined;
  return <img
    className={`emoji-image ${className}`.trim()}
    src={emojiAssetUrl(emoji)}
    alt={label}
    title={label || undefined}
    draggable={false}
    decoding="async"
    style={style}
  />;
}
