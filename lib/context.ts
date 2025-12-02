import { Collection, type Message } from 'discord.js'
import { formatDistanceToNow } from 'date-fns'

export interface FormattedMessage {
  author: string
  content: string
  timestamp: Date
}

/**
 * Fetches the last N messages from the conversation context.
 * Returns messages that are recent and part of the natural conversation flow.
 */
export async function fetchConversationContext(
  message: Message,
  limit = 10
): Promise<FormattedMessage[]> {
  try {
    // Fetch messages before the current message
    const messages = await message.channel.messages.fetch({
      limit: limit + 1, // +1 to include potential overlap
      before: message.id
    })

    // Convert to array and reverse to get chronological order (oldest first)
    const messageArray = Array.from(messages.values()).reverse().slice(-limit) // Take last N messages

    return formatMessages(messageArray)
  } catch (error) {
    console.error('Error fetching conversation context:', error)
    return []
  }
}

/**
 * Recursively fetches the full thread chain by following message references.
 * Returns all messages in the reply chain, from oldest to newest.
 */
export async function fetchThreadChain(
  message: Message
): Promise<FormattedMessage[]> {
  const threadMessages: Message[] = []
  let currentMessage: Message | null = message

  try {
    // Walk backwards through the thread chain
    while (currentMessage?.reference) {
      try {
        const referencedMessage = await currentMessage.fetchReference()
        threadMessages.unshift(referencedMessage) // Add to beginning (oldest first)
        currentMessage = referencedMessage
      } catch (error) {
        // Message might be deleted or inaccessible
        console.warn('Could not fetch referenced message:', error)
        break
      }
    }

    return formatMessages(threadMessages)
  } catch (error) {
    console.error('Error fetching thread chain:', error)
    return []
  }
}

/**
 * Formats Discord messages into a simple structure for Grok context.
 */
function formatMessages(messages: Message[]): FormattedMessage[] {
  return messages.map((msg) => ({
    author: msg.author.displayName || msg.author.username,
    content: msg.content || '[No text content]',
    timestamp: msg.createdAt
  }))
}

/**
 * Converts formatted messages into a string suitable for Grok's prompt context.
 */
export function formatMessagesForGrok(messages: FormattedMessage[]): string {
  if (messages.length === 0) {
    return ''
  }

  return messages
    .map((msg) => {
      const timeAgo = formatDistanceToNow(msg.timestamp, { addSuffix: true })
      return `[${timeAgo}] ${msg.author}: ${msg.content}`
    })
    .join('\n')
}

export interface FetchMessagesOptions {
  excludeBots?: boolean
  maxMessages?: number
}

/**
 * Fetches all messages from the last hour in the channel.
 * Paginates through Discord API (100 messages per fetch) until hitting the 1-hour boundary.
 */
export async function fetchMessagesFromLastHour(
  message: Message,
  options: FetchMessagesOptions = {}
): Promise<FormattedMessage[]> {
  const { excludeBots = true, maxMessages = 500 } = options
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const allMessages: Message[] = []
  let lastMessageId: string | undefined = message.id

  try {
    while (allMessages.length < maxMessages) {
      const fetchOptions: { limit: number; before?: string } = { limit: 100 }
      if (lastMessageId) {
        fetchOptions.before = lastMessageId
      }

      const batch = await message.channel.messages.fetch(fetchOptions)
      if (batch.size === 0) break

      let hitTimeLimit = false
      for (const msg of batch.values()) {
        if (msg.createdAt < oneHourAgo) {
          hitTimeLimit = true
          break
        }
        if (excludeBots && msg.author.bot) continue
        allMessages.push(msg)
      }

      if (hitTimeLimit) break

      const oldestInBatch = batch.last()
      if (!oldestInBatch || oldestInBatch.createdAt < oneHourAgo) break
      lastMessageId = oldestInBatch.id
    }

    // Reverse to chronological order (oldest first)
    return formatMessages(allMessages.reverse())
  } catch (error) {
    console.error('Error fetching messages from last hour:', error)
    return []
  }
}

/**
 * Truncates messages to fit within a character limit for Grok context.
 * Prioritizes recent messages (most relevant to current conversation).
 */
export function truncateMessagesForContext(
  messages: FormattedMessage[],
  maxCharacters: number = 15000
): FormattedMessage[] {
  let totalLength = 0
  const truncated: FormattedMessage[] = []

  // Iterate from newest to oldest (prioritize recent)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const msgLength = msg.author.length + msg.content.length + 50
    if (totalLength + msgLength > maxCharacters) break
    truncated.unshift(msg)
    totalLength += msgLength
  }

  return truncated
}
