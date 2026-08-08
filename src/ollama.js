export class OllamaClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.visionModel;
    this.timeoutMs = config.requestTimeoutSeconds * 1000;
    this.keepAlive = config.keepAlive;
  }

  async models() {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/tags`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)) });
    } catch (error) {
      const detail = error.cause?.message ?? error.message;
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}: ${detail}. Start Ollama and verify ollama.baseUrl.`);
    }
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} for /tags`);
    return response.json();
  }

  async classify({ imageBuffer, prompt, schema }) {
    const body = {
      model: this.model,
      messages: [{
        role: "user",
        content: prompt,
        images: [imageBuffer.toString("base64")],
      }],
      format: schema,
      stream: false,
      keep_alive: this.keepAlive,
      options: { temperature: 0 },
    };

    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error.cause?.message ?? error.message;
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}: ${detail}. Start Ollama and verify ollama.baseUrl.`);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama returned HTTP ${response.status}: ${detail.slice(0, 1000)}`);
    }
    const payload = await response.json();
    const content = payload.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Ollama response did not contain message.content");
    return { payload, content };
  }

  async embed(input, model) {
    const inputs = Array.isArray(input) ? input : [input];
    let response;
    try {
      response = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error.cause?.message ?? error.message;
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}: ${detail}. Start Ollama and verify ollama.baseUrl.`);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama returned HTTP ${response.status} from /embed: ${detail.slice(0, 1000)}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== inputs.length) {
      throw new Error("Ollama embedding response has an unexpected shape");
    }
    return payload.embeddings;
  }
}
