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

export async function fetchUserMessages(
  client: Client,
  userId: string,
  limit = 100,
): Promise<FormattedMessage[]> {
  try {
    const channelId = GENERAL_CHANNEL_ID
    const channel = await client.channels.fetch(channelId)
    
    // Type guard: ensure channel exists and has messages
    if (!channel || !channel.isTextBased()) {
      console.warn('General chat channel not found or not text-based')
      return []
    }

    console.log(`[context] Starting fetch for user ${userId} in ${channelId}...`)

    const collectedBlocks: FormattedMessage[] = []
    let lastId: string | undefined

    const MAX_SCAN = 5000
    let scanned = 0

    let currentBurst: Message[] = []

    while (collectedBlocks.length < limit && scanned < MAX_SCAN) {
      // 1. Explicitly type options to ensure we get a Collection
      const options: { limit: number; before?: string } = { limit: 100 }
      if (lastId) options.before = lastId

      // 2. Cast the result to Collection<string, Message> to fix "Property size does not exist"
      const messages = (await channel.messages.fetch(options)) as Collection<string, Message>
      
      if (messages.size === 0) break

      const msgs = Array.from(messages.values())

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        
        if (!msg) continue
        if (msg.author.bot || !msg.content.trim()) continue
        
        // Filter out bot mentions (using client if available)
        if (client.user && msg.mentions.has(client.user.id)) continue

        if (msg.author.id === userId) {
            // Burst Logic: Group messages if they are close in time
            const lastMsgInBurst = currentBurst[currentBurst.length - 1]
            
            // Note: msgs are usually ordered newest->oldest. 
            // We iterate 0..N (Newest..Oldest).
            // So 'lastMsgInBurst' is actually NEWER than 'msg'.
            
            if (lastMsgInBurst && (lastMsgInBurst.createdTimestamp - msg.createdTimestamp) < 2 * 60 * 1000) {
                // Add to current burst
                currentBurst.push(msg)
            } else {
                // Gap is too big (or this is the first message found)
                // Push the PREVIOUS completed burst to results
                if (currentBurst.length > 0) {
                    await pushBurst(currentBurst, msgs, collectedBlocks)
                }
                // Start a new burst
                currentBurst = [msg]
            }
        }
      }

      lastId = messages.last()?.id
      scanned += messages.size
    }

    // Push any remaining burst
    if (currentBurst.length > 0) {
         await pushBurst(currentBurst, [], collectedBlocks)
    }

    return collectedBlocks.reverse()
  } catch (error) {
    console.error('Error fetching user messages:', error)
    return []
  }
}

// [NEW] Helper to clean garbage from Discord messages
function cleanDiscordText(content: string): string {
  return content
    .replace(/<@!?(\d+)>/g, '@User') 
    .replace(/<@&(\d+)>/g, '@Role')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/https?:\/\/(tenor|cdn\.discordapp|media\.discordapp)[^\s]+/g, '[Image/Gif]')
    .trim();
}

// [NEW] Helper to format and push a burst of messages
async function pushBurst(
    burst: Message[], 
    allMessages: Message[], 
    results: FormattedMessage[]
) {
    if (burst.length === 0) return;

    // Reorder burst: Oldest -> Newest (Chronological)
    burst.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    
    // Fix: Ensure oldestMsg exists (TypeScript check)
    const oldestMsg = burst[0];
    if (!oldestMsg) return;

    // Combine content
    const fullContent = burst.map(m => cleanDiscordText(m.content)).filter(c => c.length > 0).join('\n');
    if (!fullContent) return;

    // Try to find context (What triggered the start of this burst?)
    let context = '';
    
    if (oldestMsg.reference?.messageId) {
        try {
            // Try to find in current batch
            let refMsg = allMessages.find(m => m.id === oldestMsg.reference!.messageId);
            // If not found (and we really want it), we could fetch it, but skipping for speed
            
            if (refMsg) {
                const name = refMsg.member?.displayName || refMsg.author.username;
                context = `[${name}]: ${cleanDiscordText(refMsg.content)}`;
            }
        } catch {}
    }

    const formatted = context 
        ? `${context}\n[Replying to above] ${fullContent}`
        : fullContent;

    results.push({
        author: oldestMsg.member?.displayName || oldestMsg.author.username,
        content: formatted,
        timestamp: oldestMsg.createdAt
    });
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
  if (messages.length === 0) return ''

  return messages
    .map((msg) => {
      // Logic to handle our new "Burst" format
      // If the content has "[Replying to...]" split it up
      if (msg.content.includes('\n[Replying to above] ')) {
         const parts = msg.content.split('\n[Replying to above] ')
         const context = parts[0] // "[User]: Hello"
         const reply = parts[1]   // "burst message\nline 2"
         
         // Format:
         // CONTEXT: [User]: Hello
         // TARGET: burst message
         // line 2
         return `CONTEXT: ${context}\n ${msg.author}: ${reply}`
      }

      // No context
      return ` ${msg.author}: ${msg.content}`
    })
    .join('\n\n') // Double spacing between interaction blocks
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
