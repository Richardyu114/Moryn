/**
 * Builds a collision-free DOM token from an arbitrary JSON string ID.
 * Unsafe UTF-16 code units use fixed-width escapes, avoiding aliases such as
 * `rec:a`/`rec/a` while leaving ordinary record IDs compact and readable.
 */
export function dashboardDrawerId(kind: "record" | "event", value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    encoded += /^[a-zA-Z0-9_-]$/u.test(character)
      ? character
      : `~${value.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return `${kind}-${encoded}`;
}
