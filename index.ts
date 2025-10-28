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
import { generateGrokResponse } from './lib/grok.ts'
import {
  fetchConversationContext,
  fetchThreadChain,
  type FormattedMessage
} from './lib/context.ts'

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

const grokGenerationContext = new Map<
  string,
  {
    prompt: string
    contextMessages: FormattedMessage[]
    isThread: boolean
  }
>()

function buildRetryRow() {
  const retry = new ButtonBuilder()
    .setCustomId('retry_gen')
    .setLabel('Retry')
    .setStyle(ButtonStyle.Primary)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(retry)
  return row
}

function buildGrokRetryRow() {
  const retry = new ButtonBuilder()
    .setCustomId('retry_grok')
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
              const files: AttachmentBuilder[] = []
              const errors: string[] = []

              if (result.value.seedream.isOk()) {
                files.push(
                  new AttachmentBuilder(result.value.seedream.value, {
                    name: 'seedream-generated.jpg'
                  })
                )
              } else {
                console.error(
                  'Seedream generation failed:',
                  result.value.seedream.error
                )
                errors.push(`Seedream: ${result.value.seedream.error.message}`)
              }

              if (result.value.nanoBanana.isOk()) {
                files.push(
                  new AttachmentBuilder(result.value.nanoBanana.value, {
                    name: 'nano-banana-generated.jpg'
                  })
                )
              } else {
                console.error(
                  'Nano-Banana generation failed:',
                  result.value.nanoBanana.error
                )
                errors.push(
                  `Nano-Banana: ${result.value.nanoBanana.error.message}`
                )
              }

              if (files.length > 0) {
                // Send successful generations
                let content = ''
                if (errors.length > 0) {
                  content = `⚠️ Some generations failed:\n${errors.map((e) => `• ${e}`).join('\n')}`
                }

                const sent = await message.reply({
                  content: content || undefined,
                  files,
                  components: [buildRetryRow()]
                })
                generationContext.set(sent.id, { prompt, imageUrls })
              } else {
                // All generations failed
                await message.reply(
                  `❌ All generations failed:\n${errors.map((e) => `• ${e}`).join('\n')}`
                )
              }
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
        const files: AttachmentBuilder[] = []
        const errors: string[] = []

        if (result.value.seedream.isOk()) {
          files.push(
            new AttachmentBuilder(result.value.seedream.value, {
              name: 'seedream-generated.jpg'
            })
          )
        } else {
          console.error(
            'Seedream generation failed:',
            result.value.seedream.error
          )
          errors.push(`Seedream: ${result.value.seedream.error.message}`)
        }

        if (result.value.nanoBanana.isOk()) {
          files.push(
            new AttachmentBuilder(result.value.nanoBanana.value, {
              name: 'nano-banana-generated.jpg'
            })
          )
        } else {
          console.error(
            'Nano-Banana generation failed:',
            result.value.nanoBanana.error
          )
          errors.push(`Nano-Banana: ${result.value.nanoBanana.error.message}`)
        }

        if (files.length > 0) {
          // Send successful generations
          let content = ''
          if (errors.length > 0) {
            content = `⚠️ Some generations failed:\n${errors.map((e) => `• ${e}`).join('\n')}`
          }

          const sent = await message.reply({
            content: content || undefined,
            files,
            components: [buildRetryRow()]
          })
          generationContext.set(sent.id, { prompt, imageUrls })
        } else {
          // All generations failed
          await message.reply(
            `❌ All generations failed:\n${errors.map((e) => `• ${e}`).join('\n')}`
          )
        }
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

  // Handle @mentions without images - use Grok
  // biome-ignore lint/style/noNonNullAssertion: lameeee
  if (message.mentions.has(client.user!)) {
    const imageAttachments = message.attachments.filter((attachment) =>
      attachment.contentType?.startsWith('image/')
    )

    // Only proceed if there are NO images (image generation is handled above)
    if (imageAttachments.size === 0) {
      const botId = client.user!.id
      const prompt = message.content
        .replace(new RegExp(`^<@!?${botId}>\\s*`), '')
        .replace(new RegExp(`\\s*<@!?${botId}>$`), '')
        .trim()

      if (!prompt) {
        await message.reply(
          'Please include a message or question when you mention me!'
        )
        return
      }

      const stopTyping = startTyping(message.channel)
      try {
        let contextMessages: FormattedMessage[] = []
        let isThread = false

        // Only fetch context if this is a reply/thread
        if (message.reference) {
          isThread = true
          contextMessages = await fetchThreadChain(message)
        }

        const result = await generateGrokResponse({
          prompt,
          contextMessages
        })

        // Stop typing before sending the reply
        stopTyping()

        if (result.isOk()) {
          let response = result.value

          // Discord message limit is 2000 characters
          if (response.length > 2000) {
            response = response.substring(0, 1997) + '...'
          }

          const sent = await message.reply({
            content: response,
            components: [buildGrokRetryRow()]
          })

          // Store context for retry
          grokGenerationContext.set(sent.id, {
            prompt,
            contextMessages,
            isThread
          })
        } else {
          console.error('Grok generation failed:', result.error)
          await message.reply(
            `Failed to generate response: ${result.error.message}`
          )
        }
      } catch (e) {
        console.error('Grok generation error:', e)
        await message.reply('An error occurred while generating a response')
      } finally {
        // Ensure typing always stops even if an error occurs above
        stopTyping()
      }
      return
    }
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return

  // Handle image generation retry
  if (interaction.customId === 'retry_gen') {
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
        const files: AttachmentBuilder[] = []
        const errors: string[] = []

        if (result.value.seedream.isOk()) {
          files.push(
            new AttachmentBuilder(result.value.seedream.value, {
              name: 'seedream-generated.jpg'
            })
          )
        } else {
          console.error(
            'Seedream generation failed:',
            result.value.seedream.error
          )
          errors.push(`Seedream: ${result.value.seedream.error.message}`)
        }

        if (result.value.nanoBanana.isOk()) {
          files.push(
            new AttachmentBuilder(result.value.nanoBanana.value, {
              name: 'nano-banana-generated.jpg'
            })
          )
        } else {
          console.error(
            'Nano-Banana generation failed:',
            result.value.nanoBanana.error
          )
          errors.push(`Nano-Banana: ${result.value.nanoBanana.error.message}`)
        }

        if (files.length > 0) {
          // Send successful generations
          let content = ''
          if (errors.length > 0) {
            content = `⚠️ Some generations failed:\n${errors.map((e) => `• ${e}`).join('\n')}`
          }

          const sent = await channel.send({
            content: content || undefined,
            files,
            components: [buildRetryRow()]
          })
          generationContext.set(sent.id, ctx)

          if (errors.length > 0) {
            await interaction.editReply(
              'Retry complete with some errors - check the message above'
            )
          } else {
            await interaction.editReply('Retry complete')
          }
        } else {
          // All generations failed
          await interaction.editReply(
            `❌ Retry failed - all generations failed:\n${errors.map((e) => `• ${e}`).join('\n')}`
          )
        }
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
    return
  }

  // Handle Grok retry
  if (interaction.customId === 'retry_grok') {
    const ctx = grokGenerationContext.get(interaction.message.id)
    if (!ctx) {
      await interaction.reply({
        content: 'Context expired. Please mention me again with your question.',
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

      const result = await generateGrokResponse({
        prompt: ctx.prompt,
        contextMessages: ctx.contextMessages
      })

      if (result.isOk()) {
        let response = result.value

        // Discord message limit is 2000 characters
        if (response.length > 2000) {
          response = response.substring(0, 1997) + '...'
        }

        const sent = await channel.send({
          content: response,
          components: [buildGrokRetryRow()]
        })

        // Store context for future retries
        grokGenerationContext.set(sent.id, ctx)

        await interaction.editReply('Retry complete')
      } else {
        console.error('Grok retry failed:', result.error)
        await interaction.editReply(
          `Failed to generate response: ${result.error.message}`
        )
      }
    } catch (e) {
      console.error('Grok retry error:', e)
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('Failed to generate response')
        } else {
          await interaction.reply({
            content: 'Failed to generate response',
            ephemeral: true
          })
        }
      } catch {}
    } finally {
      stopTyping()
    }
    return
  }
})

client.login(process.env.DISCORD_TOKEN)
