import { ok, err } from 'neverthrow'
import type { Result } from 'neverthrow'

export type ParkingData = {
  name: string
  fullness: string
}

interface CachedData {
  data: ParkingData[]
  timestamp: number
}

const CACHE_DURATION_MS = 60_000
let cache: CachedData | null = null

export async function fetchParkingData(): Promise<
  Result<ParkingData[], Error>
> {
  if (cache && Date.now() - cache.timestamp < CACHE_DURATION_MS) {
    return ok(cache.data)
  }

  try {
    const response = await fetch('https://sjsuparkingstatus.sjsu.edu/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    })

    if (!response.ok) {
      return err(new Error(`HTTP error! status: ${response.status}`))
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

    cache = { data: parkingData, timestamp: Date.now() }
    return ok(parkingData)
  } catch (e) {
    const error = e instanceof Error ? e : new Error('Unknown error')
    return err(error)
  }
}

export function formatParkingResponse(data: ParkingData[]): string {
  return data.map((garage) => `${garage.name} ${garage.fullness}`).join('\n')
}
