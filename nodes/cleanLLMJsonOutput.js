// Utility: Robustly clean LLM JSON output (removes code fences, extracts JSON)
export function cleanLLMJsonOutput(output) {
  let cleaned = output.trim();
  // Remove code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?|```$/g, '').trim();
  }
  // Find the first { or [ and last } or ]
  const firstBrace = Math.min(
    ...['{', '['].map(c => cleaned.indexOf(c)).filter(i => i !== -1)
  );
  const lastBrace = Math.max(
    ...['}', ']'].map(c => cleaned.lastIndexOf(c))
  );
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}
