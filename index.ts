process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
import { fetchParkingData, createTextChart } from './lib/parking.ts'
import { generateImage } from './lib/image.ts'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

const generationContext = new Map<string, { prompt: string; imageUrl: string }>()

function buildRetryRow() {
  const retry = new ButtonBuilder()
    .setCustomId('retry_gen')
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

  if (message.content.toLowerCase().trim() === 'parking') {
    const stopTyping = startTyping(message.channel)
    try {
      const result = await fetchParkingData()
      // Stop typing as soon as the work is done for better UX
      stopTyping()

      if (result.isOk()) {
        const chart = createTextChart(result.value)
        await message.reply("```\n" + chart + "\n```")
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

      const referencedImageAttachment = referencedMessage.attachments.find(
        (attachment) => attachment.contentType?.startsWith('image/')
      )

      if (referencedImageAttachment) {
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
          const imageUrl = referencedImageAttachment.url
          const stopTyping = startTyping(message.channel)
          try {
            const result = await generateImage(prompt, imageUrl)
            // Stop typing before sending the reply
            stopTyping()

            if (result.isOk()) {
              const attachment = new AttachmentBuilder(result.value, {
                name: 'generated-image.jpg'
              })
              const sent = await message.reply({
                files: [attachment],
                components: [buildRetryRow()]
              })
              generationContext.set(sent.id, { prompt, imageUrl })
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
    const imageAttachment = message.attachments.find((attachment) =>
      attachment.contentType?.startsWith('image/')
    )

    if (!imageAttachment) {
      await message.reply('attach an image')
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
      const imageUrl = imageAttachment.url
      const result = await generateImage(prompt, imageUrl)
      // Stop typing before sending the reply
      stopTyping()

      if (result.isOk()) {
        const attachment = new AttachmentBuilder(result.value, {
          name: 'generated-image.jpg'
        })
        const sent = await message.reply({
          files: [attachment],
          components: [buildRetryRow()]
        })
        generationContext.set(sent.id, { prompt, imageUrl })
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
      content: 'context expired. reply to the original image with your prompt to regenerate.',
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
    const result = await generateImage(ctx.prompt, ctx.imageUrl)
    if (result.isOk()) {
      const attachment = new AttachmentBuilder(result.value, {
        name: 'generated-image.jpg'
      })
      const sent = await channel.send({
        files: [attachment],
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
        await interaction.reply({ content: 'failed to generate image', ephemeral: true })
      }
    } catch { }
  } finally {
    stopTyping()
  }
})

client.login(process.env.DISCORD_TOKEN)
