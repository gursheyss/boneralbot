process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import {
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
  DiscordAPIError
} from 'discord.js'
import { startTyping } from './lib/typing.ts'
import { fetchParkingData, createTextChart } from './lib/parking.ts'
import { generateImage } from './lib/image.ts'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

const PARKING_CHANNEL_ID = process.env.PARKING_CHANNEL_ID!
const PARKING_DELAY = 60 * 1000 // 1 minute

const generationContext = new Map<
  string,
  { prompt: string; imageUrls: string[] }
>()

function buildRetryRow() {
  const retry = new ButtonBuilder()
    .setCustomId('retry_gen')
    .setLabel('Retry')
    .setStyle(ButtonStyle.Primary)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(retry)
  return row
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`)

  // Auto-update parking ASCII chart: send initial message then edit that same message on a schedule
  const channelId = PARKING_CHANNEL_ID
  const channel = (await client.channels.fetch(channelId)) as TextChannel
  if (!channel) {
    console.error(`Channel ${channelId} not found`)
    return
  }

  let statusMessageId: string | null = null

  // send or recover initial chart
  try {
    const initResult = await fetchParkingData()
    if (!initResult.isOk()) throw initResult.error
    const initChart = createTextChart(
      initResult.value.data,
      initResult.value.websiteTimestamp
    )
    const initTs = Math.floor(Date.now() / 1000)
    const initContent = `\`\`\`\n${initChart}\n\`\`\`\nBot last updated: <t:${initTs}:F>`

    // Try to find an existing parking status message to reuse
    const headerMarker = 'SJSU Parking Garage Status'
    const botId = client.user?.id
    if (botId) {
      try {
        const recentMessages = await channel.messages.fetch({ limit: 100 })
        const candidates = recentMessages.filter(
          (m) => m.author.id === botId && m.content.includes(headerMarker)
        )
        const existing = candidates
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .first()

        if (existing) {
          try {
            await existing.edit(initContent)
            statusMessageId = existing.id
          } catch (err: any) {
            if (err instanceof DiscordAPIError && err.code === 10008) {
              // Message no longer exists, will send a new one below
            } else {
              console.error('Error editing existing parking chart', err)
            }
          }
        }
      } catch (e) {
        console.warn('Failed to search for existing parking chart message', e)
      }
    }

    // If we couldn't reuse, send a new message
    if (!statusMessageId) {
      const sentMessage = await channel.send(initContent)
      statusMessageId = sentMessage.id
    }

    // schedule periodic edits
    setInterval(async () => {
      if (!statusMessageId) return

      try {
        const res = await fetchParkingData()
        if (res.isOk()) {
          const chart = createTextChart(
            res.value.data,
            res.value.websiteTimestamp
          )
          const ts = Math.floor(Date.now() / 1000)
          const content = `\`\`\`\n${chart}\n\`\`\`\nBot last updated: <t:${ts}:F>`

          // fetch fresh message instance and edit
          const message = await channel.messages.fetch(statusMessageId)
          await message.edit(content)
        } else {
          console.error('failed to get parking stats', res.error)
        }
      } catch (err: any) {
        if (err instanceof DiscordAPIError && err.code === 10008) {
          console.warn('Parking chart message deleted, sending new one...')
          try {
            const res = await fetchParkingData()
            if (res.isOk()) {
              const chart = createTextChart(
                res.value.data,
                res.value.websiteTimestamp
              )
              const ts = Math.floor(Date.now() / 1000)
              const content = `\`\`\`\n${chart}\n\`\`\`\nBot last updated: <t:${ts}:F>`
              const newMessage = await channel.send(content)
              statusMessageId = newMessage.id
            }
          } catch (e) {
            console.error('Failed to send replacement parking chart', e)
          }
        } else {
          console.error('Error editing parking chart', err)
        }
      }
    }, PARKING_DELAY)
  } catch (e) {
    console.error('Failed to send initial parking chart', e)
  }
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return

  if (message.content.toLowerCase().trim() === 'parking') {
    const stopTyping = startTyping(message.channel)
    try {
      const result = await fetchParkingData()
      // Stop typing as soon as the work is done for better UX
      stopTyping()

      if (result.isOk()) {
        const chart = createTextChart(
          result.value.data,
          result.value.websiteTimestamp
        )
        await message.reply('```\n' + chart + '\n```')
      } else {
        console.error('failed to get parking stats', result.error)
        await message.reply('failed to get parking stats')
      }
    } catch (e) {
      console.error('failed to get parking stats', e)
      await message.reply('failed to get parking stats')
    } finally {
      // Ensure typing always stops even if an error occurs above
      stopTyping()
    }
    return
  }

  if (message.reference) {
    try {
      const referencedMessage = await message.fetchReference()

      const referencedImageAttachments = referencedMessage.attachments.filter(
        (attachment) => attachment.contentType?.startsWith('image/')
      )

      if (referencedImageAttachments.size > 0) {
        let prompt: string | null = null

        if (
          referencedMessage.author.id === client.user?.id &&
          message.content.trim()
        ) {
          prompt = message.content.trim()
        } else if (client.user && message.mentions.has(client.user)) {
          const botId = client.user.id
          const cleaned = message.content
            .replace(new RegExp(`^<@!?${botId}>\\s*`), '')
            .replace(new RegExp(`\\s*<@!?${botId}>$`), '')
            .trim()
          if (cleaned) {
            prompt = cleaned
          }
        }

        if (prompt) {
          // Collect images from referenced message
          const referencedImageUrls = referencedImageAttachments.map(
            (attachment) => attachment.url
          )

          // Also collect any images from the current reply message
          const replyImageAttachments = message.attachments.filter(
            (attachment) => attachment.contentType?.startsWith('image/')
          )
          const replyImageUrls = replyImageAttachments.map(
            (attachment) => attachment.url
          )

          // Combine all image URLs
          const imageUrls = [...referencedImageUrls, ...replyImageUrls]

          const stopTyping = startTyping(message.channel)
          try {
            const result = await generateImage(prompt, imageUrls)
            // Stop typing before sending the reply
            stopTyping()

            if (result.isOk()) {
              const seedreamAttachment = new AttachmentBuilder(
                result.value.seedream,
                {
                  name: 'seedream-generated.jpg'
                }
              )
              const nanoBananaAttachment = new AttachmentBuilder(
                result.value.nanoBanana,
                {
                  name: 'nano-banana-generated.jpg'
                }
              )
              const sent = await message.reply({
                files: [seedreamAttachment, nanoBananaAttachment],
                components: [buildRetryRow()]
              })
              generationContext.set(sent.id, { prompt, imageUrls })
            } else {
              console.error('failed to generate image', result.error)
              await message.reply(`failed to generate: ${result.error}`)
            }
          } catch (e) {
            console.error('failed to generate image', e)
            await message.reply('failed to generate image')
          } finally {
            // Ensure typing always stops even if an error occurs above
            stopTyping()
          }
          return
        }
      }
    } catch {
      // ignore errors when fetching reference
    }
  }

  // biome-ignore lint/style/noNonNullAssertion: lameeee
  if (message.mentions.has(client.user!) && message.attachments.size > 0) {
    const imageAttachments = message.attachments.filter((attachment) =>
      attachment.contentType?.startsWith('image/')
    )

    if (imageAttachments.size === 0) {
      await message.reply('attach at least one image')
      return
    }

    const botId = client.user!.id
    const prompt = message.content
      .replace(new RegExp(`^<@!?${botId}>\\s*`), '')
      .replace(new RegExp(`\\s*<@!?${botId}>$`), '')
      .trim()

    if (!prompt) {
      await message.reply('include a prompt')
      return
    }

    const stopTyping = startTyping(message.channel)
    try {
      const imageUrls = imageAttachments.map((attachment) => attachment.url)
      const result = await generateImage(prompt, imageUrls)
      // Stop typing before sending the reply
      stopTyping()

      if (result.isOk()) {
        const seedreamAttachment = new AttachmentBuilder(
          result.value.seedream,
          {
            name: 'seedream-generated.jpg'
          }
        )
        const nanoBananaAttachment = new AttachmentBuilder(
          result.value.nanoBanana,
          {
            name: 'nano-banana-generated.jpg'
          }
        )
        const sent = await message.reply({
          files: [seedreamAttachment, nanoBananaAttachment],
          components: [buildRetryRow()]
        })
        generationContext.set(sent.id, { prompt, imageUrls })
      } else {
        console.error('failed to generate image', result.error)
        await message.reply(`failed to generate: ${result.error}`)
      }
    } catch (e) {
      console.error('failed to generate image', e)
      await message.reply('failed to generate image')
    } finally {
      // Ensure typing always stops even if an error occurs above
      stopTyping()
    }
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return
  if (interaction.customId !== 'retry_gen') return

  const ctx = generationContext.get(interaction.message.id)
  if (!ctx) {
    await interaction.reply({
      content:
        'context expired. reply to the original image with your prompt to regenerate.',
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
    const result = await generateImage(ctx.prompt, ctx.imageUrls)
    if (result.isOk()) {
      const seedreamAttachment = new AttachmentBuilder(result.value.seedream, {
        name: 'seedream-generated.jpg'
      })
      const nanoBananaAttachment = new AttachmentBuilder(
        result.value.nanoBanana,
        {
          name: 'nano-banana-generated.jpg'
        }
      )
      const sent = await channel.send({
        files: [seedreamAttachment, nanoBananaAttachment],
        components: [buildRetryRow()]
      })
      generationContext.set(sent.id, ctx)
      await interaction.editReply('retry complete')
    } else {
      console.error('failed to generate image', result.error)
      await interaction.editReply(`failed to generate: ${result.error}`)
    }
  } catch (e) {
    console.error('failed to generate image', e)
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('failed to generate image')
      } else {
        await interaction.reply({
          content: 'failed to generate image',
          ephemeral: true
        })
      }
    } catch {}
  } finally {
    stopTyping()
  }
})

client.login(process.env.DISCORD_TOKEN)
