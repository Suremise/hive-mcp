/**
 * Runs inside the Sandbox, as the user, with the host's Node and Hive's own playwright-core mapped read-only:
 *   C:\tools\node\node.exe C:\wsb-mcp\hive\drive.cjs <step> <prefix>
 * Drives the installed Hive (%LOCALAPPDATA%\Programs\Hive\Hive.exe, its real profile %APPDATA%\Hive) with Playwright's
 * _electron, as Hive's e2e suites do, and writes C:\out\<prefix>.json ({ step, checks: [{ id, scenario, name, ok, detail }],
 * facts, shots, completed }) and window PNGs C:\out\<prefix>-<name>.png. completed is true only once the whole step ran
 * (the file is saved as it goes, so an interrupted step leaves a record without it). Network off, fake CLIs only.
 * Steps:
 *   first-run     scenarios 1 and 2: the first screen, no-CLI banners, Agent Setup's three providers, both themes
 *   cli-appears   scenario 3: Claude Code turned on, a stand-in installer puts the e2e fake on the user PATH, and
 *                 Agent Setup's "Check again" finds it without restarting Hive
 *   workspace     scenario 6: a new workspace in the fresh install (its .hive, views and status), for the fresh-install comparison
 *   mark          scenario 4, before the upgrade: change two settings (user name, theme)
 *   after-upgrade scenario 4, after it: those settings kept, the version, a screenshot
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron } = require(process.env.PW_CORE || 'C:\\tools\\playwright')

const [step, prefix] = process.argv.slice(2)
const OUT = 'C:\\out'
const HIVE_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Hive', 'Hive.exe')
const PROFILE = path.join(process.env.APPDATA, 'Hive')
const MARK = { userName: 'Sandbox Check', theme: 'light' }
const res = { step, prefix, at: new Date().toISOString(), checks: [], facts: {}, shots: [] }
const save = () => fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(res, null, 2))
// Each check has a stable id ("<scenario>.<what>"): the host's report requires the ids each step must produce.
const check = (id, name, ok, detail) => { res.checks.push({ id, scenario: Number(String(id).split('.')[0]) || 0, name, ok: !!ok, detail: ok ? undefined : String(detail ?? '').slice(0, 1500) }); save() }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms, every = 250) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every) } }
const ps = cmd => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60_000 }).trim()
const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8')) } catch { return null } }

let app
let page
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.hive.invoke(c, ...a), [channel, args])

/** Hive instances already running from the install folder (the installer's --force-run starts one): closed by PID. */
function closeRunningHive() {
  const out = ps(`$p = Get-CimInstance Win32_Process -Filter "Name='Hive.exe'" | Where-Object { $_.ExecutablePath -eq '${HIVE_EXE.replace(/'/g, "''")}' }; foreach ($x in $p) { $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; if ($g -and $g.MainWindowHandle -ne 0) { [void]$g.CloseMainWindow() } }; Start-Sleep -Seconds 3; $p = Get-CimInstance Win32_Process -Filter "Name='Hive.exe'" | Where-Object { $_.ExecutablePath -eq '${HIVE_EXE.replace(/'/g, "''")}' }; foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; @($p).Count`)
  return Number(out) || 0
}

async function launch() {
  const t0 = Date.now()
  app = await _electron.launch({ executablePath: HIVE_EXE, args: [], timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  page.on('pageerror', e => { (res.facts.pageErrors ||= []).push(String(e.message).slice(0, 300)) })
  await page.waitForSelector('.app .workbench', { timeout: 90_000 })
  res.facts.launchMs = Date.now() - t0
  // Ready once every provider check has finished (as Hive's e2e lib does).
  await until(async () => Object.values(await inv('provider:info')).every(i => !i.checking), 60_000)
  res.facts.readyMs = Date.now() - t0
}

async function shot(name) {
  const file = `${prefix}-${name}.png`
  await sleep(600)
  await page.screenshot({ path: path.join(OUT, file) })
  res.shots.push(file)
  save()
}

async function theme(t) {
  await inv('settings:update', { appearance: { theme: t } })
  await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === t, 5000)
}

async function api(route) {
  const token = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-api.json'), 'utf8')).token
  const port = readConfig()?.settings?.agentApi?.port || 47821
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
  return r.json()
}

async function agentSetup() {
  const dialog = page.locator('.dialog', { hasText: 'Agent Setup' })
  if (!(await dialog.count())) {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+P')
    await sleep(400)
    await page.keyboard.type('Agent Setup')
    await sleep(400)
    await page.keyboard.press('Enter')
  }
  return (await until(async () => (await dialog.count()) === 1, 10_000)) ? dialog : null
}

const bodyText = () => page.evaluate(() => document.body.innerText)
const statusWarnings = () => page.$$eval('.statusbar .status-item.warn', els => els.map(e => (e.innerText || e.getAttribute('title') || '').trim()))

const steps = {
  async 'first-run'() {
    await launch()
    const health = await api('/v1/health')
    res.facts.version = health.version
    res.facts.profileExists = fs.existsSync(PROFILE)
    check('1.start-screen', 'First launch shows the start screen ("Hive Desktop")', (await page.locator('.welcome h1', { hasText: 'Hive Desktop' }).count()) > 0, (await bodyText()).slice(0, 400))
    check('1.profile', 'The profile is %APPDATA%\\Hive', fs.existsSync(path.join(PROFILE, 'config.json')), PROFILE)
    const text = await bodyText()
    const banner = (await page.locator('.providers-banner').allInnerTexts()).join(' | ')
    res.facts.banner = banner
    res.facts.statusWarnings = await statusWarnings()
    check('2.banner', 'No coding agent is on: the banner says so and offers "Choose providers"', /No coding agents are turned on/.test(banner) && /Choose providers/.test(banner), banner)
    check('2.no-claude-warning', 'No "Claude Code is not installed" warning on a machine without CLIs', !/Claude Code is not installed/.test(text) && !res.facts.statusWarnings.some(w => /Claude/.test(w)), JSON.stringify({ statusWarnings: res.facts.statusWarnings }))
    res.facts.gitMissing = res.facts.statusWarnings.some(w => /^Git\b/.test(w)) || /Git isn't installed/.test(text)
    await shot('start-dark')
    const providers = await api('/v1/providers')
    res.facts.providers = providers
    const list = providers.providers || providers
    check('2.api-providers', 'Agent API: all three providers known, none on, none installed', Array.isArray(list) && list.length === 3 && list.every(p => !p.enabled && !p.installed), JSON.stringify(list))

    const dialog = await agentSetup()
    check('2.agent-setup-opens', 'Agent Setup opens', !!dialog, 'no dialog')
    if (dialog) {
      const tabs = (await dialog.locator('.setup-tab').allInnerTexts()).map(t => t.trim())
      res.facts.setupTabs = tabs
      check('2.agent-setup-three', 'Agent Setup offers all three: Claude Code, Codex, GitHub Copilot', ['Claude Code', 'Codex', 'GitHub Copilot'].every(n => tabs.some(t => t.startsWith(n))), JSON.stringify(tabs))
      res.facts.gitRow = await dialog.locator('[data-git]').getAttribute('data-git').catch(() => null)
      await shot('agent-setup-dark')
      await theme('light')
      await shot('agent-setup-light')
      await page.keyboard.press('Escape')
      await shot('start-light')
      await theme('dark')
    }
  },

  async 'cli-appears'() {
    await launch()
    const pid = app.process().pid
    // Turn Claude Code on, as a user does: the banner's "Choose providers", then its switch.
    await page.locator('.providers-banner button', { hasText: 'Choose providers' }).click({ timeout: 10_000 }).catch(() => {})
    const sw = page.locator('[role="switch"][aria-label="Use Claude Code"]')
    await sw.click({ timeout: 10_000 })
    const on = await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i }, 30_000)
    res.facts.before = on
    check('3.on-not-found', 'Claude Code turned on, not found yet', on && !on.found, JSON.stringify(on))
    const banner = (await page.locator('.providers-banner').allInnerTexts()).join(' | ')
    check('3.banner-none-installed', 'The banner now says no CLI is installed and offers Agent Setup', /No coding agent CLI is installed/.test(banner), banner)
    const dialog = await agentSetup()
    if (dialog) await dialog.locator('.setup-tab', { hasText: 'Claude Code' }).click()
    check('3.setup-not-installed', 'Agent Setup says "Claude Code is not installed"', dialog && /Claude Code is not installed/.test(await dialog.innerText()), dialog ? await dialog.innerText() : 'no dialog')
    await shot('missing-dark')

    // The stand-in installer: the e2e fake Claude Code copied into the user's programs, on the user PATH (registry).
    res.facts.install = ps('& C:\\wsb-mcp\\hive\\fake-claude-install.ps1')
    const hivePath = await app.evaluate(() => process.env.PATH || process.env.Path || '')
    check('3.user-path', 'The new folder is on the user PATH, not on Hive\'s own PATH yet', !hivePath.toLowerCase().includes('fakeclaude'), hivePath.slice(0, 300))
    await dialog.locator('button', { hasText: 'Check again' }).click()
    const found = await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i.found && i }, 30_000)
    res.facts.after = found || (await inv('provider:info'))['claude-code']
    check('3.check-again-finds', '"Check again" finds it, without restarting Hive', found && found.source === 'PATH' && found.version === '2.1.999' && /claude\.cmd$/i.test(found.path || '') && app.process().pid === pid, JSON.stringify(res.facts.after))
    check('3.setup-found', 'Agent Setup shows "Claude Code 2.1.999 — found via …"', /Claude Code 2\.1\.999 — found via/.test(await dialog.innerText()), await dialog.innerText())
    await shot('found-dark')
    await theme('light')
    await shot('found-light')
    await theme('dark')
    await page.keyboard.press('Escape')
    const providers = await api('/v1/providers')
    const claude = (providers.providers || providers).find(p => p.id === 'claude-code')
    check('3.api-installed', 'Agent API: Claude Code on and installed, 2.1.999', claude && claude.enabled && claude.installed && claude.version === '2.1.999', JSON.stringify(claude))
    const banner2 = (await page.locator('.providers-banner').allInnerTexts()).join(' | ')
    check('3.banner-gone', 'No provider banner any more', !banner2, banner2)
    await shot('ready-dark')
  },

  // Scenario 6 (for the fresh-install comparison, no model): what a fresh Hive makes of a new workspace.
  async workspace() {
    await launch()
    const ws = path.join(process.env.USERPROFILE, 'Workspaces', 'Fresh')
    fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'demo', 'README.md'), '# demo\n')
    await inv('workspace:open', ws)
    const opened = await until(async () => (await page.locator('.welcome').count()) === 0 && fs.existsSync(path.join(ws, '.hive')), 30_000)
    check('6.workspace-opens', 'A new workspace opens (an empty folder with one project folder)', opened, 'still on the welcome screen')
    await sleep(3000)
    const tree = (dir, depth) => {
      if (!fs.existsSync(dir)) return null
      return fs.readdirSync(dir, { withFileTypes: true }).map(e => (e.isDirectory() ? { [e.name]: depth > 1 ? tree(path.join(dir, e.name), depth - 1) : '(folder)' } : e.name))
    }
    res.facts.hive = tree(path.join(ws, '.hive'), 3)
    res.facts.projectHive = tree(path.join(ws, 'demo', '.hive'), 1)
    try { res.facts.workspaceJson = JSON.parse(fs.readFileSync(path.join(ws, '.hive', 'workspace.json'), 'utf8')) } catch { /* recorded as missing */ }
    check('6.hive-folder', 'Hive creates the workspace\'s .hive folder', Array.isArray(res.facts.hive), 'no .hive folder')
    const status = await api('/v1/status').catch(e => ({ error: String(e) }))
    res.facts.status = { workspace: status.workspace, workspaces: status.workspaces, providers: status.providers && Object.keys(status.providers) }
    res.facts.projects = await api('/v1/projects').catch(e => ({ error: String(e) }))
    res.facts.views = {}
    await shot('workspace')
    const views = ['Workspace Overview', 'Task Board', 'Shared Notes', 'Skills', 'MCP Servers', 'Hive Assistant']
    let shown = 0
    for (const name of views) {
      const slug = name.toLowerCase().replace(/\s+/g, '-')
      try {
        await page.getByRole('button', { name, exact: true }).first().click({ timeout: 5000 })
        await sleep(1500)
        res.facts.views[name] = (await page.evaluate(() => (document.querySelector('.workbench') || document.body).innerText)).slice(0, 1500)
        await shot(slug)
        shown++
      } catch (e) {
        res.facts.views[name] = `not shown: ${String(e.message).slice(0, 200)}`
      }
    }
    check('6.views', `The workspace's views open (${views.join(', ')})`, shown === views.length, JSON.stringify(res.facts.views).slice(0, 600))
  },

  async mark() {
    await launch()
    res.facts.version = (await api('/v1/health')).version
    await inv('settings:update', { general: { userName: MARK.userName }, appearance: { theme: MARK.theme } })
    const saved = await until(async () => { const c = readConfig(); return c?.settings?.general?.userName === MARK.userName && c.settings.appearance?.theme === MARK.theme && c }, 10_000)
    check('4.settings-saved', `Before the upgrade: user name "${MARK.userName}" and the ${MARK.theme} theme saved`, saved, JSON.stringify(readConfig()?.settings?.general))
    await shot('before-upgrade')
  },

  async 'after-upgrade'() {
    res.facts.closedForceRun = closeRunningHive()
    await launch()
    res.facts.version = (await api('/v1/health')).version
    const c = readConfig()
    res.facts.settings = { userName: c?.settings?.general?.userName, theme: c?.settings?.appearance?.theme, lastRunVersion: c?.lastRunVersion }
    check('4.settings-kept', 'Settings kept: user name and theme', res.facts.settings.userName === MARK.userName && res.facts.settings.theme === MARK.theme, JSON.stringify(res.facts.settings))
    check('4.theme-applied', 'The window is in the kept theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === MARK.theme, 'theme not applied')
    await shot('after-upgrade-light')
    await theme('dark')
    await shot('after-upgrade-dark')
  }
}

;(async () => {
  try {
    if (!steps[step]) throw new Error(`unknown step ${step}`)
    if (step !== 'after-upgrade') res.facts.closedBefore = closeRunningHive()
    await steps[step]()
    res.completed = true
  } catch (e) {
    res.error = String(e.stack || e).slice(0, 2000)
    check(`${prefix}.error`, `${step}: no error`, false, res.error)
    if (page) await shot('error').catch(() => {})
    process.exitCode = 1
  } finally {
    if (app) {
      await sleep(1000) // Hive saves settings 300 ms after a change
      await app.close().catch(e => { res.closeError = String(e) })
    }
    save()
  }
})()
