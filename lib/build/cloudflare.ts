const SANDBOX_URL = process.env.CLOUDFLARE_SANDBOX_URL!
const SANDBOX_TOKEN = process.env.SANDBOX_AUTH_TOKEN!

export interface CloudflareSandbox {
  id: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

async function sandboxRequest<T>(
  sandboxId: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${SANDBOX_URL}/sandbox/${sandboxId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SANDBOX_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Sandbox API error: ${response.status} - ${error}`)
  }

  return response.json() as Promise<T>
}

export async function createSandbox(
  sessionId: string,
  userId: string
): Promise<CloudflareSandbox> {
  // The sandbox is created lazily on first operation
  // We just return an ID that will be used for all operations
  const sandboxId = `build-${sessionId}-${userId}`
  return { id: sandboxId }
}

export async function deleteSandbox(sandbox: CloudflareSandbox): Promise<void> {
  await fetch(`${SANDBOX_URL}/sandbox/${sandbox.id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${SANDBOX_TOKEN}`,
    },
  })
}

export async function executeCommand(
  sandbox: CloudflareSandbox,
  command: string,
  cwd?: string
): Promise<{ result: string; exitCode: number }> {
  const response = await sandboxRequest<ExecResult>(sandbox.id, '/exec', {
    method: 'POST',
    body: JSON.stringify({ command, cwd: cwd || '/workspace' }),
  })

  return {
    result: response.stdout + (response.stderr ? '\n' + response.stderr : ''),
    exitCode: response.exitCode,
  }
}

export async function executeCommandAsync(
  sandbox: CloudflareSandbox,
  _sessionName: string,
  command: string,
  onLog: (chunk: string) => void
): Promise<number> {
  const response = await fetch(
    `${SANDBOX_URL}/sandbox/${sandbox.id}/exec/stream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SANDBOX_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command, cwd: '/workspace/repo' }),
    }
  )

  if (!response.ok || !response.body) {
    throw new Error('Failed to start streaming execution')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let exitCode = 1
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6))
          if (data.type === 'stdout' || data.type === 'stderr') {
            onLog(data.data)
          } else if (data.type === 'exit') {
            exitCode = data.exitCode
          }
        } catch {
          // Ignore malformed SSE data
        }
      }
    }
  }

  return exitCode
}

// Helper for other modules to make sandbox requests
export { sandboxRequest }
