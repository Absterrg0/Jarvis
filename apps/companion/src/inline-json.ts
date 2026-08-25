/**
 * Serializes data for a JavaScript inline script. JSON escaping alone permits
 * a string containing `</script>` to terminate the enclosing HTML script tag.
 */
export function safeInlineJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? "null" : serialized)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
