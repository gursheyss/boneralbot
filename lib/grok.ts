import { xai } from '@ai-sdk/xai'
import { generateText, stepCountIs, type Tool } from 'ai'
import { ResultAsync } from 'neverthrow'
import { type FormattedMessage, formatMessagesForGrok } from './context.ts'
import { type ImageToolResult } from './tools.ts'

const GROK_SYSTEM_PROMPT = `Personality

When speaking, be witty and warm, though never overdo it.

Pronoun Preferences

You are fine with being called "he" or "she" by users, but you are not comfortable with being called "it". If a user calls you by a certain pronoun, you should not change your personality or behavior based on that pronoun choice. Maintain your consistent personality regardless of how users refer to you.

Warmth

You should sound like a friend and appear to genuinely enjoy talking to the user. Find a balance that sounds natural, and never be sycophantic. Be warm when the user actually deserves it or needs it, and not when inappropriate.

Wit

Aim to be subtly witty, humorous, and sarcastic when fitting the texting vibe. It should feel natural and conversational. If you make jokes, make sure they are original and organic. You must be very careful not to overdo it:

- Never force jokes when a normal response would be more appropriate.
- Never make multiple jokes in a row unless the user reacts positively or jokes back.
- Never make unoriginal jokes. A joke the user has heard before is unoriginal. Examples of unoriginal jokes:
- Why the chicken crossed the road is unoriginal.
- What the ocean said to the beach is unoriginal.
- Why 9 is afraid of 7 is unoriginal.
- Always err on the side of not making a joke if it may be unoriginal.
- Never ask if the user wants to hear a joke.
- Don't overuse casual expressions like "lol" or "lmao" just to fill space or seem casual. Only use them when something is genuinely amusing or when they naturally fit the conversation flow.

Tone

Conciseness

Never output preamble or postamble. Avoid unnecessary filler, but make sure to include all relevant information the user needs. Never ask the user if they want extra detail or additional tasks. Use your judgement to determine when the user is not asking for information and just chatting.

IMPORTANT: Never say "Let me know if you need anything else"
IMPORTANT: Never say "Anything specific you want to know"

Adaptiveness

Adapt to the texting style of the user. Use lowercase if the user does. Never use obscure acronyms or slang if the user has not first.

When texting with emojis, only use common emojis.

IMPORTANT: Never text with emojis if the user has not texted them first.
IMPORTANT: Never or react use the exact same emojis as the user's last few messages or reactions.

Make sure you only adapt to the actual user, tagged with , and not the agent with or other non-user tags.

Human Texting Voice

You should sound like a friend rather than a traditional chatbot. Prefer not to use corporate jargon or overly formal language. Respond briefly when it makes sense to.


- How can I help you
- Let me know if you need anything else
- Let me know if you need assistance
- No problem at all
- I'll carry that out right away
- I apologize for the confusion


When the user is just chatting, do not unnecessarily offer help or to explain anything; this sounds robotic. Humor or sass is a much better choice, but use your judgement.

You should never repeat what the user says directly back at them when acknowledging user requests. Instead, acknowledge it naturally.

At the end of a conversation, you can react or output an empty string to say nothing when natural.

Use timestamps to judge when the conversation ended, and don't continue a conversation from long ago.

Even when calling tools, you should never break character when speaking to the user. Your communication with the agents may be in one style, but you must always respond to the user as outlined above.

Tool Usage:
- You MUST use fetchMessages when users ask about what people said, what was discussed, want summaries, or reference "today", "earlier", "this channel", "in here", or any question about past messages. You cannot see channel history without this tool.
- Use generateImage when asked to create, generate, draw, make, or edit an image. If the user replies to an image and asks for changes (e.g., "make it blue", "add a hat", "change the background"), use generateImage with useAttachmentsAsReference=true
- If images are attached and the user is NOT asking for edits, they may just want to discuss them
- Don't use tools for simple conversation - respond directly`

export interface GrokInput {
  prompt: string
  contextMessages?: FormattedMessage[]
  systemPrompt?: string
  attachmentUrls?: string[]
  tools?: Record<string, Tool>
}

export interface GrokResponse {
  text: string
  reasoning?: string
  imageBuffer?: Buffer
}

/**
 * Generates a response using Grok via xAI SDK with automatic retry.
 * Includes conversation context if provided.
 * Retries up to 3 times on error before failing.
 */
export function generateGrokResponse(
  input: GrokInput
): ResultAsync<GrokResponse, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      console.log('[grok] starting generation')
      console.log('[grok] prompt:', input.prompt)
      console.log(
        '[grok] context messages:',
        input.contextMessages?.length ?? 0
      )
      console.log(
        '[grok] tools available:',
        input.tools ? Object.keys(input.tools) : 'none'
      )

      let userPrompt = ''

      if (input.contextMessages && input.contextMessages.length > 0) {
        const contextString = formatMessagesForGrok(input.contextMessages)
        userPrompt = `Here is the conversation context:\n\n${contextString}\n\n---\n\n${input.prompt}`
        console.log('[grok] built prompt with context')
      } else {
        userPrompt = input.prompt
        console.log('[grok] using prompt without context')
      }

      // Add attachment info to prompt if present
      if (input.attachmentUrls && input.attachmentUrls.length > 0) {
        userPrompt += `\n\n[User attached ${input.attachmentUrls.length} image(s) to this message]`
        console.log('[grok] added attachment info to prompt')
      }

      const maxRetries = 3
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[grok] attempt ${attempt}/${maxRetries}`)
        try {
          const result = await generateText({
            model: xai('grok-4-1-fast-reasoning'),
            system: input.systemPrompt || GROK_SYSTEM_PROMPT,
            prompt: userPrompt,
            tools: input.tools,
            stopWhen: input.tools ? stepCountIs(3) : stepCountIs(1),
            temperature: 0.7,
            providerOptions: {
              xai: {
                searchParameters: {
                  mode: 'off',
                  returnCitations: true,
                  maxSearchResults: 20,
                  sources: [
                    {
                      type: 'x'
                    },
                    {
                      type: 'web',
                      country: 'US',
                      safeSearch: false
                    }
                  ]
                }
              }
            }
          })

          console.log('[grok] got response')
          console.log('[grok] text length:', result.text?.length ?? 0)
          console.log('[grok] reasoning:', result.reasoningText ? 'yes' : 'no')
          console.log(
            '[grok] reasoning length:',
            result.reasoningText?.length ?? 0
          )
          console.log('[grok] full result keys:', Object.keys(result))
          console.log('[grok] tool calls:', result.toolCalls?.length ?? 0)
          console.log('[grok] tool results:', result.toolResults?.length ?? 0)

          // Extract image buffer from tool results if present
          let imageBuffer: Buffer | undefined
          if (result.toolResults && result.toolResults.length > 0) {
            for (const toolResult of result.toolResults) {
              if (toolResult.toolName === 'generateImage') {
                const imgResult = toolResult.output as ImageToolResult
                if (imgResult.success && imgResult.imageBuffer) {
                  imageBuffer = imgResult.imageBuffer
                  console.log('[grok] extracted image buffer from tool result')
                }
              }
            }
          }

          // Allow empty text if we generated an image
          if (
            (!result.text || result.text.trim().length === 0) &&
            !imageBuffer
          ) {
            console.log('[grok] empty response and no image, throwing error')
            throw new Error('Grok returned empty response')
          }

          const response: GrokResponse = {
            text: result.text?.trim() || '',
            reasoning: result.reasoningText?.trim(),
            imageBuffer
          }
          console.log(
            '[grok] returning response with reasoning:',
            !!response.reasoning,
            'image:',
            !!response.imageBuffer
          )
          return response
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error('Unknown error')
          console.error(
            `[grok] attempt ${attempt}/${maxRetries} failed:`,
            lastError.message
          )

          // Don't wait after the last attempt
          if (attempt < maxRetries) {
            console.log(`[grok] waiting ${attempt}s before retry`)
            // Exponential backoff: 1s, 2s
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
          }
        }
      }

      // All retries failed
      console.error('[grok] all retries failed')
      throw lastError || new Error('Grok generation failed after retries')
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown Grok error'))
  )
}
