import type { MemoraRecord } from "./types.js";

export function contentValueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(contentValueText).filter(Boolean).join(" ");
  if (typeof value === "object" && value !== null) return Object.values(value).map(contentValueText).filter(Boolean).join(" ");
  return "";
}

export function searchableContentText(content: Record<string, unknown>): string {
  return Object.entries(content)
    .filter(([key]) => key !== "format")
    .map(([, value]) => contentValueText(value))
    .filter(Boolean)
    .join(" ");
}

export function searchableRecordText(record: MemoraRecord): string {
  return searchableContentText(record.content);
}

export function displayRecordText(record: MemoraRecord): string {
  return typeof record.content.text === "string" ? record.content.text : searchableRecordText(record);
}
