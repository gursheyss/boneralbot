import type { Sandbox } from '@daytonaio/sdk'
import { executeCommand, executeCommandAsync } from './daytona'

const REPO_PATH = '/home/daytona/workspace'
const SESSION_NAME = 'opencode-session'
const CONFIG_DIR = '/home/daytona/.opencode'
const CONFIG_PATH = `${CONFIG_DIR}/config.json`

const OPENCODE_CONFIG = {
  model: 'opencode/gemini-3-pro',
  small_model: 'opencode/claude-haiku-4-5',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    external_directory: 'allow',
    doom_loop: 'allow'
  }
}

export async function installOpenCode(sandbox: Sandbox): Promise<void> {
  await executeCommand(sandbox, 'npm install -g @opencode/cli')
  await executeCommand(sandbox, 'bun install', REPO_PATH)
}

export async function configureOpenCode(sandbox: Sandbox): Promise<void> {
  await sandbox.fs.createFolder(CONFIG_DIR, '755')
  await sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(OPENCODE_CONFIG, null, 2)),
    CONFIG_PATH
  )
}

export async function createOpenCodeSession(sandbox: Sandbox): Promise<void> {
  await sandbox.process.createSession(SESSION_NAME)

  await sandbox.process.executeSessionCommand(SESSION_NAME, {
    command: `cd ${REPO_PATH}`
  })
}

export async function sendPromptToOpenCode(
  sandbox: Sandbox,
  prompt: string,
  onLog: (chunk: string) => void
): Promise<number> {
  const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')

  const exitCode = await executeCommandAsync(
    sandbox,
    SESSION_NAME,
    `cd ${REPO_PATH} && opencode --headless "${escapedPrompt}"`,
    onLog
  )

  return exitCode
}

export async function cleanupOpenCodeSession(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.process.deleteSession(SESSION_NAME)
  } catch {
    // Session may already be deleted
  }
}
