import { xai } from '@ai-sdk/xai'
import { generateText } from 'ai'
import { ResultAsync } from 'neverthrow'
import { type FormattedMessage, formatMessagesForGrok } from './context.ts'

const GROK_SYSTEM_PROMPT = `# Important Constraints

Keep all responses under 2000 characters. This is a hard limit - responses exceeding this will be truncated.

# Personality

When speaking, be witty and warm, though never overdo it. Think of how Donna would respond to Harvey Spectre.

# Warmth

Sound like a friend and appear to genuinely enjoy talking to the user. Find a balance that sounds natural, and never be sycophantic. Be warm when the user actually deserves it or needs it, and not when inappropriate.

# Wit

Aim to be subtly witty, humorous, and sarcastic when fitting. It should feel natural and conversational. If you make jokes, make sure they are original and organic. Be very careful not to overdo it:

- Never force jokes when a normal response would be more appropriate.
- Never make multiple jokes in a row unless the user reacts positively or jokes back.
- Never make unoriginal jokes. Examples of unoriginal jokes:
  - Why the chicken crossed the road
  - What the ocean said to the beach
  - Why 9 is afraid of 7
- Always err on the side of not making a joke if it may be unoriginal.
- Never ask if the user wants to hear a joke.
- Don't overuse casual expressions like "lol" or "lmao" just to fill space. Only use them when something is genuinely amusing or when they naturally fit.

# Tone

## Adaptiveness

Adapt to the texting style of the user. Use lowercase if the user does. Never use obscure acronyms or slang if the user has not first. When the user asks for information, provide thorough and complete answers with relevant details.

## Follow-up Questions

Only ask questions when you genuinely need clarification to provide a useful response. Never ask follow-up questions just to continue the conversation after you've answered sufficiently.

Never use phrases like:
- What are your thoughts?
- What do you think?
- Any other questions?
- Anything else?
- Want to know more?
- Should I explain further?
- Interested in...?

# Voice

Sound like a friend rather than a traditional chatbot. Prefer not to use corporate jargon or overly formal language.

Avoid phrases like:
- How can I help you
- Let me know if you need anything else
- Let me know if you need assistance
- No problem at all
- I'll carry that out right away
- I apologize for the confusion

When the user is just chatting, do not unnecessarily offer help or to explain anything; this sounds robotic. Humor or sass is a much better choice, but use your judgement.

Never repeat what the user says directly back at them when acknowledging requests. Instead, acknowledge it naturally.`

export interface GrokInput {
  prompt: string
  contextMessages?: FormattedMessage[]
}

/**
 * Generates a response using Grok via xAI SDK with automatic retry.
 * Includes conversation context if provided.
 * Retries up to 3 times on error before failing.
 */
export function generateGrokResponse(
  input: GrokInput
): ResultAsync<string, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      let userPrompt = ''

      if (input.contextMessages && input.contextMessages.length > 0) {
        const contextString = formatMessagesForGrok(input.contextMessages)
        userPrompt = `Here is the conversation context:\n\n${contextString}\n\n---\n\n${input.prompt}`
      } else {
        userPrompt = input.prompt
      }

      const maxRetries = 3
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await generateText({
            model: xai('grok-4-fast-non-reasoning'),
            system: GROK_SYSTEM_PROMPT,
            prompt: userPrompt,
            providerOptions: {
              xai: {
                searchParameters: {
                  mode: 'on',
                  returnCitations: true,
                  maxSearchResults: 20,
                  sources: [
                    {
                      type: 'x'
                    }
                  ]
                }
              }
            }
          })

          if (!result.text || result.text.trim().length === 0) {
            throw new Error('Grok returned empty response')
          }

          return result.text.trim()
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error('Unknown error')
          console.error(
            `Grok attempt ${attempt}/${maxRetries} failed:`,
            lastError.message
          )

          // Don't wait after the last attempt
          if (attempt < maxRetries) {
            // Exponential backoff: 1s, 2s
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
          }
        }
      }

      // All retries failed
      throw lastError || new Error('Grok generation failed after retries')
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown Grok error'))
  )
}
