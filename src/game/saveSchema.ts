export const SAVE_SCHEMA_VERSION = 17 as const;

export const SUPPORTED_SAVE_SCHEMA_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
] as const;

export type SupportedSaveSchemaVersion = typeof SUPPORTED_SAVE_SCHEMA_VERSIONS[number];
export type SaveSchemaVersion = typeof SAVE_SCHEMA_VERSION;

export function isSupportedSaveSchemaVersion(value: unknown): value is SupportedSaveSchemaVersion {
  return (SUPPORTED_SAVE_SCHEMA_VERSIONS as readonly unknown[]).includes(value);
}
