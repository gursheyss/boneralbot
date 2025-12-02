import { createSandbox, deleteSandbox } from './cloudflare'
import { cloneRepo, createBranch, createDraftPR } from './git'
import { getInstallationToken } from './github'
import {
  installOpenCode,
  configureOpenCode,
  createOpenCodeSession,
  sendPromptToOpenCode,
  cleanupOpenCodeSession,
} from './opencode'

async function test() {
  // First test GitHub App auth
  console.log('Testing GitHub App authentication...')
  const token = await getInstallationToken()
  console.log(`Got installation token: ${token.slice(0, 10)}...`)

  console.log('\nCreating sandbox...')
  const sandbox = await createSandbox('test-session', 'test-user')
  console.log(`Sandbox created: ${sandbox.id}`)

  try {
    console.log('\nCloning repo...')
    await cloneRepo(sandbox)

    console.log('\nCreating branch...')
    const branch = `test/build-test-${Date.now()}`
    await createBranch(sandbox, branch)

    console.log('\nInstalling OpenCode...')
    await installOpenCode(sandbox)

    console.log('\nConfiguring OpenCode...')
    await configureOpenCode(sandbox)

    console.log('\nCreating OpenCode session...')
    await createOpenCodeSession(sandbox)

    console.log('\nSending test prompt...')
    const exitCode = await sendPromptToOpenCode(
      sandbox,
      'List the files in the current directory and describe the project structure briefly',
      (chunk) => process.stdout.write(chunk)
    )
    console.log(`\n\nExit code: ${exitCode}`)

    // Optionally test PR creation (comment out if you don't want test PRs)
    // console.log('\nCreating draft PR...')
    // const { prNumber, prUrl } = await createDraftPR(sandbox, branch, 'Test PR', 'Testing GitHub App PR creation')
    // console.log(`Created PR #${prNumber}: ${prUrl}`)

    console.log('\nCleaning up session...')
    await cleanupOpenCodeSession(sandbox)
  } catch (error) {
    console.error('Error:', error)
  } finally {
    console.log('\nDeleting sandbox...')
    await deleteSandbox(sandbox)
    console.log('Done!')
  }
}

test()
