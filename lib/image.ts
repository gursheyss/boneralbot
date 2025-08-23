import Replicate from 'replicate'
import { ResultAsync } from 'neverthrow'

const replicate = new Replicate()

export function generateImage(
  prompt: string,
  imageUrl: string
): ResultAsync<Buffer, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      const input = {
        prompt: prompt,
        input_image: imageUrl,
        output_format: 'jpg',
        output_quality: 100,
        disable_safety_checker: true
      } as const

      const output = await replicate.run('black-forest-labs/flux-kontext-dev', {
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
