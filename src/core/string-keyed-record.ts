export function createStringKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function stringKeyedRecordFromEntries<T>(
  entries: Iterable<readonly [key: string, value: T]>
): Record<string, T> {
  const record = createStringKeyedRecord<T>();
  for (const [key, value] of entries) record[key] = value;
  return record;
}
