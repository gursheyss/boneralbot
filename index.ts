import { Client, Events, GatewayIntentBits } from 'discord.js'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

interface ParkingData {
  name: string
  fullness: string
}

async function scrapeParkingData(): Promise<ParkingData[]> {
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

    return parkingData
  } catch (error) {
    console.error('Error scraping parking data:', error)
    throw error
  }
}

function formatParkingResponse(data: ParkingData[]): string {
  return data.map((garage) => `${garage.name} ${garage.fullness}`).join('\n')
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
  }
})

client.login(process.env.DISCORD_TOKEN)
