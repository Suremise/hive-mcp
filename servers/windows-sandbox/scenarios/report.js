/**
 * Turns what the Hive checks collected from the Sandbox into checks and a short Markdown report. Pure functions, no I/O.
 *   const result = evaluate(meta, files)   // files: { 's1-run': {...}, 's1': {...}, ... } (the JSON the scenarios wrote)
 *   const md = markdown(result)
 *
 * A report passes only with full coverage: every scenario that was asked for ran, every step the runner took
 * succeeded (meta.steps), each driver finished (completed) and produced all its required checks and facts, and the
 * required screenshots were collected. Anything missing is a failed check, never a silent gap.
 * The one exception: a run kind in meta.notRun ({ kind: { reason, installer } }) wasn't checked at all (its installer
 * was refused by an App Control policy before anything could run). Its checks are left out and, unless another check
 * failed, the report is NOT RUN with that reason.
 */
const SCENARIOS = {
  1: 'Fresh install and first launch',
  2: 'First run with no coding-agent CLIs',
  3: 'A CLI appearing while Hive runs (fake CLI)',
  4: 'Upgrade from the previous release (--updated /S --force-run)',
  5: 'Uninstall',
  6: 'A new workspace in the fresh install (for the fresh-install comparison)'
}
const KINDS = ['fresh', 'upgrade']

// What each run kind must produce: the drivers' check ids and facts, and the screenshots.
const REQUIRED = {
  fresh: {
    drivers: {
      s1: { scenario: 1, ids: ['1.start-screen', '1.profile', '2.banner', '2.no-claude-warning', '2.api-providers', '2.agent-setup-opens', '2.agent-setup-three'], facts: ['version'] },
      s3: { scenario: 3, ids: ['3.on-not-found', '3.banner-none-installed', '3.setup-not-installed', '3.user-path', '3.check-again-finds', '3.setup-found', '3.api-installed', '3.banner-gone'], facts: [] },
      s6: { scenario: 6, ids: ['6.workspace-opens', '6.hive-folder', '6.views'], facts: ['hive', 'views'] }
    },
    shots: ['s1-desktop.jpg', 's1-installed-apps.jpg', 's1-start-dark.png', 's1-start-light.png', 's1-agent-setup-dark.png', 's1-agent-setup-light.png', 's3-missing-dark.png', 's3-found-dark.png', 's3-found-light.png', 's6-workspace.png', 's6-workspace-overview.png', 's6-skills.png', 's6-mcp-servers.png', 's6-hive-assistant.png', 's5-desktop.jpg']
  },
  upgrade: {
    drivers: {
      's4-mark': { scenario: 4, ids: ['4.settings-saved'], facts: ['version'] },
      's4-after': { scenario: 4, ids: ['4.settings-kept', '4.theme-applied'], facts: ['version'] }
    },
    shots: ['s4-mark-before-upgrade.png', 's4-desktop-before.jpg', 's4-desktop-after.jpg', 's4-after-after-upgrade-light.png', 's4-after-after-upgrade-dark.png']
  }
}

const entriesOf = s => (s?.uninstallEntries ? [].concat(s.uninstallEntries) : [])
const shortcutsOf = s => (s?.shortcuts ? [].concat(s.shortcuts) : [])
const inDesktop = l => /\\Desktop$/i.test(l.folder)
const inStart = l => /Start Menu\\Programs$/i.test(l.folder)

/** Shortcuts as a short text: "Hive Desktop (Desktop, Start menu)". */
const describeShortcuts = list => list.map(l => `${l.name} (${inDesktop(l) ? 'Desktop' : inStart(l) ? 'Start menu' : l.folder})`).join(', ') || 'none'

function evaluate(meta, files) {
  const checks = []
  const add = (scenario, name, ok, detail) => checks.push({ scenario, name, ok: !!ok, detail: ok ? undefined : String(detail ?? '') })
  const asked = Array.isArray(meta.ran) ? meta.ran : []
  const notRun = Object.entries(meta.notRun || {}).filter(([k]) => asked.includes(k)).map(([kind, n]) => ({ kind, reason: n.reason, installer: n.installer }))
  // What was checked: the kinds asked for, less those not run.
  const ran = asked.filter(k => !notRun.some(n => n.kind === k))
  const need = (scenario, key) => {
    if (files[key] && typeof files[key] === 'object') return files[key]
    add(scenario, `${key}: result recorded`, false, files[`${key}:error`] || 'the scenario wrote no result (see the run log)')
    return null
  }
  // A driver's record counts only if the step finished, with every required check id and fact.
  const driver = (kind, key) => {
    const req = REQUIRED[kind].drivers[key]
    const d = need(req.scenario, key)
    if (!d) return null
    if (d.completed !== true) add(req.scenario, `${key}: the driver finished its step`, false, d.error || 'it stopped before the end (interrupted, timed out or failed)')
    const list = Array.isArray(d.checks) ? d.checks : []
    for (const c of list) checks.push({ scenario: c.scenario || req.scenario, name: c.name, ok: c.ok === true, detail: c.ok === true ? undefined : c.detail })
    for (const id of req.ids) if (!list.some(c => c.id === id)) add(req.scenario, `${key}: check "${id}" ran`, false, 'missing from the driver\'s record')
    for (const f of req.facts) if (d.facts?.[f] === undefined) add(req.scenario, `${key}: fact "${f}" recorded`, false, 'missing from the driver\'s record')
    return d
  }
  const version = meta.installerVersion

  const unknown = ran.filter(k => !KINDS.includes(k))
  if ((!asked.length) || unknown.length) add(0, 'The scenarios asked for ran', false, unknown.length ? `unknown: ${unknown.join(', ')}` : 'none ran')
  // Every step the runner took must have succeeded: a failed command or timeout fails the report.
  for (const s of meta.steps || []) add(s.scenario, `Step: ${s.what}`, s.ok, s.detail)
  for (const kind of ran.filter(k => KINDS.includes(k))) {
    for (const shot of REQUIRED[kind].shots) if (!(meta.shots || []).includes(shot)) add(Number(shot[1]) || 0, `Screenshot ${shot} collected`, false, 'missing')
  }

  if (ran.includes('fresh')) {
    const run = need(1, 's1-run')
    const st = need(1, 's1-state')
    if (run) add(1, `Silent install (/S) succeeds (${run.seconds} s)`, run.exitCode === 0, `exit ${run.exitCode}`)
    if (st) {
      const e = entriesOf(st)
      add(1, `One Installed-apps entry: "Hive Desktop ${version}"`, e.length === 1 && e[0].displayName === `Hive Desktop ${version}`, JSON.stringify(e.map(x => x.displayName)))
      add(1, 'Installed in %LOCALAPPDATA%\\Programs\\Hive (Hive.exe, Uninstall Hive.exe)', st.installDir?.hiveExe && st.installDir?.uninstaller, JSON.stringify(st.installDir))
      const l = shortcutsOf(st)
      add(1, 'Shortcuts named "Hive Desktop" on the Desktop and in the Start menu', l.length >= 2 && l.every(x => x.name === 'Hive Desktop' && /\\Hive\\Hive\.exe$/i.test(x.target)) && l.some(inDesktop) && l.some(inStart), describeShortcuts(l))
    }
    const s1 = driver('fresh', 's1')
    if (s1?.facts?.version !== undefined) add(1, `The app reports version ${version}`, s1.facts.version === version, `reports ${s1.facts.version}`)
    driver('fresh', 's3')
    driver('fresh', 's6')
    const run5 = need(5, 's5-run')
    const st5 = need(5, 's5-state')
    if (run5) add(5, `Silent uninstall ("Uninstall Hive.exe" /S) succeeds (${run5.seconds} s)`, run5.exitCode === 0, `exit ${run5.exitCode}`)
    if (st5) {
      add(5, 'The Installed-apps entry is gone', !entriesOf(st5).length, JSON.stringify(entriesOf(st5).map(x => x.displayName)))
      add(5, 'The install folder is gone', st5.installDir?.exists === false, st5.installDir?.path)
      add(5, 'The shortcuts are gone', !shortcutsOf(st5).length, describeShortcuts(shortcutsOf(st5)))
      add(5, 'The profile (%APPDATA%\\Hive) is kept (deleteAppDataOnUninstall: false)', st5.profileDir?.exists === true, JSON.stringify(st5.profileDir))
    }
  }

  if (ran.includes('upgrade')) {
    const prevRun = need(4, 's4-prev-run')
    const prevSt = need(4, 's4-prev-state')
    if (prevRun) add(4, `The previous release installs (${prevRun.seconds} s)`, prevRun.exitCode === 0, `exit ${prevRun.exitCode}`)
    const prevNames = entriesOf(prevSt).map(x => x.displayName)
    driver('upgrade', 's4-mark')
    const newRun = need(4, 's4-new-run')
    const newSt = need(4, 's4-new-state')
    if (newRun) {
      add(4, `The new build installs over it with --updated /S --force-run (${newRun.seconds} s)`, newRun.exitCode === 0, `exit ${newRun.exitCode}`)
      add(4, '--force-run starts Hive after the update', newRun.hiveRunning === true, 'no Hive.exe running from the install folder')
    }
    if (newSt) {
      const e = entriesOf(newSt)
      add(4, `One Installed-apps entry after the upgrade: "Hive Desktop ${version}"`, e.length === 1 && e[0].displayName === `Hive Desktop ${version}`, `before: ${JSON.stringify(prevNames)}; after: ${JSON.stringify(e.map(x => x.displayName))}`)
      const l = shortcutsOf(newSt)
      add(4, `Shortcuts renamed or kept: only "Hive Desktop", on the Desktop and in the Start menu (before: ${describeShortcuts(shortcutsOf(prevSt))})`, l.length >= 2 && l.every(x => x.name === 'Hive Desktop') && l.some(inDesktop) && l.some(inStart), describeShortcuts(l))
      add(4, 'Same install folder, Hive.exe there', newSt.installDir?.hiveExe, JSON.stringify(newSt.installDir))
      // Test builds carry the previous release's version number: the app code's hash shows the new build went in.
      const before = prevSt?.installDir?.appAsarSha256
      const now = newSt.installDir?.appAsarSha256
      if (meta.sameInstaller) add(4, 'The installed app code is this build\'s', now && now === before, `${before} → ${now}`)
      else add(4, `The installed app code changed (app.asar ${String(before).slice(0, 12)}… → ${String(now).slice(0, 12)}…)`, before && now && before !== now, `${before} → ${now}`)
    }
    const after = driver('upgrade', 's4-after')
    if (after?.facts?.version !== undefined) add(4, `After the upgrade the app reports ${version}`, after.facts.version === version, `reports ${after.facts.version}`)
  }

  for (const id of meta.leftRunning || []) add(0, `CLEANUP: Sandbox ${id} confirmed stopped`, false, `CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`)
  if (!checks.length && !notRun.length) add(0, 'At least one check ran', false, 'nothing was checked')

  const passed = checks.filter(c => c.ok).length
  const differences = []
  if (ran.includes('upgrade') && meta.previousVersion === meta.installerVersion) {
    differences.push(`The previous release and this build both say **${meta.installerVersion}**: the in-app updater (no downgrades, only newer versions) would not offer this build, so the upgrade check is a reinstall over it, run by hand with the updater's arguments. The "Hive Desktop updated to …" notice can't show.`)
  }
  const s1 = files.s1
  if (s1?.facts?.gitMissing || files['s1-state']?.git === false) differences.push('**No Git** on a fresh machine: Hive shows its Git warning (status bar "Git", Agent Setup "Git not found"). Expected; a fresh-install difference.')
  return { meta, checks, passed, failed: checks.length - passed, notRun, differences, files }
}

/** The report's one-line verdict: FAILED beats NOT RUN beats PASSED. */
function verdict(r) {
  const notRun = r.notRun || []
  const kinds = notRun.map(n => n.kind).join(', ')
  if (r.failed) return `FAILED: ${r.failed} of ${r.checks.length} checks${notRun.length ? `; not run: ${kinds}` : ''}`
  if (notRun.length) {
    const reasons = [...new Set(notRun.map(n => n.reason))].join(' ')
    return `NOT RUN: ${reasons}${r.checks.length ? ` (not run: ${kinds}; the other ${r.checks.length} checks passed)` : ''}`
  }
  return `PASSED: all ${r.checks.length} checks`
}

function markdown(r) {
  const m = r.meta
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = [
    `# Hive build checks in Windows Sandbox`,
    '',
    `**${verdict(r)}** · ${m.date}`,
    '',
    `- Installer: \`${m.installer}\` (version ${m.installerVersion}${m.buildInfo ? `, code ${m.buildInfo.code}, branch ${m.buildInfo.branch}, built ${m.buildInfo.builtAt}` : ''})`,
    m.previous ? `- Previous release for the upgrade: \`${m.previous}\` (version ${m.previousVersion})` : null,
    `- Host Windows ${m.hostBuild}; network **off** in the Sandbox; fake CLIs only, nothing signed in.`,
    `- Scenarios run: ${(m.ran || []).filter(k => !(r.notRun || []).some(n => n.kind === k)).join(', ') || 'none'}. Took ${m.minutes} min.`,
    ''
  ].filter(l => l !== null)
  if (r.notRun?.length) {
    lines.push('## Not run', '', 'Nothing in these was checked, so none of their checks passed or failed:', '')
    for (const n of r.notRun) lines.push(`- **${n.kind}**: Windows refused \`${n.installer}\`.`)
    lines.push('', ...[...new Set(r.notRun.map(n => n.reason))].map(esc), '')
  }
  const failed = r.checks.filter(c => !c.ok)
  if (failed.length) {
    lines.push('## Failed checks', '')
    for (const c of failed) lines.push(`- **${c.scenario}. ${c.name}**: ${esc(c.detail || '')}`)
    lines.push('')
  }
  for (const [n, title] of Object.entries(SCENARIOS)) {
    const cs = r.checks.filter(c => String(c.scenario) === n)
    if (!cs.length) continue
    lines.push(`## ${n}. ${title}`, '', '| Check | Result |', '|---|---|')
    for (const c of cs) lines.push(`| ${esc(c.name)} | ${c.ok ? 'pass' : `**FAIL**: ${esc(c.detail || '').slice(0, 300)}`} |`)
    lines.push('')
  }
  if (r.differences.length) lines.push('## Notes and fresh-install differences', '', ...r.differences.map(d => `- ${d}`), '')
  if (m.timings && Object.keys(m.timings).length) lines.push('## Timings', '', ...Object.entries(m.timings).map(([k, v]) => `- ${k}: ${v}`), '')
  if (m.shots?.length) lines.push('## Screenshots', '', ...m.shots.map(s => `- [${s}](${encodeURI(s)})`), '')
  return lines.join('\n')
}

module.exports = { evaluate, markdown, verdict, SCENARIOS, KINDS, REQUIRED }
