import { TextChannel } from 'discord.js'
import { Result, ok, err } from 'neverthrow'

interface MessageSummary {
  content: string
  author: string
  timestamp: Date
  attachments: string[]
  isBot: boolean
}

const summaryCache = new Map<string, { summary: string; expiry: number }>()
const CACHE_DURATION = 30 * 1000 // 30 seconds

function getCacheKey(channelId: string, query?: string): string {
  return query ? `${channelId}:${query.toLowerCase()}` : channelId
}

function getCachedSummary(channelId: string, query?: string): string | null {
  const key = getCacheKey(channelId, query)
  const cached = summaryCache.get(key)
  if (cached && Date.now() < cached.expiry) {
    return cached.summary
  }
  summaryCache.delete(key)
  return null
}

function setCachedSummary(channelId: string, summary: string, query?: string): void {
  const key = getCacheKey(channelId, query)
  summaryCache.set(key, {
    summary,
    expiry: Date.now() + CACHE_DURATION
  })
}

async function fetchRecentMessages(channel: TextChannel, limit = 50): Promise<MessageSummary[]> {
  const messages = await channel.messages.fetch({ limit })
  return messages
    .filter(m => !m.author.bot)
    .map(m => ({
      content: m.content,
      author: m.author.displayName || m.author.username,
      timestamp: m.createdAt,
      attachments: m.attachments.map(a => a.name || 'file').join(', '),
      isBot: m.author.bot
    }))
    .reverse()
}

async function summarizeMessages(messages: MessageSummary[], query?: string): Promise<Result<string, string>> {
  if (!process.env.OPENAI_API_KEY) {
    return err('OpenAI API key not configured')
  }

  const context = messages
    .filter(m => m.content.trim().length > 0)
    .map(m => `${m.author}: ${m.content}${m.attachments ? ` [attached: ${m.attachments}]` : ''}`)
    .join('\n')

  if (!context.trim()) {
    return ok('Nothing much happening here tbh, just the usual dead chat vibes.')
  }

  let systemPrompt = `You are a slightly annoyed Discord moderator who's seen it all. Write a casual TLDR summary using this tone. Include usernames naturally in the summary. Use casual language with slight sarcasm like "yapping", "lol", "tbh", "ngl", etc. 

Format like: "Mizan has been yapping about how good he is at Valorant lol. chad_gamer was complaining about lag again. Someone mentioned they're gonna try that new restaurant everyone's talking about."

Keep it 3-5 sentences with more detail. Make it clear and readable. No extra formatting, headers, or signatures - just the summary sentences.`

  let userPrompt = `Summarize this Discord chat:\n\n${context}`

  if (query) {
    systemPrompt += `\n\nThe user asked specifically about: "${query}". Focus your summary on messages related to this query, but still maintain the casual Discord mod tone.`
    userPrompt = `The user wants to know about "${query}" from this chat:\n\n${context}`
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        max_tokens: 300,
        temperature: 0.4
      })
    })

    if (!response.ok) {
      return err(`OpenAI API error: ${response.statusText}`)
    }

    const data = await response.json()
    const summary = data.choices[0]?.message?.content?.trim()

    if (!summary) {
      return err('No summary generated')
    }

    return ok(summary)
  } catch (error) {
    return err(`Failed to generate summary: ${error}`)
  }
}

export async function generateTLDR(channel: TextChannel, query?: string): Promise<Result<string, string>> {
  try {
    // Check cache first
    const cached = getCachedSummary(channel.id, query)
    if (cached) {
      return ok(cached)
    }

    // Fetch and summarize messages
    const messages = await fetchRecentMessages(channel)
    
    if (messages.length === 0) {
      const defaultMsg = 'Dead chat energy, nobody said anything worth summarizing lol.'
      setCachedSummary(channel.id, defaultMsg, query)
      return ok(defaultMsg)
    }

    const result = await summarizeMessages(messages, query)
    
    if (result.isOk()) {
      setCachedSummary(channel.id, result.value, query)
    }
    
    return result
  } catch (error) {
    return err(`Failed to generate TLDR: ${error}`)
  }
}