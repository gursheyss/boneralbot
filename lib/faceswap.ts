import Replicate from 'replicate'
import { ResultAsync } from 'neverthrow'

const replicate = new Replicate()

const FACE_SWAP_MODEL_VERSION =
  'cdingram/face-swap:d1d6ea8c8be89d664a07a457526f7128109dee7030fdac424788d762c71ed111'
const VIDEO_FACE_SWAP_MODEL_VERSION =
  'arabyai-replicate/roop_face_swap:11b6bf0f4e14d808f655e87e5448233cceff10a45f659d71539cafb7163b2e84'

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

export function swapFaceOntoTarget(
  targetImageUrl: string,
  swapImageUrl: string
) {
  return ResultAsync.fromPromise(
    runFaceSwap(targetImageUrl, swapImageUrl),
    (error) =>
      error instanceof Error
        ? error
        : new Error('Unknown error running face swap')
  )
}

export function swapFaceInVideo(
  swapImageUrl: string,
  targetVideoUrl: string
) {
  return ResultAsync.fromPromise(
    (async () => {
      const input = {
        swap_image: swapImageUrl,
        target_video: targetVideoUrl
      } as const

      const output = await replicate.run(VIDEO_FACE_SWAP_MODEL_VERSION, {
        input
      })
      // @ts-expect-error Replicate outputs expose a url() helper
      const fileUrl = output.url() as string
      const response = await fetch(fileUrl)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch video face swap result: ${response.status}`
        )
      }
      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(arrayBuffer)
    })(),
    (error) =>
      error instanceof Error
        ? error
        : new Error('Unknown error running video face swap')
  )
}
