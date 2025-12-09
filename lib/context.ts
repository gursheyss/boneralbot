import { Client, Collection, type Message } from 'discord.js'
import { formatDistanceToNow } from 'date-fns'

const GENERAL_CHANNEL_ID = '1276716984192598112'

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
 * Fetches the last N messages from a specific user in the general channel.
 */
export async function fetchUserMessages(
  client: Client,
  userId: string,
  limit = 300
): Promise<FormattedMessage[]> {
  try {
    const channel = await client.channels.fetch(GENERAL_CHANNEL_ID)
    if (!channel || !channel.isTextBased()) {
      console.warn('General chat channel not found or not text-based')
      return []
    }

    const collectedMessages: FormattedMessage[] = []
    let lastId: string | undefined

    const MAX_SCAN = 5000
    let scanned = 0

    while (collectedMessages.length < limit && scanned < MAX_SCAN) {
      const options: any = { limit: 100 }
      if (lastId) options.before = lastId

      const messages = (await channel.messages.fetch(
        options
      )) as unknown as Collection<string, Message>
      if (messages.size === 0) break

      const msgs = Array.from(messages.values())

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        if (!msg) continue

        // Basic checks
        if (msg.author.id !== userId) continue
        if (msg.content.trim().length === 0) continue
        if (msg.author.bot) continue

        // Filter out bot mentions
        if (client.user && msg.mentions.has(client.user.id)) continue

        // Filter out messages that are only links
        const contentWithoutLinks = msg.content
          .replace(/https?:\/\/[^\s]+/g, '')
          .trim()
        if (contentWithoutLinks.length === 0) continue

        let context = ''

        // 1. Check direct Discord Reply
        if (msg.reference && msg.reference.messageId) {
          const refMsg = messages.get(msg.reference.messageId)
          if (refMsg) {
            context = `[${
              refMsg.author.displayName || refMsg.author.username
            }]: ${refMsg.content}`
          }
        }
        // 2. Fallback: Assume they are replying to the message immediately before them
        else {
          const prevMsg = msgs[i + 1]
          if (prevMsg && prevMsg.author.id !== userId && !prevMsg.author.bot) {
            context = `[${
              prevMsg.author.displayName || prevMsg.author.username
            }]: ${prevMsg.content}`
          }
        }

        const formattedContent = context
          ? `${context}\n[Response]: ${msg.content}`
          : msg.content

        collectedMessages.push({
          author: msg.author.displayName || msg.author.username,
          content: formattedContent,
          timestamp: msg.createdAt
        })

        if (collectedMessages.length >= limit) break
      }

      lastId = messages.last()?.id
      scanned += messages.size
    }

    return collectedMessages.reverse()
  } catch (error) {
    console.error('Error fetching user messages:', error)
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

      // Handle messages with context (from fetchUserMessages)
      if (msg.content.includes('\n[Response]: ')) {
        const parts = msg.content.split('\n[Response]: ')
        const context = parts[0] || ''
        const response = parts[1] || ''
        
        const match = context.match(/^\[(.*?)\]:/)
        const replyTo = match ? match[1] : 'someone'
        return `[${timeAgo}]\n${context}\n[Replying to ${replyTo}] ${msg.author}: ${response}`
      }

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
