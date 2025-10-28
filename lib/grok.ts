import Replicate from 'replicate'
import { ResultAsync, ok, err } from 'neverthrow'
import { type FormattedMessage, formatMessagesForGrok } from './context.ts'

const replicate = new Replicate()

export interface GrokInput {
  prompt: string
  contextMessages?: FormattedMessage[]
  temperature?: number
  max_tokens?: number
  top_p?: number
}

/**
 * Generates a response using Grok-4 via Replicate.
 * Includes conversation context if provided.
 */
export function generateGrokResponse(
  input: GrokInput
): ResultAsync<string, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      // Build the full prompt with context
      let fullPrompt = ''

      if (input.contextMessages && input.contextMessages.length > 0) {
        const contextString = formatMessagesForGrok(input.contextMessages)
        fullPrompt = `Here is the conversation context:\n\n${contextString}\n\n---\n\nUser: ${input.prompt}`
      } else {
        fullPrompt = input.prompt
      }

      // Prepare Grok API input
      const grokInput = {
        prompt: fullPrompt
      }

      // Stream the response and aggregate
      let response = ''

      try {
        for await (const event of replicate.stream('xai/grok-4', {
          input: grokInput
        })) {
          response += event
        }
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error('Grok streaming failed')
      }

      if (!response || response.trim().length === 0) {
        throw new Error('Grok returned empty response')
      }

      return response.trim()
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown Grok error'))
  )
}
