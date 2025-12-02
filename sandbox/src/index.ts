import { getSandbox, type Sandbox } from '@cloudflare/sandbox'

export { Sandbox } from '@cloudflare/sandbox'

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>
  SANDBOX_AUTH_TOKEN: string
  OPENCODE_API_KEY: string
}

function authenticate(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return false
  return authHeader.slice(7) === env.SANDBOX_AUTH_TOKEN
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers for preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type'
        }
      })
    }

    if (!authenticate(request, env)) {
      return new Response('Unauthorized', { status: 401 })
    }

    const url = new URL(request.url)
    const pathParts = url.pathname.split('/').filter(Boolean)

    // Route: /sandbox/:id/...
    if (pathParts[0] !== 'sandbox') {
      return new Response('Not found', { status: 404 })
    }

    const sandboxId = pathParts[1]
    if (!sandboxId) {
      return new Response('Sandbox ID required', { status: 400 })
    }

    const sandbox = getSandbox(env.Sandbox, sandboxId, {
      sleepAfter: 30 * 60 * 1000 // 30 minutes
    })

    const action = pathParts.slice(2).join('/')

    try {
      return await handleRequest(request, sandbox, action, env)
    } catch (error) {
      console.error('Sandbox error:', error)
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      )
    }
  }
}

async function handleRequest(
  request: Request,
  sandbox: ReturnType<typeof getSandbox>,
  action: string,
  env: Env
): Promise<Response> {
  const method = request.method

  // DELETE /sandbox/:id - Destroy sandbox
  if (!action && method === 'DELETE') {
    await sandbox.destroy()
    return Response.json({ success: true })
  }

  // POST /sandbox/:id/exec - Execute command (sync)
  if (action === 'exec' && method === 'POST') {
    const body = (await request.json()) as { command: string; cwd?: string }
    const result = await sandbox.exec(body.command, {
      cwd: body.cwd || '/workspace'
    })
    return Response.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.success
    })
  }

  // POST /sandbox/:id/exec/stream - Execute command with SSE streaming
  if (action === 'exec/stream' && method === 'POST') {
    const body = (await request.json()) as { command: string; cwd?: string }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // Start streaming execution in background
    ;(async () => {
      try {
        const result = await sandbox.exec(body.command, {
          cwd: body.cwd || '/workspace',
          stream: true,
          onOutput: (stream: 'stdout' | 'stderr', data: string) => {
            writer.write(
              encoder.encode(
                `data: ${JSON.stringify({ type: stream, data })}\n\n`
              )
            )
          }
        })
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'exit', exitCode: result.exitCode })}\n\n`
          )
        )
      } catch (err) {
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`
          )
        )
      } finally {
        await writer.close()
      }
    })()

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }

  // POST /sandbox/:id/session - Create session
  if (action === 'session' && method === 'POST') {
    const body = (await request.json()) as {
      sessionId: string
      env?: Record<string, string>
      cwd?: string
    }
    await sandbox.createSession({
      id: body.sessionId,
      env: { ...body.env, OPENCODE_API_KEY: env.OPENCODE_API_KEY },
      cwd: body.cwd || '/workspace'
    })
    return Response.json({ success: true, sessionId: body.sessionId })
  }

  // DELETE /sandbox/:id/session/:sessionId
  if (action.startsWith('session/') && method === 'DELETE') {
    const sessionId = action.split('/')[1]
    if (!sessionId) {
      return Response.json({ error: 'Session ID required' }, { status: 400 })
    }
    await sandbox.deleteSession(sessionId)
    return Response.json({ success: true })
  }

  // POST /sandbox/:id/git/clone - Clone repository
  if (action === 'git/clone' && method === 'POST') {
    const body = (await request.json()) as {
      repoUrl: string
      branch?: string
      targetDir?: string
      token?: string
      username?: string
    }

    // Build authenticated URL if credentials provided
    let authUrl = body.repoUrl
    if (body.token && body.username) {
      const url = new URL(body.repoUrl)
      url.username = body.username
      url.password = body.token
      authUrl = url.toString()
    }

    await sandbox.gitCheckout(authUrl, {
      branch: body.branch,
      targetDir: body.targetDir || '/workspace'
    })
    return Response.json({ success: true })
  }

  // POST /sandbox/:id/git/branch - Create and checkout branch
  if (action === 'git/branch' && method === 'POST') {
    const body = (await request.json()) as { cwd?: string; branchName: string }
    const result = await sandbox.exec(`git checkout -b ${body.branchName}`, {
      cwd: body.cwd || '/workspace'
    })
    return Response.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    })
  }

  // POST /sandbox/:id/git/commit - Add all and commit
  if (action === 'git/commit' && method === 'POST') {
    const body = (await request.json()) as {
      cwd?: string
      message: string
      authorName: string
      authorEmail: string
      allowEmpty?: boolean
    }
    const cwd = body.cwd || '/workspace'

    // Configure git user
    await sandbox.exec(`git config user.name "${body.authorName}"`, { cwd })
    await sandbox.exec(`git config user.email "${body.authorEmail}"`, { cwd })

    // Check status first
    const status = await sandbox.exec('git status --porcelain', { cwd })
    const hasChanges = Boolean(status.stdout.trim())
    if (!hasChanges && !body.allowEmpty) {
      return Response.json({ success: true, sha: null, noChanges: true })
    }

    // Add and commit
    if (hasChanges) {
      await sandbox.exec('git add .', { cwd })
    }
    const escapedMessage = body.message.replace(/"/g, '\\"')
    const commitCommand = body.allowEmpty
      ? `git commit --allow-empty -m "${escapedMessage}"`
      : `git commit -m "${escapedMessage}"`
    const commit = await sandbox.exec(commitCommand, { cwd })

    // Get SHA
    const shaResult = await sandbox.exec('git rev-parse HEAD', { cwd })

    return Response.json({
      success: commit.success,
      sha: shaResult.stdout.trim(),
      stdout: commit.stdout,
      stderr: commit.stderr
    })
  }

  // POST /sandbox/:id/git/push - Push to remote
  if (action === 'git/push' && method === 'POST') {
    const body = (await request.json()) as {
      cwd?: string
      token?: string
      username?: string
    }
    const cwd = body.cwd || '/workspace'

    // Set credentials for push if provided
    if (body.token && body.username) {
      // Get current remote URL and add credentials
      const remoteResult = await sandbox.exec('git remote get-url origin', {
        cwd
      })
      const remoteUrl = remoteResult.stdout.trim()

      // Parse and add credentials
      const url = new URL(
        remoteUrl.replace('git@github.com:', 'https://github.com/')
      )
      url.username = body.username
      url.password = body.token

      await sandbox.exec(`git remote set-url origin "${url.toString()}"`, {
        cwd
      })
    }

    const result = await sandbox.exec('git push -u origin HEAD', { cwd })
    return Response.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    })
  }

  // GET /sandbox/:id/git/status - Get git status
  if (action === 'git/status' && method === 'GET') {
    const url = new URL(request.url)
    const cwd = url.searchParams.get('cwd') || '/workspace'
    const result = await sandbox.exec('git status --porcelain', { cwd })

    const files = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line: string) => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3)
      }))

    return Response.json({ files, hasChanges: files.length > 0 })
  }

  // POST /sandbox/:id/file/write - Write file
  if (action === 'file/write' && method === 'POST') {
    const body = (await request.json()) as {
      path: string
      content: string
      encoding?: string
    }
    await sandbox.writeFile(body.path, body.content)
    return Response.json({ success: true })
  }

  // GET /sandbox/:id/file/read - Read file
  if (action === 'file/read' && method === 'GET') {
    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    if (!path) {
      return Response.json({ error: 'path required' }, { status: 400 })
    }
    const file = await sandbox.readFile(path)
    return Response.json({ content: file.content, encoding: file.encoding })
  }

  // POST /sandbox/:id/mkdir - Create directory
  if (action === 'mkdir' && method === 'POST') {
    const body = (await request.json()) as { path: string; recursive?: boolean }
    await sandbox.mkdir(body.path, { recursive: body.recursive ?? true })
    return Response.json({ success: true })
  }

  // GET /sandbox/:id/ping - Health check (just returns success if sandbox is reachable)
  if (action === 'ping' && method === 'GET') {
    return Response.json({ status: 'ok' })
  }

  return new Response('Not found', { status: 404 })
}
