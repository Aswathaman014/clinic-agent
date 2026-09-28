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

// Free tier rate limits are tight, so retry with exponential backoff.
export async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const retryable = [429, 500, 503].includes(e?.status);
      if (!retryable || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
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

    // Tool loop: run tools the model asks for, feed results back, repeat (max 8 rounds).
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