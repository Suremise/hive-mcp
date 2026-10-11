/**
 * Runs inside the Sandbox, in the user session, with a mapped (read-only) node.exe and Hive's own playwright-core:
 *   node drive-hive.cjs <Hive.exe> <out folder>
 * Launches the installed Hive with Playwright's _electron (as Hive's e2e suites do), on its real first-run profile,
 * screenshots the window, records what the first screen offers, clicks one button, screenshots again and quits.
 * Writes drive-hive.json and PNGs to the out folder.
 */
const { writeFileSync } = require('fs')
const { join } = require('path')
const { _electron } = require(process.env.PW_CORE || 'C:\\tools\\pw\\playwright-core')

const [exe, out] = process.argv.slice(2)
const res = { exe, steps: [] }
const step = (name, data) => { res.steps.push({ name, at: new Date().toISOString(), ...data }); save() }
const save = () => writeFileSync(join(out, 'drive-hive.json'), JSON.stringify(res, null, 2))

;(async () => {
  const t0 = Date.now()
  let app
  try {
    app = await _electron.launch({ executablePath: exe, args: [], timeout: 90_000 })
    step('launched', { ms: Date.now() - t0 })
    const win = await app.firstWindow({ timeout: 90_000 })
    await win.waitForLoadState('domcontentloaded')
    step('first window', { ms: Date.now() - t0, title: await win.title() })
    await win.waitForTimeout(8000)
    await win.screenshot({ path: join(out, 'hive-first-screen.png') })
    const text = await win.evaluate(() => document.body.innerText.slice(0, 3000))
    const buttons = await win.$$eval('button', bs => bs.map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 60))
    step('first screen', { ms: Date.now() - t0, text, buttons })
    // Drive it: click the first enabled button whose label suggests setup or continuing, else the first button.
    const pick = buttons.find(b => /set ?up|agent|continue|get started|next|ok/i.test(b)) || buttons[0]
    if (pick) {
      await win.getByRole('button', { name: pick }).first().click({ timeout: 10_000 })
      await win.waitForTimeout(3000)
      await win.screenshot({ path: join(out, 'hive-after-click.png') })
      step('clicked', { button: pick, text: await win.evaluate(() => document.body.innerText.slice(0, 2000)) })
    }
  } catch (e) {
    step('error', { error: String(e.stack || e) })
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(e => step('close error', { error: String(e) }))
    step('done', { ms: Date.now() - t0 })
  }
})()
