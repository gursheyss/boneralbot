import { ok, err, type Result } from 'neverthrow'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const COOMER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/css',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: 'https://coomer.st/'
}

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25mb aka discord limit

interface CatApiResponse {
  url: string
}

interface DogApiResponse {
  message: string
  status: string
}

interface CoomerRandomResponse {
  service: string
  user: string
  id: string
  artist_id?: string
  post_id?: string
}

interface CoomerPostResponse {
  post: {
    file: {
      path: string
    } | null
    attachments: {
      path: string
    }[]
    videos?: {
      path: string
    }[]
  }
}

// helpers

function randomItem<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined
}

// functions

export async function getRandomCat(): Promise<Result<string, Error>> {
  try {
    const response = await fetch('https://api.thecatapi.com/v1/images/search')
    if (!response.ok) {
      return err(new Error(`Cat API error: ${response.statusText}`))
    }
    const data = (await response.json()) as CatApiResponse[]
    if (data.length > 0 && data[0]?.url) {
      return ok(data[0].url)
    }
    return err(new Error('No cat image found'))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function getRandomDog(): Promise<Result<string, Error>> {
  try {
    const response = await fetch('https://dog.ceo/api/breeds/image/random')
    if (!response.ok) {
      return err(new Error(`Dog API error: ${response.statusText}`))
    }
    const data = (await response.json()) as DogApiResponse
    if (data.status === 'success' && data.message) {
      return ok(data.message)
    }
    return err(new Error('No dog image found'))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

async function attemptFetchNSFW(): Promise<
  Result<{ attachment: Buffer; name: string } | { content: string }, Error>
> {
  try {
    // try to get random metadata
    const randomResponse = await fetch(
      'https://coomer.st/api/v1/posts/random',
      { headers: COOMER_HEADERS }
    )

    if (!randomResponse.ok) {
      return err(new Error(`Coomer API error: ${randomResponse.statusText}`))
    }

    const randomData = (await randomResponse.json()) as CoomerRandomResponse

    const service = randomData.service
    const user = randomData.user || randomData.artist_id
    const id = randomData.id || randomData.post_id

    if (!service || !user || !id) {
      return err(new Error('Invalid response from random post API'))
    }

    const postUrl = `https://coomer.st/api/v1/${service}/user/${user}/post/${id}`
    const postResponse = await fetch(postUrl, { headers: COOMER_HEADERS })

    if (!postResponse.ok) {
      return err(
        new Error(
          `Coomer Post API error: ${postResponse.statusText} for ${postUrl}`
        )
      )
    }

    const postData = (await postResponse.json()) as CoomerPostResponse
    const allMedia: { path: string }[] = []

    if (postData.post.videos) {
      allMedia.push(...postData.post.videos)
    }
    if (postData.post.file) {
      allMedia.push(postData.post.file)
    }
    if (postData.post.attachments) {
      allMedia.push(...postData.post.attachments)
    }

    // excluding m4v cuz discord hates them for some reason
    const validMedia = allMedia.filter(
      (m) => m && m.path && !m.path.toLowerCase().endsWith('.m4v')
    )

    let path = ''

    const videoExtensions = ['.mp4', '.mov', '.webm']
    const videos = validMedia.filter((m) =>
      videoExtensions.some((ext) => m.path.toLowerCase().endsWith(ext))
    )

    // randomize but prefer videos
    if (videos.length > 0) {
      path = randomItem(videos)?.path ?? ''
    } else if (validMedia.length > 0) {
      path = randomItem(validMedia)?.path ?? ''
    }

    if (!path) {
      return err(new Error('No supported media found in post'))
    }

    const mediaUrl = `https://coomer.st${path}`
    let mediaResponse = await fetch(mediaUrl, { headers: COOMER_HEADERS })
    if (!mediaResponse.ok) {
      mediaResponse = await fetch(mediaUrl)
    }

    if (!mediaResponse.ok) {
      return err(
        new Error(
          `Failed to fetch media (${mediaUrl}): ${mediaResponse.status} ${mediaResponse.statusText}`
        )
      )
    }

    const contentLength = mediaResponse.headers.get('content-length')
    if (contentLength && Number.parseInt(contentLength) > MAX_FILE_SIZE) {
      return ok({ content: mediaUrl })
    }

    const arrayBuffer = await mediaResponse.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    let name = path.split('/').pop() || 'media'

    // lol
    if (!name.includes('.')) {
      const contentType = mediaResponse.headers.get('content-type') || ''
      if (contentType.includes('video')) {
        if (contentType.includes('mp4')) name += '.mp4'
        else if (contentType.includes('webm')) name += '.webm'
        else if (contentType.includes('quicktime')) name += '.mov'
        else name += '.mp4'
      } else if (contentType.includes('image')) {
        if (contentType.includes('png')) name += '.png'
        else if (contentType.includes('gif')) name += '.gif'
        else name += '.jpg'
      } else {
        name += '.jpg'
      }
    }

    return ok({ attachment: buffer, name })
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function getRandomNSFW(): Promise<
  Result<{ attachment: Buffer; name: string } | { content: string }, Error>
> {
  let lastError: Error = new Error('Failed to fetch NSFW content')

  // retry 3 times
  for (let i = 0; i < 3; i++) {
    const result = await attemptFetchNSFW()
    if (result.isOk()) {
      return result
    }
    lastError = result.error
    console.log(`NSFW fetch attempt ${i + 1} failed: ${result.error.message}`)
    
    await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
  }

  return err(lastError)
}