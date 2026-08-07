/** Convert an emoji grapheme to the local Twemoji PNG filename. */
export function emojiAssetCode(emoji: string): string {
  return [...emoji]
    .map((character) => character.codePointAt(0)!)
    .filter((codePoint) => codePoint !== 0xfe0f)
    .map((codePoint) => codePoint.toString(16))
    .join("-");
}

export function emojiAssetUrl(emoji: string): string {
  return `/emoji/${emojiAssetCode(emoji)}.png`;
}
