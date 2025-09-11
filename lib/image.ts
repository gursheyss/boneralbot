import Replicate from 'replicate'
import { ResultAsync } from 'neverthrow'

const replicate = new Replicate()

export function generateImage(
  prompt: string,
  imageUrls: string[]
): ResultAsync<Buffer, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      const input = {
        prompt: prompt,
        image_input: imageUrls
      } as const

      const output = await replicate.run('bytedance/seedream-4', {
        input
      })

      // @ts-expect-error - yes it does
      const imageResponse = await fetch(output.url())
      const buffer = Buffer.from(await imageResponse.arrayBuffer())
      return buffer
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown error'))
  )
}
