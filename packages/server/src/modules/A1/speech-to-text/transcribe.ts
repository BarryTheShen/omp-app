import type { SpeechLanguage, SpeechServerApi } from "@omp-app/contracts";

/** A transcription server as this server keeps it: with its key, which no page ever sees. */
export interface StoredSpeechServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly api: SpeechServerApi;
  readonly model: string;
  readonly key?: string;
}

export interface TranscribeRequest {
  readonly server: StoredSpeechServer;
  /** 16 kHz mono 16-bit WAV. */
  readonly wav: Uint8Array;
  readonly language: SpeechLanguage;
  /** Words to recognise, given as context; empty for none. */
  readonly context: string;
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
}

/** `http://host:8080/v1/` and `http://host:8080/v1` both end without the slash. */
function base(url: string): string {
  return url.replace(/\/+$/, "");
}

function headers(server: StoredSpeechServer): Record<string, string> {
  return server.key === undefined ? {} : { authorization: `Bearer ${server.key}` };
}

async function failure(response: Response): Promise<Error> {
  const body = (await response.text().catch(() => "")).trim().slice(0, 300);
  return new Error(`HTTP ${response.status}${body === "" ? "" : `: ${body}`}`);
}

/**
 * Qwen3-ASR's chat answer names the language before the text (`language Chinese<asr_text>你好`), and an answer for no
 * speech has no text (`language None<asr_text>`). Other models answer with the text alone.
 */
export function cleanAsrText(content: string): string {
  const marker = content.lastIndexOf("<asr_text>");
  const text = marker === -1 ? content : content.slice(marker + "<asr_text>".length);
  return text.replace(/<\/?asr_text>/g, "").trim();
}

/** The language Qwen3-ASR named (`language Portuguese`), from its text or from where llama-server moves it. */
function namedLanguage(...parts: unknown[]): string | undefined {
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const named = /language\s+([A-Za-z]+)/.exec(part)?.[1];
    if (named !== undefined && named !== "None") return named;
  }
  return undefined;
}

/** What a server heard in one piece. */
export interface Heard {
  readonly text: string;
  /** The language the model named, when it names one (Qwen3-ASR over the chat API). */
  readonly language?: string;
  /** The answer ran to its length cap: a model repeating itself on noise, not speech. */
  readonly looped: boolean;
}

/** The languages the model may name for each setting; `auto` takes any. Chinese includes Cantonese. */
const LANGUAGES: Record<SpeechLanguage, readonly string[] | null> = {
  auto: null,
  zh: ["Chinese", "Cantonese"],
  en: ["English"],
  "zh-en": ["Chinese", "Cantonese", "English"],
};

/** Whether text the model says is in `named` is kept under the setting `language`; an unnamed language always is. */
export function languageAllowed(language: SpeechLanguage, named: string | undefined): boolean {
  const allowed = LANGUAGES[language];
  return allowed === null || named === undefined || allowed.includes(named);
}

/** The most tokens a piece's answer may take: far above speech (about 6 a second), so only a loop reaches it. */
function tokenCap(wav: Uint8Array): number {
  const seconds = Math.max(0, wav.length - 44) / (16000 * 2);
  return Math.ceil(40 + 12 * seconds);
}

/** Asks one server for one piece's text; throws, with the server's words, when it fails. */
export async function transcribe(request: TranscribeRequest): Promise<Heard> {
  const { server } = request;
  if (server.api === "transcriptions") {
    const form = new FormData();
    form.set("file", new Blob([request.wav], { type: "audio/wav" }), "piece.wav");
    if (server.model !== "") form.set("model", server.model);
    if (request.language === "zh" || request.language === "en")
      form.set("language", request.language);
    if (request.context !== "") form.set("prompt", request.context);
    form.set("response_format", "json");
    const response = await request.fetch(`${base(server.url)}/audio/transcriptions`, {
      method: "POST",
      headers: headers(server),
      body: form,
      signal: request.signal,
    });
    if (!response.ok) throw await failure(response);
    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text !== "string") throw new Error("The server's answer had no text.");
    const language = namedLanguage(body.text);
    return {
      text: cleanAsrText(body.text),
      ...(language === undefined ? {} : { language }),
      looped: false,
    };
  }
  const messages: unknown[] = [];
  if (request.context !== "") messages.push({ role: "system", content: request.context });
  messages.push({
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: { data: Buffer.from(request.wav).toString("base64"), format: "wav" },
      },
    ],
  });
  const response = await request.fetch(`${base(server.url)}/chat/completions`, {
    method: "POST",
    headers: { ...headers(server), "content-type": "application/json" },
    body: JSON.stringify({
      ...(server.model === "" ? {} : { model: server.model }),
      messages,
      temperature: 0,
      stream: false,
      max_tokens: tokenCap(request.wav),
    }),
    signal: request.signal,
  });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as {
    choices?: {
      message?: { content?: unknown; reasoning_content?: unknown };
      finish_reason?: unknown;
    }[];
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new Error("The server's answer had no text.");
  // llama-server moves Qwen3-ASR's "language X" out of the text into `reasoning_content`.
  const language = namedLanguage(choice?.message?.reasoning_content, content);
  return {
    text: cleanAsrText(content),
    ...(language === undefined ? {} : { language }),
    looped: choice?.finish_reason === "length",
  };
}

/**
 * The pieces' texts as one: a space between two pieces only where both sides are Latin letters or digits (English on
 * both sides of the cut); Chinese, and Chinese next to English, joins without one.
 */
export function joinPieceTexts(texts: readonly string[]): string {
  let joined = "";
  for (const text of texts) {
    if (text === "") continue;
    const before = joined.at(-1) ?? "";
    const after = text[0] ?? "";
    const space = /[A-Za-z0-9.,;:!?'")]/.test(before) && /[A-Za-z0-9"'(]/.test(after);
    joined += (space ? " " : "") + text;
  }
  return joined;
}

/** A WAV of 16 kHz mono 16-bit samples, `ms` long, all silence: what Test sends. */
export function silentWav(ms: number): Uint8Array {
  const samples = Math.round((16000 * ms) / 1000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}
