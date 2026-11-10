export async function* assistantText(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider returned an empty chat stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const parse = (line: string): string | null => {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (!data) return null;
    if (data === "[DONE]") { completed = true; return null; }
    let event;
    try { event = JSON.parse(data); } catch { return null; }
    if (event.type === "error" || event.error) throw new Error(event.error?.message ?? event.message ?? String(event.error ?? "Provider streaming failed."));
    const text = (event.type === "content_block_delta" ? event.delta?.text : null) ?? event.choices?.[0]?.delta?.content;
    return typeof text === "string" ? text : null;
  };
  try {
    while (!completed) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (done && buffer) { lines.push(buffer); buffer = ""; }
      for (const line of lines) {
        const text = parse(line);
        if (text) yield text;
        if (completed) break;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
