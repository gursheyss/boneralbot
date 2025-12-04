process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import {
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message
} from 'discord.js'
import { startTyping } from './lib/typing.ts'
import { getRandomCat, getRandomDog, getRandomNSFW, getRandomFromSubreddit } from './lib/random.ts'
import { generateGrokResponse } from './lib/grok.ts'
import { fetchThreadChain, type FormattedMessage } from './lib/context.ts'
import { createTools, type ToolContext } from './lib/tools.ts'
import { generateImage } from './lib/image.ts'
import { type Result } from 'neverthrow'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

// Store context for retry functionality
interface GrokContext {
  prompt: string
  attachmentUrls: string[]
  contextMessages: FormattedMessage[]
  userId: string
  username: string
}

const grokContext = new Map<string, GrokContext>()

function buildRetryRow() {
  const retry = new ButtonBuilder()
    .setCustomId('retry_grok')
    .setLabel('Retry')
    .setStyle(ButtonStyle.Primary)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(retry)
  return row
}

async function handleRandomImageCommand(
  message: Message,
  fetcher: () => Promise<Result<string | { attachment: Buffer; name: string } | { content: string }, Error>>,
  name: string
) {
  let stopTyping = () => {}
  if ('sendTyping' in message.channel) {
    stopTyping = startTyping(message.channel as any)
  }

  try {
    const result = await fetcher()
    stopTyping()

    if (result.isOk()) {
      const value = result.value
      if (typeof value === 'object' && 'content' in value && typeof value.content === 'string') {
        await message.reply(value.content)
      } else {
        await message.reply({
          // @ts-ignore: Discord.js types might complain but this is valid for string | AttachmentPayload
          files: [value]
        })
      }
    } else {
      console.error(`${name} fetch failed:`, result.error)
      await message.reply(`failed to fetch ${name} image`)
    }
  } catch (e) {
    console.error(`${name} fetch error:`, e)
    await message.reply(`an error occurred while fetching ${name} image`)
  } finally {
    stopTyping()
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`)
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return
  if (!client.user) return

  // Only respond to @mentions
  if (!message.mentions.has(client.user)) return

  const botId = client.user.id
  const prompt = message.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim()

  // Handle "@bot rcat" command
  if (prompt.toLowerCase() === 'rcat') {
    await handleRandomImageCommand(message, getRandomCat, 'cat')
    return
  }

  // Handle "@bot rdog" command
  if (prompt.toLowerCase() === 'rdog') {
    await handleRandomImageCommand(message, getRandomDog, 'dog')
    return
  }

  // Handle "@bot rnsfw" command
  if (prompt.toLowerCase() === 'rnsfw') {
    await handleRandomImageCommand(message, getRandomNSFW, 'nsfw')
    return
  }

  // Handle "@bot r<subreddit>" command
  const subredditMatch = prompt.match(/^r([a-zA-Z0-9_]+)$/i)
  if (subredditMatch) {
    const subreddit = subredditMatch[1]
    if (!subreddit) return
    await handleRandomImageCommand(message, () => getRandomFromSubreddit(subreddit), subreddit)
    return
  }

  if (!prompt) {
    await message.reply('please include a message or question when you mention me')
    return
  }

  // Collect image attachments from current message
  // Check by contentType OR file extension for robustness
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
  const imageAttachments = message.attachments.filter((attachment) => {
    if (attachment.contentType?.startsWith('image/')) return true
    const url = attachment.url?.toLowerCase().split('?')[0]
    return url && imageExtensions.some(ext => url.endsWith(ext))
  })
  let attachmentUrls = imageAttachments.map((a) => a.url)

  // Also check referenced message for images
  if (message.reference) {
    try {
      const referencedMessage = await message.fetchReference()
      const refImageAttachments = referencedMessage.attachments.filter((attachment) => {
        if (attachment.contentType?.startsWith('image/')) return true
        const url = attachment.url?.toLowerCase().split('?')[0]
        return url && imageExtensions.some(ext => url.endsWith(ext))
      })
      const refImageUrls = refImageAttachments.map((a) => a.url)
      attachmentUrls = [...refImageUrls, ...attachmentUrls]
    } catch {
      // Ignore errors fetching reference
    }
  }

  // Fetch thread context if this is a reply
  let contextMessages: FormattedMessage[] = []
  if (message.reference) {
    contextMessages = await fetchThreadChain(message)
  }

  const stopTyping = startTyping(message.channel)

  console.log('[index] attachments detected:', attachmentUrls.length, attachmentUrls)

  // If there are image attachments, directly generate/edit with nano banana pro
  if (attachmentUrls.length > 0) {
    try {
      const result = await generateImage(
        prompt,
        attachmentUrls,
        message.author.id,
        message.author.username
      )

      stopTyping()

      if (result.isErr()) {
        console.error('Image generation failed:', result.error)
        await message.reply(`failed to generate image: ${result.error.message}`)
        return
      }

      const { nanoBanana } = result.value

      if (nanoBanana.isErr()) {
        console.error('Nano-banana failed:', nanoBanana.error)
        await message.reply(`failed to generate image: ${nanoBanana.error.message}`)
        return
      }

      const sent = await message.reply({
        files: [
          new AttachmentBuilder(nanoBanana.value, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      })

      // Store context for retry
      grokContext.set(sent.id, {
        prompt,
        attachmentUrls,
        contextMessages,
        userId: message.author.id,
        username: message.author.username
      })
      return
    } catch (e) {
      console.error('Image generation error:', e)
      await message.reply('An error occurred while generating the image')
      stopTyping()
      return
    }
  }

  try {
    // Create tools with Discord context
    const toolContext: ToolContext = {
      discordMessage: message,
      attachmentUrls,
      userId: message.author.id,
      username: message.author.username
    }
    const tools = createTools(toolContext)

    const result = await generateGrokResponse({
      prompt,
      contextMessages,
      attachmentUrls,
      tools
    })

    stopTyping()

    if (result.isErr()) {
      console.error('Grok generation failed:', result.error)
      await message.reply(`failed to generate response: ${result.error.message}`)
      return
    }

    const { text, reasoning, imageBuffer } = result.value

    // Send image if one was generated
    if (imageBuffer) {
      const sent = await message.reply({
        content: text || undefined,
        files: [
          new AttachmentBuilder(imageBuffer, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      })

      // Store context for retry
      grokContext.set(sent.id, {
        prompt,
        attachmentUrls,
        contextMessages,
        userId: message.author.id,
        username: message.author.username
      })
      return
    }

    // Text-only response
    let fullMessage = text
    if (reasoning) {
      const subtextReasoning = reasoning
        .split('\n')
        .map((line) => `-# ${line}`)
        .join('\n')
      fullMessage = `${text}\n\n${subtextReasoning}`
    }

    // Discord message limit is 2000 characters
    if (fullMessage.length > 2000) {
      fullMessage = fullMessage.substring(0, 1997) + '...'
    }

    const sent = await message.reply({
      content: fullMessage,
      components: [buildRetryRow()]
    })

    // Store context for retry
    grokContext.set(sent.id, {
      prompt,
      attachmentUrls,
      contextMessages,
      userId: message.author.id,
      username: message.author.username
    })
  } catch (e) {
    console.error('Grok generation error:', e)
    await message.reply('An error occurred while generating a response')
  } finally {
    stopTyping()
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return
  if (interaction.customId !== 'retry_grok') return

  const ctx = grokContext.get(interaction.message.id)
  if (!ctx) {
    await interaction.reply({
      content: 'context expired. please mention me again with your question.',
      ephemeral: true
    })
    return
  }

  if (!interaction.channel) {
    await interaction.reply({ content: 'cannot retry here', ephemeral: true })
    return
  }

  const channel = interaction.channel
  if (!('sendTyping' in channel) || !('send' in channel)) {
    await interaction.reply({ content: 'cannot retry here', ephemeral: true })
    return
  }

  const stopTyping = startTyping(channel)
  try {
    await interaction.deferReply({ ephemeral: true })

    // If there are image attachments, directly regenerate with nano banana pro
    if (ctx.attachmentUrls.length > 0) {
      const result = await generateImage(
        ctx.prompt,
        ctx.attachmentUrls,
        ctx.userId,
        ctx.username
      )

      if (result.isErr()) {
        console.error('Retry failed:', result.error)
        await interaction.editReply(`retry failed: ${result.error.message}`)
        return
      }

      const { nanoBanana } = result.value

      if (nanoBanana.isErr()) {
        console.error('Retry nano-banana failed:', nanoBanana.error)
        await interaction.editReply(`retry failed: ${nanoBanana.error.message}`)
        return
      }

      const sent = await channel.send({
        files: [
          new AttachmentBuilder(nanoBanana.value, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      })
      grokContext.set(sent.id, ctx)
      await interaction.editReply('Retry complete')
      return
    }

    // Create a minimal tool context for retry (no Discord message available)
    const toolContext: ToolContext = {
      // @ts-expect-error - we don't have the original message for retry
      discordMessage: null,
      attachmentUrls: ctx.attachmentUrls,
      userId: ctx.userId,
      username: ctx.username
    }
    const tools = createTools(toolContext)

    const result = await generateGrokResponse({
      prompt: ctx.prompt,
      contextMessages: ctx.contextMessages,
      attachmentUrls: ctx.attachmentUrls,
      tools
    })

    if (result.isErr()) {
      console.error('Retry failed:', result.error)
      await interaction.editReply(`retry failed: ${result.error.message}`)
      return
    }

    const { text, reasoning, imageBuffer } = result.value

    // Send image if one was generated
    if (imageBuffer) {
      const sent = await channel.send({
        content: text || undefined,
        files: [
          new AttachmentBuilder(imageBuffer, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      })
      grokContext.set(sent.id, ctx)
      await interaction.editReply('Retry complete')
      return
    }

    // Text-only response
    let fullMessage = text
    if (reasoning) {
      const subtextReasoning = reasoning
        .split('\n')
        .map((line) => `-# ${line}`)
        .join('\n')
      fullMessage = `${text}\n\n${subtextReasoning}`
    }

    if (fullMessage.length > 2000) {
      fullMessage = fullMessage.substring(0, 1997) + '...'
    }

    const sent = await channel.send({
      content: fullMessage,
      components: [buildRetryRow()]
    })

    grokContext.set(sent.id, ctx)
    await interaction.editReply('Retry complete')
  } catch (e) {
    console.error('Retry error:', e)
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('failed to generate response')
      } else {
        await interaction.reply({
          content: 'failed to generate response',
          ephemeral: true
        })
      }
    } catch {}
  } finally {
    stopTyping()
  }
})

client.login(process.env.DISCORD_TOKEN)
