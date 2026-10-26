// Browser check of the console (P20): Tests, then an edit, then Tests again
// - without ▶ Run in between - runs the edited code, and its report is in
// view, also when the learner scrolled up to read the first report. Before
// the fix the second report was appended out of view below the first one,
// so «Tests» looked as if it didn't react.
//
// Drives the built embed (dist-embed/, from npm run build:embed) in Chrome
// through its protocol, as the LiaScript macro does; Pyodide comes from its
// CDN. Needs Google Chrome (GitHub's ubuntu-latest has it).
//
//   npm run build:embed && npm run test:console
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const port = 4185
const origin = `http://localhost:${port}`
const server = spawn('npx', ['vite', 'preview', '--config', 'vite.embed.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore' })
const stopServer = () => server.kill()
process.on('exit', stopServer)

// The parent page, served on the embed's own origin: it loads the embed and
// passes messages on, version 4.
const harness = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="embed" style="width:760px;height:900px;border:0"></iframe>
<script>
  const iframe = document.querySelector('#embed')
  window.ready = false
  window.send = (type, source) => iframe.contentWindow.postMessage({ type: 'glpython:' + type, version: 4, source, mode: 'eval' }, location.origin)
  addEventListener('message', (event) => { if (event.data?.type === 'glpython:ready') window.ready = true })
  iframe.src = './index.html?parentOrigin=' + encodeURIComponent(location.origin) + '&mode=eval&lang=de'
</script>`

const program = (examples) => `def schnitt(a, b):\n    """\n${examples.map(([call, want]) => `    >>> ${call}\n    ${want}\n`).join('')}    """\n    return (a + b) / 2\n`
// Enough failing examples that the report is taller than the console.
const failing = program([['schnitt(4, 6)', '5'], ['schnitt(6, 4)', '4.5'], ['schnitt(2, 2)', '3'], ['schnitt(1, 1)', '7'], ['schnitt(0, 4)', '1']])
const edited = program([['schnitt(4, 6)', '5.0'], ['schnitt(6, 4)', '4.5'], ['schnitt(2, 2)', '3'], ['schnitt(1, 1)', '7'], ['schnitt(0, 4)', '1']])
const passing = program([['schnitt(4, 6)', '5.0']])
const passingEdited = program([['schnitt(4, 6)', '5.0'], ['schnitt(1, 2)', '1.5']])

let failed = 0
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (let attempt = 0; ; attempt++) {
    try { await fetch(`${origin}/index.html`); break } catch { if (attempt > 50) throw new Error('vite preview did not start') }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  for (const [label, first, second, firstSummary, secondSummary] of [
    ['Tests → fail → edit → Tests', failing, edited, '0 von 5 Beispielen bestanden', '1 von 5 Beispielen bestanden'],
    ['Tests → pass → edit → Tests', passing, passingEdited, '1 von 1 Beispielen bestanden', '2 von 2 Beispielen bestanden'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 800, height: 950 } })
    await page.route(`${origin}/check-console.html`, (route) => route.fulfill({ contentType: 'text/html', body: harness }))
    await page.goto(`${origin}/check-console.html`)
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 })
    const frame = page.frameLocator('#embed')
    const summaries = frame.locator('.test-summary')
    await page.evaluate((source) => window.send('test', source), first)
    await summaries.first().waitFor({ timeout: 60000 })
    // The learner reads the report from its top.
    await frame.locator('.console').evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
    await page.evaluate((source) => window.send('test', source), second)
    await summaries.nth(1).waitFor({ timeout: 60000 })
    await page.waitForTimeout(300)
    try {
      assert.deepEqual(await summaries.allInnerTexts(), [firstSummary, secondSummary], `${label}: the second run tests the edited code`)
      const inView = await frame.locator('.console').evaluate((element) => {
        const view = element.getBoundingClientRect()
        const summary = [...element.querySelectorAll('.test-summary')].at(-1).getBoundingClientRect()
        return summary.top >= view.top && summary.bottom <= view.bottom
      })
      assert.ok(inView, `${label}: the new report's summary is in the console's view`)
      console.log(`${label}: ok`)
    } catch (error) {
      failed += 1
      console.error(error.message)
    }
    await page.close()
  }
} finally {
  await browser.close()
  stopServer()
}
if (failed > 0) process.exit(1)
console.log('Console browser checks passed.')
