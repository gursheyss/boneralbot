import { tool } from 'ai'
import { z } from 'zod'
import type { Message } from 'discord.js'
import { generateImage as generateImageFromReplicate } from './image.ts'
import {
  fetchMessagesFromLastHour,
  fetchConversationContext,
  truncateMessagesForContext,
  formatMessagesForGrok
} from './context.ts'

export interface ToolContext {
  discordMessage: Message
  attachmentUrls: string[]
  userId: string
  username: string
}

export interface ImageToolResult {
  success: boolean
  imageBuffer?: Buffer
  error?: string
}

/**
 * Creates tools with the Discord context bound.
 * This allows tools to access the Discord message and user info.
 */
export function createTools(ctx: ToolContext) {
  return {
    fetchMessages: tool({
      description:
        'Fetch recent messages from the current Discord channel. You MUST use this tool when the user asks about what people said, what was discussed, wants a summary, or references "today", "earlier", "this channel", "in here", or any question about past conversation.',
      inputSchema: z.object({
        minutes: z
          .number()
          .min(5)
          .max(120)
          .optional()
          .describe('Fetch messages from the last N minutes (5-120)'),
        count: z
          .number()
          .min(10)
          .max(100)
          .optional()
          .describe('Fetch the last N messages (10-100)')
      }),
      execute: async ({ minutes, count }: { minutes?: number; count?: number }) => {
        console.log('[tools:fetchMessages] called with:', { minutes, count })

        let messages
        if (minutes) {
          // Time-based fetch
          const cutoffMs = minutes * 60 * 1000
          const cutoffTime = new Date(Date.now() - cutoffMs)

          // Use existing hour-based fetch but filter to the requested time range
          const hourMessages = await fetchMessagesFromLastHour(
            ctx.discordMessage,
            {
              excludeBots: true,
              maxMessages: 500
            }
          )

          messages = hourMessages.filter((msg) => msg.timestamp >= cutoffTime)
        } else if (count) {
          // Count-based fetch
          messages = await fetchConversationContext(ctx.discordMessage, count)
        } else {
          // Default: last 30 minutes
          const hourMessages = await fetchMessagesFromLastHour(
            ctx.discordMessage,
            {
              excludeBots: true,
              maxMessages: 200
            }
          )
          const cutoffTime = new Date(Date.now() - 30 * 60 * 1000)
          messages = hourMessages.filter((msg) => msg.timestamp >= cutoffTime)
        }

        const truncated = truncateMessagesForContext(messages)
        const formatted = formatMessagesForGrok(truncated)

        console.log(
          '[tools:fetchMessages] returning',
          truncated.length,
          'messages'
        )

        return {
          messageCount: truncated.length,
          messages: formatted
        }
      }
    }),

    generateImage: tool({
      description:
        'Generate an image using AI. Use when the user explicitly asks to create, generate, draw, or make an image.',
      inputSchema: z.object({
        prompt: z
          .string()
          .describe('Detailed description of the image to generate'),
        useAttachmentsAsReference: z
          .boolean()
          .optional()
          .describe(
            'Whether to use any attached images as style/content reference'
          )
      }),
      execute: async ({
        prompt,
        useAttachmentsAsReference
      }: {
        prompt: string
        useAttachmentsAsReference?: boolean
      }): Promise<ImageToolResult> => {
        console.log('[tools:generateImage] called with:', {
          prompt,
          useAttachmentsAsReference
        })
        console.log('[tools:generateImage] attachments:', ctx.attachmentUrls)

        const imageUrls =
          useAttachmentsAsReference && ctx.attachmentUrls.length > 0
            ? ctx.attachmentUrls
            : []

        const result = await generateImageFromReplicate(
          prompt,
          imageUrls,
          ctx.userId,
          ctx.username
        )

        if (result.isErr()) {
          console.error('[tools:generateImage] outer error:', result.error)
          return {
            success: false,
            error: result.error.message
          }
        }

        const { nanoBanana } = result.value

        if (nanoBanana.isErr()) {
          console.error(
            '[tools:generateImage] nano-banana error:',
            nanoBanana.error
          )
          return {
            success: false,
            error: nanoBanana.error.message
          }
        }

        console.log(
          '[tools:generateImage] success, buffer size:',
          nanoBanana.value.length
        )

        return {
          success: true,
          imageBuffer: nanoBanana.value
        }
      }
    })
  }
}

export type Tools = ReturnType<typeof createTools>
