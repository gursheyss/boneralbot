import {
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder
} from 'discord.js'
import { startTyping } from './lib/typing.ts'
import { fetchParkingData, formatParkingResponse } from './lib/parking.ts'
import { generateImage } from './lib/image.ts'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

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
        const response = formatParkingResponse(result.value)
        await message.reply(response || 'failed to get parking stats')
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

  if (message.reference && message.content.trim()) {
    try {
      const referencedMessage = await message.fetchReference()

      if (
        referencedMessage.author.id === client.user?.id &&
        referencedMessage.attachments.size > 0
      ) {
        const imageAttachment = referencedMessage.attachments.find(
          (attachment) => attachment.contentType?.startsWith('image/')
        )

        if (imageAttachment) {
          const prompt = message.content.trim()

          const stopTyping = startTyping(message.channel)
          try {
            const result = await generateImage(prompt, imageAttachment.url)
            // Stop typing before sending the reply
            stopTyping()

            if (result.isOk()) {
              const attachment = new AttachmentBuilder(result.value, {
                name: 'generated-image.jpg'
              })
              await message.reply({ files: [attachment] })
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

    const prompt = message.content.replace(/<@!?\d+>/g, '').trim()

    if (!prompt) {
      await message.reply('include a prompt')
      return
    }

    const stopTyping = startTyping(message.channel)
    try {
      const result = await generateImage(prompt, imageAttachment.url)
      // Stop typing before sending the reply
      stopTyping()

      if (result.isOk()) {
        const attachment = new AttachmentBuilder(result.value, {
          name: 'generated-image.jpg'
        })
        await message.reply({ files: [attachment] })
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

client.login(process.env.DISCORD_TOKEN)
