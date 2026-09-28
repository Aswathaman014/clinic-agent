import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { MODEL } from "../config.js";
import { Session, executeTool, toolSchemas, toolDescriptions } from "./tools.js";
import { buildSystemPrompt, type RulesFile } from "./prompt.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const functionDeclarations = (Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]).map((name) => {
  const { $schema, ...schema } = z.toJSONSchema(toolSchemas[name]) as any;
  return { name, description: toolDescriptions[name], parametersJsonSchema: schema };
});

// Retry temporary Gemini overloads (503/500), short rate limits (429) and network drops
// ("fetch failed") with backoff. Fail fast and clearly when the DAILY quota is used up.
export async function withRetry<T>(fn: () => Promise<T>, tries = 7): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (e?.status === 429 && (msg.includes("PerDay") || msg.includes("limit: 0"))) {
        throw new Error(
          "DAILY_QUOTA_EXHAUSTED: change MODEL in src/config.ts, wait for the quota reset, or enable billing."
        );
      }
      const networkError = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(
        msg + " " + String(e?.cause?.code ?? e?.cause ?? "")
      );
      const retryable = [429, 500, 503].includes(e?.status) || networkError;
      if (!retryable || i >= tries - 1) throw e;
      const delay = Math.min(2000 * 2 ** i, 30000) + Math.random() * 1000; // 2s, 4s, 8s, 16s, 30s, 30s
      const what = networkError ? "network error" : `Gemini ${e.status}`;
      console.log(`  (${what}, retry ${i + 1}/${tries - 1} in ${Math.round(delay / 1000)}s)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export type Turn = { role: "patient" | "agent"; text: string };

export class Agent {
  session = new Session();
  transcript: Turn[] = [];
  private chat;

  constructor(rules?: RulesFile) {
    this.chat = ai.chats.create({
      model: MODEL,
      config: {
        systemInstruction: buildSystemPrompt(rules),
        tools: [{ functionDeclarations }],
        temperature: 0,
      },
    });
  }

  async send(userText: string): Promise<string> {
    this.transcript.push({ role: "patient", text: userText });
    let res = await withRetry(() => this.chat.sendMessage({ message: userText }));

    // Tool loop: run the tools the model asks for, feed results back, repeat (max 8 rounds).
    for (let step = 0; step < 8; step++) {
      const calls = res.functionCalls;
      if (!calls || calls.length === 0) break;
      const parts = calls.map((c) => ({
        functionResponse: { name: c.name!, response: executeTool(this.session, c.name!, c.args) },
      }));
      res = await withRetry(() => this.chat.sendMessage({ message: parts }));
    }

    const text = res.text?.trim() || "Sorry, I had trouble with that. Could you say it again?";
    this.transcript.push({ role: "agent", text });
    return text;
  }
}