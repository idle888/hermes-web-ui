import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalHermesHome = process.env.HERMES_HOME
const originalApiServerEnabled = process.env.API_SERVER_ENABLED
const originalApiServerHost = process.env.API_SERVER_HOST
const originalApiServerPort = process.env.API_SERVER_PORT
const originalApiServerKey = process.env.API_SERVER_KEY
const tempHomes: string[] = []

function createHermesHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-gateway-'))
  tempHomes.push(home)
  return home
}

async function createManager(home: string): Promise<any> {
  process.env.HERMES_HOME = home
  vi.resetModules()
  const { GatewayManager } = await import('../../packages/server/src/services/hermes/gateway-manager')
  return new GatewayManager('default') as any
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  if (originalHermesHome === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = originalHermesHome
  }

  if (originalApiServerEnabled === undefined) delete process.env.API_SERVER_ENABLED
  else process.env.API_SERVER_ENABLED = originalApiServerEnabled

  if (originalApiServerHost === undefined) delete process.env.API_SERVER_HOST
  else process.env.API_SERVER_HOST = originalApiServerHost

  if (originalApiServerPort === undefined) delete process.env.API_SERVER_PORT
  else process.env.API_SERVER_PORT = originalApiServerPort

  if (originalApiServerKey === undefined) delete process.env.API_SERVER_KEY
  else process.env.API_SERVER_KEY = originalApiServerKey

  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('GatewayManager Windows process recovery', () => {
  it('treats EPERM from process.kill(pid, 0) as an alive process', async () => {
    const manager = await createManager(createHermesHome())
    ;(vi.spyOn(process, 'kill') as any).mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })

    expect(manager.isProcessAlive(12345)).toBe(true)
  })

  it('returns false for missing processes', async () => {
    const manager = await createManager(createHermesHome())
    ;(vi.spyOn(process, 'kill') as any).mockImplementation(() => {
      const error = new Error('missing process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })

    expect(manager.isProcessAlive(12345)).toBe(false)
  })

  it('prefers gateway.pid when PID metadata exists', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: 11111 }))
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 22222, gateway_state: 'running' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('default')).toBe(11111)
  })

  it('falls back to gateway_state.json when gateway.pid is missing', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: '22222', gateway_state: 'running' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('default')).toBe(22222)
  })

  it('does not use gateway_state.json for stopped gateways', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 22222, gateway_state: 'stopped' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('default')).toBeNull()
  })

  it('uses profile-scoped gateway_state.json fallback', async () => {
    const home = createHermesHome()
    const profileHome = join(home, 'profiles', 'work')
    mkdirSync(profileHome, { recursive: true })
    writeFileSync(join(profileHome, 'gateway_state.json'), JSON.stringify({ pid: 33333, gateway_state: 'starting' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('work')).toBe(33333)
  })
})

describe('GatewayManager effective API server config', () => {
  it('uses API_SERVER_PORT and API_SERVER_HOST env overrides when resolving the upstream', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'config.yaml'), [
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '    extra:',
      '      host: 127.0.0.1',
      '      port: 8642',
      '',
    ].join('\n'))
    process.env.API_SERVER_HOST = '0.0.0.0'
    process.env.API_SERVER_PORT = '8655'

    const manager = await createManager(home)

    expect(manager.getUpstream()).toBe('http://0.0.0.0:8655')
    expect(manager.readProfilePort('default')).toEqual({ host: '0.0.0.0', port: 8655 })
  })

  it('ignores invalid API_SERVER_PORT env values and keeps the configured port', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'config.yaml'), [
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '    extra:',
      '      host: 127.0.0.1',
      '      port: 8650',
      '',
    ].join('\n'))
    process.env.API_SERVER_PORT = 'not-a-port'

    const manager = await createManager(home)

    expect(manager.getUpstream()).toBe('http://127.0.0.1:8650')
  })

  it('uses API_SERVER_PORT env as a fallback when config has no port', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'config.yaml'), [
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '    extra: {}',
      '',
    ].join('\n'))
    process.env.API_SERVER_PORT = '8655'

    const manager = await createManager(home)

    expect(manager.getUpstream()).toBe('http://127.0.0.1:8655')
  })

  it('uses API_SERVER_KEY from process env for proxy authentication', async () => {
    process.env.API_SERVER_KEY = 'env-secret'

    const manager = await createManager(createHermesHome())

    expect(manager.getApiKey()).toBe('env-secret')
  })

  it('uses API_SERVER_KEY from profile .env when process env is not set', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, '.env'), 'API_SERVER_KEY="file-secret"\n')

    const manager = await createManager(home)

    expect(manager.getApiKey()).toBe('file-secret')
  })

  it('reads API server key from Hermes config when env files are absent', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'config.yaml'), [
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '    extra:',
      '      key: config-secret',
      '',
    ].join('\n'))

    const manager = await createManager(home)

    expect(manager.getApiKey()).toBe('config-secret')
  })

  it('preserves existing API server key and CORS settings when writing the port', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'config.yaml'), [
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '    key: legacy-key',
      '    cors_origins:',
      '      - https://example.test',
      '    extra:',
      '      key: extra-secret',
      '      cors_origins:',
      '        - https://api.example.test',
      '',
    ].join('\n'))

    const manager = await createManager(home)
    manager.writeProfilePort('default', 8655, '127.0.0.1')

    const { default: yaml } = await import('js-yaml')
    const { readFileSync } = await import('fs')
    const cfg = yaml.load(readFileSync(join(home, 'config.yaml'), 'utf-8')) as any

    expect(cfg.platforms.api_server.key).toBe('legacy-key')
    expect(cfg.platforms.api_server.cors_origins).toEqual(['https://example.test'])
    expect(cfg.platforms.api_server.extra.key).toBe('extra-secret')
    expect(cfg.platforms.api_server.extra.cors_origins).toEqual(['https://api.example.test'])
    expect(cfg.platforms.api_server.extra.port).toBe(8655)
    expect(cfg.platforms.api_server.extra.host).toBe('127.0.0.1')
  })
})
