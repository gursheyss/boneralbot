import {
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder
} from 'discord.js'

import Replicate from 'replicate'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

const replicate = new Replicate()

let isGeneratingImage = false

interface ParkingData {
  name: string
  fullness: string
}

interface CachedData {
  data: ParkingData[]
  timestamp: number
}

let cache: CachedData | null = null
const CACHE_DURATION = 60 * 1000 // 1 min

async function scrapeParkingData(): Promise<ParkingData[]> {
  if (cache && Date.now() - cache.timestamp < CACHE_DURATION) {
    return cache.data
  }

  try {
    const response = await fetch('https://sjsuparkingstatus.sjsu.edu/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const html = await response.text()

    const garagePattern =
      /<h2 class="garage__name">([^<]+)<\/h2>[\s\S]*?<span class="garage__fullness">\s*(\d+)\s*%\s*<\/span>/g
    const parkingData: ParkingData[] = []

    let match: RegExpExecArray | null
    match = garagePattern.exec(html)
    while (match !== null) {
      const name = match[1]?.trim().replace(' Garage', '').trim()
      const fullness = match[2]?.trim()

      if (name && fullness) {
        parkingData.push({ name, fullness: `${fullness}%` })
      }
      match = garagePattern.exec(html)
    }

    cache = {
      data: parkingData,
      timestamp: Date.now()
    }

    return parkingData
  } catch (error) {
    console.error('Error scraping parking data:', error)
    throw error
  }
}

function formatParkingResponse(data: ParkingData[]): string {
  return data.map((garage) => `${garage.name} ${garage.fullness}`).join('\n')
}

async function generateImage(
  prompt: string,
  imageUrl: string
): Promise<Buffer> {
  const input = {
    prompt: prompt,
    input_image: imageUrl,
    output_format: 'jpg'
  }

  const output = await replicate.run('black-forest-labs/flux-kontext-pro', {
    input
  })

  // @ts-expect-error - yes it does
  const imageResponse = await fetch(output.url())
  return Buffer.from(await imageResponse.arrayBuffer())
}

client.once(Events.ClientReady, (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`)
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return

  if (message.content.toLowerCase().trim() === 'parking') {
    try {
      message.channel.sendTyping()
      const parkingData = await scrapeParkingData()
      const response = formatParkingResponse(parkingData)

      if (response) {
        await message.reply(response)
      } else {
        await message.reply('failed to get parking stats')
      }
    } catch (error) {
      console.error('failed to get parking stats', error)
      await message.reply('failed to get parking stats')
    }
    return
  }

  // biome-ignore lint/style/noNonNullAssertion: lameeee
  if (message.mentions.has(client.user!) && message.attachments.size > 0) {
    if (isGeneratingImage) {
      await message.reply('already generating')
      return
    }

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

    try {
      isGeneratingImage = true

      await message.channel.sendTyping()

      const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {
          clearInterval(typingInterval)
        })
      }, 8000)

      const imageBuffer = await generateImage(prompt, imageAttachment.url)

      clearInterval(typingInterval)

      const attachment = new AttachmentBuilder(imageBuffer, {
        name: 'generated-image.jpg'
      })
      await message.reply({
        files: [attachment]
      })
    } catch (error) {
      console.error('failed to generate image', error)
      await message.reply(`failed to generate: ${error}`)
    } finally {
      isGeneratingImage = false
    }
  }
})

client.login(process.env.DISCORD_TOKEN)
