import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import { voiceProfile } from "../db/schema.js";
import { eq } from "drizzle-orm";

export interface VoiceAnalysis {
  tone: string;
  formality: "casual" | "neutral" | "formal";
  emojiUsage: "none" | "minimal" | "moderate" | "heavy";
  greetingPatterns: string[];
  signOffPatterns: string[];
  characteristicPhrases: string[];
  averageMessageLength: "short" | "medium" | "long";
  punctuationStyle: string;
}

export interface VoicePreferences {
  useEmojis: boolean;
  formalityLevel: "casual" | "neutral" | "formal";
  signOff: string;
  greeting: string;
  customInstructions: string;
}

export interface VoiceProfile {
  id: number;
  sampleMessages: string[];
  toneAnalysis: VoiceAnalysis;
  preferences: VoicePreferences;
  updatedAt: string | null;
}

export class VoiceProfileService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic();
  }

  async analyzeSamples(samples: string[]): Promise<VoiceAnalysis> {
    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Analyze the following text messages sent by a gym instructor to their clients. Extract the writing style and voice characteristics.

Messages:
${samples.map((s, i) => `${i + 1}. "${s}"`).join("\n")}

Respond with a JSON object (no markdown, just raw JSON) with these fields:
- tone: string describing overall tone (e.g., "friendly and encouraging", "professional but warm")
- formality: "casual" | "neutral" | "formal"
- emojiUsage: "none" | "minimal" | "moderate" | "heavy"
- greetingPatterns: array of greeting styles they use (e.g., ["Hey", "What's up"])
- signOffPatterns: array of sign-off styles (e.g., ["See ya!", "Talk soon"])
- characteristicPhrases: array of distinctive phrases they use
- averageMessageLength: "short" | "medium" | "long"
- punctuationStyle: string describing punctuation habits`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const analysis: VoiceAnalysis = JSON.parse(text);

    // Store in database
    const existing = db.select().from(voiceProfile).all();
    if (existing.length > 0) {
      db.update(voiceProfile)
        .set({
          sampleMessages: JSON.stringify(samples),
          toneAnalysis: JSON.stringify(analysis),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(voiceProfile.id, existing[0].id))
        .run();
    } else {
      db.insert(voiceProfile)
        .values({
          sampleMessages: JSON.stringify(samples),
          toneAnalysis: JSON.stringify(analysis),
          preferences: JSON.stringify({
            useEmojis: analysis.emojiUsage !== "none",
            formalityLevel: analysis.formality,
            signOff: analysis.signOffPatterns[0] || "",
            greeting: analysis.greetingPatterns[0] || "Hey",
            customInstructions: "",
          } satisfies VoicePreferences),
          updatedAt: new Date().toISOString(),
        })
        .run();
    }

    return analysis;
  }

  async getProfile(): Promise<VoiceProfile | null> {
    const rows = db.select().from(voiceProfile).all();
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      sampleMessages: row.sampleMessages
        ? JSON.parse(row.sampleMessages)
        : [],
      toneAnalysis: row.toneAnalysis ? JSON.parse(row.toneAnalysis) : null,
      preferences: row.preferences
        ? JSON.parse(row.preferences)
        : {
            useEmojis: false,
            formalityLevel: "casual",
            signOff: "",
            greeting: "Hey",
            customInstructions: "",
          },
      updatedAt: row.updatedAt,
    };
  }

  async updatePreferences(prefs: Partial<VoicePreferences>): Promise<void> {
    const existing = db.select().from(voiceProfile).all();
    if (existing.length === 0) {
      const defaultPrefs: VoicePreferences = {
        useEmojis: false,
        formalityLevel: "casual",
        signOff: "",
        greeting: "Hey",
        customInstructions: "",
        ...prefs,
      };
      db.insert(voiceProfile)
        .values({
          preferences: JSON.stringify(defaultPrefs),
          updatedAt: new Date().toISOString(),
        })
        .run();
    } else {
      const currentPrefs = existing[0].preferences
        ? JSON.parse(existing[0].preferences)
        : {};
      const merged = { ...currentPrefs, ...prefs };
      db.update(voiceProfile)
        .set({
          preferences: JSON.stringify(merged),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(voiceProfile.id, existing[0].id))
        .run();
    }
  }

  async composeInVoice(
    intent: string,
    context: Record<string, unknown>
  ): Promise<string> {
    const profile = await this.getProfile();

    let voiceInstructions: string;
    if (profile?.toneAnalysis) {
      const analysis = profile.toneAnalysis;
      const prefs = profile.preferences;
      voiceInstructions = `Write in the following voice:
- Tone: ${analysis.tone}
- Formality: ${analysis.formality}
- Emoji usage: ${prefs.useEmojis ? analysis.emojiUsage : "none"}
- Greeting style: ${prefs.greeting || analysis.greetingPatterns.join(", ")}
- Sign-off style: ${prefs.signOff || analysis.signOffPatterns.join(", ")}
- Characteristic phrases to use: ${analysis.characteristicPhrases.join(", ")}
- Message length: ${analysis.averageMessageLength}
${prefs.customInstructions ? `- Additional instructions: ${prefs.customInstructions}` : ""}`;
    } else {
      voiceInstructions = `Write in a friendly, casual gym instructor tone. Keep it brief and natural like a real text message.`;
    }

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `${voiceInstructions}

Compose a text message with the following intent: ${intent}

Context: ${JSON.stringify(context)}

Respond with ONLY the text message content, nothing else.`,
        },
      ],
    });

    return response.content[0].type === "text"
      ? response.content[0].text.trim()
      : "";
  }
}

export const voiceProfileService = new VoiceProfileService();
