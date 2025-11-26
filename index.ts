process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import {
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js'
import { startTyping } from './lib/typing.ts'
import { generateImage } from './lib/image.ts'
import { swapFaceOntoTarget, swapFaceInVideo } from './lib/faceswap.ts'
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

const generationContext = new Map<
  string,
  { prompt: string; imageUrls: string[]; userId: string; username?: string }
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

client.once(Events.ClientReady, (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`)
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return

  // Handle "@bot image <prompt>" command - generate image from text prompt only
  if (client.user && message.mentions.has(client.user)) {
    const botId = client.user.id
    const cleaned = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .trim()

    if (cleaned.toLowerCase().startsWith('image ')) {
      const prompt = cleaned.slice(6).trim()

      if (!prompt) {
        await message.reply('please include a prompt after "image"')
        return
      }

      const stopTyping = startTyping(message.channel)
      try {
        const result = await generateImage(
          prompt,
          [],
          message.author.id,
          message.author.username
        )
        stopTyping()

        if (result.isOk()) {
          if (result.value.nanoBanana.isOk()) {
            const sent = await message.reply({
              files: [
                new AttachmentBuilder(result.value.nanoBanana.value, {
                  name: 'generated.jpg'
                })
              ],
              components: [buildRetryRow()]
            })
            generationContext.set(sent.id, {
              prompt,
              imageUrls: [],
              userId: message.author.id,
              username: message.author.username
            })
          } else {
            console.error(
              'Generation failed:',
              result.value.nanoBanana.error
            )
            await message.reply(
              `failed to generate: ${result.value.nanoBanana.error.message}`
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
        stopTyping()
      }
      return
    }
  }

  if (message.content.toLowerCase().includes('faceswap')) {
    const imageAttachments = message.attachments.filter((attachment) =>
      attachment.contentType?.startsWith('image/')
    )

    if (imageAttachments.size < 2) {
      await message.reply('please attach two images to use faceswap.')
      return
    }

    const [firstImage, secondImage] = Array.from(imageAttachments.values())
    if (!firstImage || !secondImage) {
      await message.reply('could not read both images, please try again.')
      return
    }

    const stopTyping = startTyping(message.channel)
    try {
      const result = await swapFaceOntoTarget(firstImage.url, secondImage.url)
      // Stop typing before sending the reply
      stopTyping()

      if (result.isOk()) {
        await message.reply({
          files: [
            new AttachmentBuilder(result.value, {
              name: 'swap.jpg'
            })
          ]
        })
      } else {
        console.error('face swap failed:', result.error)
        await message.reply(`failed to swap faces: ${result.error.message}`)
      }
    } catch (e) {
      console.error('faceswap error:', e)
      await message.reply('an error occurred while swapping faces.')
    } finally {
      // Ensure typing always stops even if an error occurs above
      stopTyping()
    }
    return
  }

  if (
    client.user &&
    message.mentions.has(client.user) &&
    message.attachments.size > 0
  ) {
    const imageAttachments = message.attachments.filter((attachment) =>
      attachment.contentType?.startsWith('image/')
    )
    const videoAttachments = message.attachments.filter((attachment) =>
      attachment.contentType?.startsWith('video/')
    )

    if (imageAttachments.size > 0 && videoAttachments.size > 0) {
      const swapImage = imageAttachments.first()
      const targetVideo = videoAttachments.first()

      if (!swapImage || !targetVideo) {
        await message.reply(
          'could not read the provided media, please try again.'
        )
        return
      }

      const stopTyping = startTyping(message.channel)
      try {
        const result = await swapFaceInVideo(swapImage.url, targetVideo.url)
        stopTyping()

        if (result.isOk()) {
          await message.reply({
            files: [
              new AttachmentBuilder(result.value, {
                name: 'faceswap-video.mp4'
              })
            ]
          })
        } else {
          console.error('video face swap failed:', result.error)
          await message.reply(
            `failed to swap video faces: ${result.error.message}`
          )
        }
      } catch (e) {
        console.error('video faceswap error:', e)
        await message.reply(
          'an error occurred while swapping faces in the video.'
        )
      } finally {
        stopTyping()
      }
      return
    }
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
            const result = await generateImage(
              prompt,
              imageUrls,
              message.author.id,
              message.author.username
            )
            // Stop typing before sending the reply
            stopTyping()

            if (result.isOk()) {
              if (result.value.nanoBanana.isOk()) {
                const sent = await message.reply({
                  files: [
                    new AttachmentBuilder(result.value.nanoBanana.value, {
                      name: 'generated.jpg'
                    })
                  ],
                  components: [buildRetryRow()]
                })
                generationContext.set(sent.id, {
                  prompt,
                  imageUrls,
                  userId: message.author.id,
                  username: message.author.username
                })
              } else {
                console.error(
                  'Generation failed:',
                  result.value.nanoBanana.error
                )
                await message.reply(
                  `failed to generate: ${result.value.nanoBanana.error.message}`
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
      const result = await generateImage(
        prompt,
        imageUrls,
        message.author.id,
        message.author.username
      )
      // Stop typing before sending the reply
      stopTyping()

      if (result.isOk()) {
        if (result.value.nanoBanana.isOk()) {
          const sent = await message.reply({
            files: [
              new AttachmentBuilder(result.value.nanoBanana.value, {
                name: 'generated.jpg'
              })
            ],
            components: [buildRetryRow()]
          })
          generationContext.set(sent.id, {
            prompt,
            imageUrls,
            userId: message.author.id,
            username: message.author.username
          })
        } else {
          console.error(
            'Generation failed:',
            result.value.nanoBanana.error
          )
          await message.reply(
            `failed to generate: ${result.value.nanoBanana.error.message}`
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
          'please include a message or question when you mention me'
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
          let response = result.value.text
          const reasoning = result.value.reasoning

          // Build message with reasoning as subtext if available
          let fullMessage = response
          if (reasoning) {
            // Use -# for subtext (small text) in Discord
            const subtextReasoning = reasoning
              .split('\n')
              .map((line) => `-# ${line}`)
              .join('\n')
            fullMessage = `${response}\n\n${subtextReasoning}`
          }

          // Discord message limit is 2000 characters
          if (fullMessage.length > 2000) {
            fullMessage = fullMessage.substring(0, 1997) + '...'
          }

          const sent = await message.reply({
            content: fullMessage,
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
            `failed to generate response: ${result.error.message}`
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
      const result = await generateImage(
        ctx.prompt,
        ctx.imageUrls,
        ctx.userId,
        ctx.username
      )
      if (result.isOk()) {
        if (result.value.nanoBanana.isOk()) {
          const sent = await channel.send({
            files: [
              new AttachmentBuilder(result.value.nanoBanana.value, {
                name: 'generated.jpg'
              })
            ],
            components: [buildRetryRow()]
          })
          generationContext.set(sent.id, ctx)
          await interaction.editReply('Retry complete')
        } else {
          console.error(
            'Generation failed:',
            result.value.nanoBanana.error
          )
          await interaction.editReply(
            `retry failed: ${result.value.nanoBanana.error.message}`
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

      const result = await generateGrokResponse({
        prompt: ctx.prompt,
        contextMessages: ctx.contextMessages
      })

      if (result.isOk()) {
        const response = result.value.text
        const reasoning = result.value.reasoning

        // Build message with reasoning as subtext if available
        let fullMessage = response
        if (reasoning) {
          // Use -# for subtext (small text) in Discord
          const subtextReasoning = reasoning
            .split('\n')
            .map((line) => `-# ${line}`)
            .join('\n')
          fullMessage = `${response}\n\n${subtextReasoning}`
        }

        // Discord message limit is 2000 characters
        if (fullMessage.length > 2000) {
          fullMessage = fullMessage.substring(0, 1997) + '...'
        }

        const sent = await channel.send({
          content: fullMessage,
          components: [buildGrokRetryRow()]
        })

        // Store context for future retries
        grokGenerationContext.set(sent.id, ctx)

        await interaction.editReply('Retry complete')
      } else {
        console.error('Grok retry failed:', result.error)
        await interaction.editReply(
          `failed to generate response: ${result.error.message}`
        )
      }
    } catch (e) {
      console.error('Grok retry error:', e)
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
    return
  }
})

client.login(process.env.DISCORD_TOKEN)
