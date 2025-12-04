import { ok, err, type Result } from 'neverthrow'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const REDDIT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

const COOMER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/css',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: 'https://coomer.st/'
}

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25mb 

export type MediaResult = 
  | { attachment: Buffer; name: string } 
  | { content: string }

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
    file: { path: string } | null
    attachments: { path: string }[]
    videos?: { path: string }[]
  }
}

// helpers

function randomItem<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined
}

function getFilename(url: string, headers: Headers, defaultName: string = 'media'): string {
  let name = url.split('/').pop()?.split('?')[0] || defaultName
  
  if (!name.includes('.')) {
    const contentType = headers.get('content-type') || ''
    if (contentType.includes('video')) {
      if (contentType.includes('mp4')) name += '.mp4'
      else if (contentType.includes('webm')) name += '.webm'
      else if (contentType.includes('quicktime')) name += '.mov'
      else name += '.mp4'
    } else if (contentType.includes('image')) {
      if (contentType.includes('png')) name += '.png'
      else if (contentType.includes('gif')) name += '.gif'
      else if (contentType.includes('webp')) name += '.webp'
      else name += '.jpg'
    } else {
      name += '.jpg'
    }
  }
  return name
}

async function downloadMedia(
  url: string, 
  headers: Record<string, string>, 
  filenameHint?: string
): Promise<Result<MediaResult, Error>> {
  try {
    const cleanUrl = url.replace(/&amp;/g, '&')

    let response = await fetch(cleanUrl, { headers })
    
    if (!response.ok) {
       response = await fetch(cleanUrl)
       if (!response.ok) {
         return err(new Error(`Failed to fetch ${cleanUrl}: ${response.status} ${response.statusText}`))
       }
    }

    const sizeHeader = response.headers.get('content-length')
    if (sizeHeader && parseInt(sizeHeader) > MAX_FILE_SIZE) {
      return ok({ content: cleanUrl })
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    if (buffer.length > MAX_FILE_SIZE) {
      return ok({ content: cleanUrl })
    }

    const name = getFilename(cleanUrl, response.headers, filenameHint)
    return ok({ attachment: buffer, name })

  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

// api funcs

export async function getRandomCat(): Promise<Result<string, Error>> {
  try {
    const response = await fetch('https://api.thecatapi.com/v1/images/search')
    if (!response.ok) return err(new Error(`Cat API error: ${response.statusText}`))
    
    const data = (await response.json()) as CatApiResponse[]
    return data[0]?.url ? ok(data[0].url) : err(new Error('No cat image found'))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function getRandomDog(): Promise<Result<string, Error>> {
  try {
    const response = await fetch('https://dog.ceo/api/breeds/image/random')
    if (!response.ok) return err(new Error(`Dog API error: ${response.statusText}`))
    
    const data = (await response.json()) as DogApiResponse
    return (data.status === 'success' && data.message) 
      ? ok(data.message) 
      : err(new Error('No dog image found'))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

async function attemptFetchNSFW(): Promise<Result<MediaResult, Error>> {
  try {
    const randomResponse = await fetch('https://coomer.st/api/v1/posts/random', { headers: COOMER_HEADERS })
    if (!randomResponse.ok) return err(new Error(`Coomer API error: ${randomResponse.statusText}`))

    const randomData = (await randomResponse.json()) as CoomerRandomResponse
    const service = randomData.service
    const user = randomData.user || randomData.artist_id
    const id = randomData.id || randomData.post_id

    if (!service || !user || !id) return err(new Error('Invalid response from random post API'))

    const postUrl = `https://coomer.st/api/v1/${service}/user/${user}/post/${id}`
    const postResponse = await fetch(postUrl, { headers: COOMER_HEADERS })
    if (!postResponse.ok) return err(new Error(`Coomer Post API error: ${postResponse.statusText}`))

    const postData = (await postResponse.json()) as CoomerPostResponse
    
    const allMedia: { path: string }[] = []
    if (postData.post.videos) allMedia.push(...postData.post.videos)
    if (postData.post.file) allMedia.push(postData.post.file)
    if (postData.post.attachments) allMedia.push(...postData.post.attachments)

    const validMedia = allMedia.filter(
      (m) => m && m.path && !m.path.toLowerCase().endsWith('.m4v')
    )

    if (validMedia.length === 0) return err(new Error('No supported media found in post'))

    const videoExtensions = ['.mp4', '.mov', '.webm']
    const videos = validMedia.filter((m) =>
      videoExtensions.some((ext) => m.path.toLowerCase().endsWith(ext))
    )

    const selectedPath = (videos.length > 0 ? randomItem(videos) : randomItem(validMedia))?.path

    if (!selectedPath) return err(new Error('Media selection failed'))

    const mediaUrl = `https://coomer.st${selectedPath}`
    return await downloadMedia(mediaUrl, COOMER_HEADERS)

  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function getRandomNSFW(): Promise<Result<MediaResult, Error>> {
  let lastError: Error = new Error('Failed to fetch NSFW content')

  for (let i = 0; i < 3; i++) {
    const result = await attemptFetchNSFW()
    if (result.isOk()) return result
    
    lastError = result.error
    console.log(`NSFW fetch attempt ${i + 1} failed: ${result.error.message}`)
    await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
  }

  return err(lastError)
}

export async function getRandomFromSubreddit(subreddit: string): Promise<Result<MediaResult, Error>> {
  try {
    const response = await fetch(`https://www.reddit.com/r/${subreddit}/top.json?t=month&limit=100`, {
      headers: { 'User-Agent': REDDIT_USER_AGENT }
    })

    if (!response.ok) return err(new Error(`Reddit API error: ${response.statusText}`))

    const data = (await response.json()) as any
    const children = data?.data?.children

    if (!children || children.length === 0) return err(new Error('No posts found'))

    const validPosts = children.filter((child: any) => {
        const p = child.data
        if (!p) return false
        
        const effectivePost = (p.crosspost_parent_list && p.crosspost_parent_list.length > 0) 
            ? p.crosspost_parent_list[0] 
            : p
            
        if (effectivePost.is_self && !effectivePost.media && !effectivePost.preview) return false
        if (!effectivePost.url && !effectivePost.media) return false
        
        return true
    })

    console.log(`[random] found ${validPosts.length} media posts in r/${subreddit}`)

    if (validPosts.length === 0) return err(new Error('No image/video posts found'))

    let post = randomItem(validPosts)?.data
    if (!post) return err(new Error('No post data found'))

    if (post.crosspost_parent_list && post.crosspost_parent_list.length > 0) {
      post = post.crosspost_parent_list[0]
    }

    let targetUrl = post.url_overridden_by_dest || post.url

    if (post.domain === 'reddit.com' && targetUrl.includes('/comments/')) {
        try {
             const fetchUrl = targetUrl.split('?')[0] + '.json'
             const linkedResponse = await fetch(fetchUrl, { 
                 headers: { 'User-Agent': REDDIT_USER_AGENT } 
             })
             
             if (linkedResponse.ok) {
                 const linkedData = (await linkedResponse.json()) as any[]
                 const linkedPost = linkedData[0]?.data?.children?.[0]?.data
                 
                 if (linkedPost) {
                     post = linkedPost
                     targetUrl = linkedPost.url_overridden_by_dest || linkedPost.url
                 }
             }
        } catch (e) {
            console.error(`Failed to resolve linked post ${targetUrl}:`, e)
        }
    }

    if (post.is_self && !post.media && !post.preview) {
       return ok({ content: post.url })
    }

    const isVideo = post.is_video || post.domain === 'v.redd.it' || targetUrl.includes('v.redd.it') || post.post_hint === 'hosted:video';

    if (isVideo) {
        let videoUrl = post.secure_media?.reddit_video?.fallback_url || post.media?.reddit_video?.fallback_url
        
        if (videoUrl) {
            return await downloadMedia(videoUrl, { 'User-Agent': REDDIT_USER_AGENT }, 'video.mp4')
        }
        return ok({ content: targetUrl })
    }

    if (targetUrl.includes('redgifs') || targetUrl.includes('gfycat') || targetUrl.endsWith('.gifv')) {
        return ok({ content: targetUrl })
    }

    if (post.is_gallery && post.media_metadata) {
      const mediaIds = Object.keys(post.media_metadata)
      const randomId = randomItem(mediaIds)
      
      if (randomId) {
          const media = post.media_metadata[randomId]
          const imageUrl = media?.s?.u // s=source, u=url
          
          if (imageUrl) {
              return await downloadMedia(imageUrl, { 'User-Agent': REDDIT_USER_AGENT }, `${randomId}.jpg`)
          }
      }
    }

    if (targetUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
         return await downloadMedia(targetUrl, { 'User-Agent': REDDIT_USER_AGENT })
    }

    if (post.preview?.images?.[0]?.source?.url) {
        return await downloadMedia(post.preview.images[0].source.url, { 'User-Agent': REDDIT_USER_AGENT })
    }

    return ok({ content: post.url })

  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}