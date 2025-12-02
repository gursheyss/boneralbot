import type { CloudflareSandbox } from './cloudflare'
import { executeCommand, executeCommandAsync } from './cloudflare'

const SANDBOX_URL = process.env.CLOUDFLARE_SANDBOX_URL!
const SANDBOX_TOKEN = process.env.SANDBOX_AUTH_TOKEN!

const REPO_PATH = '/workspace/repo'
const SESSION_NAME = 'opencode-session'
const CONFIG_DIR = '/root/.opencode'
const CONFIG_PATH = `${CONFIG_DIR}/config.json`
const XDG_CONFIG_DIR = '/root/.config/opencode'
const XDG_CONFIG_PATH = `${XDG_CONFIG_DIR}/opencode.json`
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode'
const OPENCODE_PATH_PREFIX =
  process.env.OPENCODE_PATH_PREFIX ||
  '/root/.opencode/bin:/root/.local/bin:/home/gursh/.opencode/bin'
const OPENCODE_RUN_FLAGS =
  process.env.OPENCODE_RUN_FLAGS || '--print-logs --log-level DEBUG --format json'

const OPENCODE_CONFIG = {
  model: 'opencode/gemini-3-pro',
  small_model: 'opencode/claude-haiku-4-5',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    external_directory: 'allow',
    doom_loop: 'allow',
  },
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

export async function installOpenCode(
  sandbox: CloudflareSandbox
): Promise<void> {
  // OpenCode is pre-installed in the Docker image
  // Just run bun install in the repo
  await executeCommand(sandbox, 'bun install', REPO_PATH)
}

export async function configureOpenCode(
  sandbox: CloudflareSandbox
): Promise<void> {
  // Create config directories
  await sandboxRequest(sandbox.id, '/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path: CONFIG_DIR, recursive: true }),
  })
  await sandboxRequest(sandbox.id, '/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path: XDG_CONFIG_DIR, recursive: true }),
  })

  // Write config files in both legacy and XDG locations
  const configContent = JSON.stringify(OPENCODE_CONFIG, null, 2)
  await sandboxRequest(sandbox.id, '/file/write', {
    method: 'POST',
    body: JSON.stringify({
      path: CONFIG_PATH,
      content: configContent,
    }),
  })
  await sandboxRequest(sandbox.id, '/file/write', {
    method: 'POST',
    body: JSON.stringify({
      path: XDG_CONFIG_PATH,
      content: configContent,
    }),
  })
}

export async function createOpenCodeSession(
  sandbox: CloudflareSandbox
): Promise<void> {
  await sandboxRequest(sandbox.id, '/session', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: SESSION_NAME,
      cwd: REPO_PATH,
    }),
  })
}

export async function sendPromptToOpenCode(
  sandbox: CloudflareSandbox,
  prompt: string,
  onLog: (chunk: string) => void
): Promise<number> {
  const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')
  const command = [
    `cd ${REPO_PATH}`,
    // Use non-interactive run mode; --headless is not supported by the CLI
    `PATH="${OPENCODE_PATH_PREFIX}:$PATH" ${OPENCODE_BIN} run ${OPENCODE_RUN_FLAGS} --session ${SESSION_NAME} "${escapedPrompt}"`
  ].join(' && ')

  // Emit debug info about how we're invoking OpenCode
  onLog(`[opencode] PATH prefix: ${OPENCODE_PATH_PREFIX}\n`)
  onLog(`[opencode] command: ${command}\n`)

  // Try to locate the binary to aid debugging
  try {
    const which = await executeCommand(
      sandbox,
      `PATH="${OPENCODE_PATH_PREFIX}:$PATH" which ${OPENCODE_BIN}`,
      REPO_PATH
    )
    const whichResult = which.result.trim() || '(not found)'
    onLog(`[opencode] which ${OPENCODE_BIN}: ${whichResult}\n`)
  } catch (err) {
    onLog(`[opencode] which lookup failed: ${String(err)}\n`)
  }

  const exitCode = await executeCommandAsync(sandbox, SESSION_NAME, command, onLog)
  onLog(`[opencode] exit code: ${exitCode}\n`)

  return exitCode
}

export async function cleanupOpenCodeSession(
  sandbox: CloudflareSandbox
): Promise<void> {
  try {
    await sandboxRequest(sandbox.id, `/session/${SESSION_NAME}`, {
      method: 'DELETE',
    })
  } catch {
    // Session may already be deleted
  }
}
