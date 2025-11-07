import Replicate from 'replicate'
import { ResultAsync } from 'neverthrow'

const replicate = new Replicate()

const FACE_SWAP_MODEL_VERSION =
  'cdingram/face-swap:d1d6ea8c8be89d664a07a457526f7128109dee7030fdac424788d762c71ed111'

async function runFaceSwap(inputImage: string, swapImage: string) {
  const input = { input_image: inputImage, swap_image: swapImage } as const

  // Execute the Replicate job and fetch the generated image as a Buffer.
  const output = await replicate.run(FACE_SWAP_MODEL_VERSION, { input })
  // @ts-expect-error Replicate outputs expose a url() helper
  const fileUrl = output.url() as string
  const response = await fetch(fileUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch face swap result: ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export interface FaceSwapResult {
  firstToSecond: Buffer
  secondToFirst: Buffer
}

export function swapFacesBothWays(
  firstImageUrl: string,
  secondImageUrl: string
) {
  return ResultAsync.fromPromise(
    (async () => {
      const [firstToSecond, secondToFirst] = await Promise.all([
        runFaceSwap(firstImageUrl, secondImageUrl),
        runFaceSwap(secondImageUrl, firstImageUrl)
      ])

      return {
        firstToSecond,
        secondToFirst
      }
    })(),
    (error) =>
      error instanceof Error
        ? error
        : new Error('Unknown error running face swap')
  )
}
