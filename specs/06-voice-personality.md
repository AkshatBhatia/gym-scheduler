# 06 — Voice Personality Profile

## What

A system that captures and replicates the instructor's unique communication style so all AI-generated messages sound like they came directly from the instructor.

## How

### Onboarding Flow

1. During setup (or via the dashboard), the instructor provides **5–10 sample messages** they have actually sent to clients. Examples:
   - "Hey girl! See you at 9 tomorrow, bring water!"
   - "Yo Mike — great session today. Same time Thursday?"
2. These samples are stored in the `voice_profile.sample_messages` JSON array.
3. The system sends the samples to Claude with an analysis prompt.

### Tone Analysis

Claude analyzes the samples and produces a structured `tone_analysis` JSON object:

```json
{
  "formality": "casual",
  "energy": "high",
  "greeting_patterns": ["Hey", "Yo", "Hey girl"],
  "signoff_patterns": ["See you there!", "Let's go!"],
  "emoji_usage": "moderate",
  "common_emojis": ["!", "💪", "🔥"],
  "slang_terms": ["girl", "yo", "sesh"],
  "sentence_length": "short",
  "punctuation_style": "exclamation-heavy",
  "typical_message_length": "1-2 sentences"
}
```

This analysis is stored in `voice_profile.tone_analysis`.

### Preferences Override

The `voice_profile.preferences` JSON stores manual overrides:

```json
{
  "use_emojis": true,
  "formality_level": 2,
  "max_message_length": 160,
  "always_include_name": true
}
```

These can be adjusted via the dashboard or chat ("Make my messages a bit more formal").

### Usage in Message Composition

Every time Claude composes an outbound message (confirmations, replies, briefings), the system prompt includes:

1. The tone analysis object.
2. 2–3 sample messages as few-shot examples.
3. Any preference overrides.
4. The instruction: "Write as if you are this person. Match their tone, word choice, and style exactly."

### Profile Updates

- The instructor can add new sample messages at any time via the dashboard or by texting "Add this to my voice samples: [message]".
- "Re-analyze" triggers a fresh Claude analysis of all current samples.
- The updated_at timestamp tracks the last modification.

### Single Profile

V1 supports one voice profile (singleton row). The system assumes a single instructor.

## Validation Plan

1. **Analysis quality**: Provide 5 casual samples; verify tone_analysis correctly identifies casual tone, emoji usage, and greeting patterns.
2. **Message matching**: Generate 10 outbound messages with the profile; have a human judge rate them 1–5 for voice consistency. Target: average >= 4.
3. **Preference override**: Set `use_emojis: false`; generate a message; verify no emojis appear.
4. **Sample update**: Add a new sample message via chat; verify it appears in the stored sample_messages array.
5. **Re-analysis**: Change samples from casual to formal; trigger re-analyze; verify tone_analysis updates accordingly.
