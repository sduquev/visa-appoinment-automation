const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'config.json');
const outputPath = path.join(rootDir, 'ais-inspection.txt');
const inspectorVersion = '2026-09-07.2';

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = readConfig();
  const authDir = path.join(rootDir, 'playwright/.auth');
  fs.mkdirSync(authDir, { recursive: true });

  const launchOptions = {
    headless: false,
  };

  if (config.ais.browserChannel) {
    launchOptions.channel = config.ais.browserChannel;
  }

  const context = await chromium.launchPersistentContext(authDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();

  await page.goto(config.ais.loginUrl, { waitUntil: 'domcontentloaded' });

  console.log('');
  console.log('AIS inspector is open.');
  console.log('1. Complete login manually in the browser.');
  console.log('2. Complete CAPTCHA/MFA manually if AIS asks for it.');
  console.log('3. Navigate to any page you want to inspect.');
  console.log('4. Press Enter here to scan the current page. You can scan again after navigating.');
  console.log('5. Type q and press Enter to close the inspector.');

  while (true) {
    const answer = await askQuestion('Scan current page? [Enter = scan, q = quit]');
    if (answer.trim().toLowerCase() === 'q') break;

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const report = await inspectPage(page);
    const text = formatReport(report);
    fs.writeFileSync(outputPath, text);
    console.log(text);
    console.log('');
    console.log(`Report written to: ${outputPath}`);
  }

  await context.close();
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error('config.json not found.');
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const interesting = Array.from(document.querySelectorAll([
      'a',
      'button',
      'input',
      'label',
      'option',
      'form',
      'select',
      'textarea',
      '[role="button"]',
      '[role="tab"]',
      '[role="tabpanel"]',
      '[data-date]',
      '[data-time]',
      '[data-value]',
      '[data-testid]',
      '[aria-controls]',
      'td',
      'th',
      'tr',
      'li',
      'p',
      'span',
      'div',
    ].join(',')));

    const dateTimePattern = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2})/;

    return {
      url: window.location.href,
      title: document.title,
      resources: performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => /appointment|days|times|schedule/i.test(url))
        .slice(-100),
      candidates: interesting
        .map((element) => describeElement(element))
        .filter((item) => item.selectors.length || dateTimePattern.test(item.text)),
    };

    function describeElement(element) {
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        type: element.getAttribute('type') || '',
        name: element.getAttribute('name') || '',
        id: element.id || '',
        className: element.className || '',
        value: getValue(element),
        disabled: Boolean(element.disabled),
        selected: Boolean(element.selected),
        visible: isVisible(element),
        text: cleanText(element.innerText || element.textContent || element.value || ''),
        attributes: {
          href: element.getAttribute('href') || '',
          ariaLabel: element.getAttribute('aria-label') || '',
          dataDate: element.getAttribute('data-date') || '',
          dataTime: element.getAttribute('data-time') || '',
          dataValue: element.getAttribute('data-value') || '',
          dataMonth: element.getAttribute('data-month') || '',
          dataYear: element.getAttribute('data-year') || '',
          dataHandler: element.getAttribute('data-handler') || '',
          dataTestId: element.getAttribute('data-testid') || '',
          ariaControls: element.getAttribute('aria-controls') || '',
        },
        selectors: buildSelectors(element),
      };
    }

    function getValue(element) {
      if ('value' in element) return String(element.value || '');
      return '';
    }

    function isVisible(element) {
      const styles = window.getComputedStyle(element);
      return element.offsetParent !== null && styles.display !== 'none' && styles.visibility !== 'hidden';
    }

    function buildSelectors(element) {
      const selectors = [];
      const tag = element.tagName.toLowerCase();

      if (element.id) {
        selectors.push(`#${CSS.escape(element.id)}`);
      }

      for (const attr of ['data-testid', 'data-date', 'data-time', 'data-value', 'data-month', 'data-year', 'data-handler', 'name', 'aria-label', 'aria-controls']) {
        const value = element.getAttribute(attr);
        if (value) selectors.push(`${tag}[${attr}="${escapeAttribute(value)}"]`);
      }

      if (element.classList.length) {
        selectors.push(`${tag}.${Array.from(element.classList).slice(0, 4).map((name) => CSS.escape(name)).join('.')}`);
      }

      const text = cleanText(element.innerText || element.textContent || element.value || '');
      if (text && ['a', 'button'].includes(tag)) {
        selectors.push(`${tag}:has-text("${escapeAttribute(text.slice(0, 60))}")`);
      }

      return selectors;
    }

    function cleanText(value) {
      return String(value).replace(/\s+/g, ' ').trim().slice(0, 160);
    }

    function escapeAttribute(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
  });
}

function formatReport(report) {
  const lines = [
    '',
    `AIS inspector version: ${inspectorVersion}`,
    'Current page',
    `URL: ${report.url}`,
    `Title: ${report.title || '(no title)'}`,
    '',
    `Resource URLs: ${report.resources.length}`,
  ];

  for (const resource of report.resources) {
    lines.push(`- ${resource}`);
  }

  lines.push(
    '',
    'Critical fields',
  );

  for (const field of getCriticalFields(report)) {
    lines.push(`- ${field.id}: value="${field.value}" text="${field.text}" visible=${field.visible} disabled=${field.disabled}`);
  }

  lines.push(
    '',
    `Selector candidates: ${report.candidates.length}`,
  );

  for (const [index, candidate] of report.candidates.entries()) {
    lines.push('');
    lines.push(`${index + 1}. ${candidate.tag}${candidate.type ? `[type=${candidate.type}]` : ''}`);
    if (candidate.text) lines.push(`   text: ${candidate.text}`);
    if (candidate.role) lines.push(`   role: ${candidate.role}`);
    if (candidate.name) lines.push(`   name: ${candidate.name}`);
    if (candidate.id) lines.push(`   id: ${candidate.id}`);
    if (candidate.className) lines.push(`   class: ${candidate.className}`);
    if (candidate.value) lines.push(`   value: ${candidate.value}`);
    lines.push(`   visible: ${candidate.visible}`);
    if (candidate.disabled) lines.push(`   disabled: ${candidate.disabled}`);
    if (candidate.selected) lines.push(`   selected: ${candidate.selected}`);
    if (candidate.attributes.href) lines.push(`   href: ${candidate.attributes.href}`);
    if (candidate.attributes.dataDate) lines.push(`   data-date: ${candidate.attributes.dataDate}`);
    if (candidate.attributes.dataTime) lines.push(`   data-time: ${candidate.attributes.dataTime}`);
    if (candidate.attributes.dataValue) lines.push(`   data-value: ${candidate.attributes.dataValue}`);
    if (candidate.attributes.dataMonth) lines.push(`   data-month: ${candidate.attributes.dataMonth}`);
    if (candidate.attributes.dataYear) lines.push(`   data-year: ${candidate.attributes.dataYear}`);
    if (candidate.attributes.dataHandler) lines.push(`   data-handler: ${candidate.attributes.dataHandler}`);
    if (candidate.attributes.dataTestId) lines.push(`   data-testid: ${candidate.attributes.dataTestId}`);
    if (candidate.attributes.ariaControls) lines.push(`   aria-controls: ${candidate.attributes.ariaControls}`);
    for (const selector of candidate.selectors) {
      lines.push(`   selector: ${selector}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function getCriticalFields(report) {
  const ids = new Set([
    'appointments_consulate_appointment_facility_id',
    'appointments_consulate_appointment_date',
    'appointments_consulate_appointment_time',
    'consulate_date_time',
    'consulate_date_time_not_available',
    'appointments_asc_appointment_facility_id',
    'appointments_asc_appointment_date',
    'appointments_asc_appointment_time',
    'asc_date_time',
    'asc_date_time_not_available',
    'appointments_submit',
  ]);

  return report.candidates.filter((candidate) => ids.has(candidate.id));
}

function askQuestion(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${prompt}\n`, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
