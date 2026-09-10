const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

class AISInspectionRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AISInspectionRequiredError';
  }
}

class AISClient {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.context = null;
    this.page = null;
  }

  async start() {
    if (this.context) return;

    const authDir = path.resolve(process.cwd(), 'playwright/.auth');
    fs.mkdirSync(authDir, { recursive: true });

    const launchOptions = {
      headless: this.config.headless === true,
    };

    if (this.config.browserChannel) {
      launchOptions.channel = this.config.browserChannel;
    }

    this.context = await chromium.launchPersistentContext(authDir, launchOptions);

    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  async stop() {
    if (!this.context) return;
    await this.context.close();
    this.context = null;
    this.page = null;
  }

  async ensureReady() {
    if (!this.context || !this.page || this.page.isClosed()) {
      this.log('Browser is not available, opening it again');
      await this.start();
    }
  }

  async login() {
    await this.ensureReady();

    if (!await this.hasUsableAISPage()) {
      this.log('Opening AIS');
      await this.page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
      await this.pauseAfterInteraction();
    }

    if (await this.hasActiveSession()) {
      this.log('Existing AIS session detected');
      return;
    }

    if (!this.isLoginPage()) {
      this.log('AIS did not open the login page, trying configured login URL');
      await this.page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
      await this.pauseAfterInteraction();
    }

    this.log('Filling AIS login form');
    await this.fillLoginForm();

    if (!this.isAutomaticLoginSubmitEnabled()) {
      this.log('Waiting for manual checkbox and login submit');
      await this.waitForLoginCompletion(this.config.manualLoginTimeoutMs || 180000);
      this.log('Login completed');
      return;
    }

    await this.completeAutomaticLogin();
  }

  async completeAutomaticLogin() {
    const maxAttempts = Math.max(1, Number(this.config.loginSubmitAttempts || 2));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.log(attempt === 1
        ? 'Accepting AIS policy checkbox automatically'
        : `AIS is still on the login form; retrying login (${attempt}/${maxAttempts})`
      );
      await this.acceptLoginPolicy();

      const loginResponseTimeoutMs = Number(this.config.loginSubmitResponseTimeoutMs || 10000);
      const loginSubmittedAt = Date.now();
      this.log('Submitting AIS login form');
      await this.clickLoginSubmit(
        /sign in|iniciar sesión|ingresar/i,
        this.config.selectors && this.config.selectors.signInButton
      );
      await this.pauseAfterInteraction();

      if (await this.dismissLoginInfoPopup()) {
        if (attempt < maxAttempts) {
          const retryDelayMs = Number(this.config.loginPopupRetryDelayMs || 2000);
          this.log(`AIS requested login confirmation; waiting ${retryDelayMs}ms before retrying`);
          await this.page.waitForTimeout(retryDelayMs);
          this.log('Filling AIS login form again');
          await this.fillLoginForm();
          continue;
        }
      }

      if (await this.isSecurityChallengeVisible()) {
        await this.waitForHumanIntervention('Complete the security check in the browser, then press Enter here.');
        await this.waitForLoginCompletion();
        this.log('Login completed');
        return;
      }

      const remainingAfterSubmitMs = Math.max(0, loginResponseTimeoutMs - (Date.now() - loginSubmittedAt));
      const completed = await this.waitForLoginPageExit(remainingAfterSubmitMs);
      if (completed) {
        const remainingAfterPageChangeMs = Math.max(0, loginResponseTimeoutMs - (Date.now() - loginSubmittedAt));
        await this.waitForPostLoginPageReady(remainingAfterPageChangeMs);
        this.log('Login completed');
        return;
      }

      if (attempt < maxAttempts) {
        // Refill the form in case AIS cleared its fields after the failed submit.
        this.log('Filling AIS login form again');
        await this.fillLoginForm();
      }
    }

    const loginError = await this.readLoginErrorText();
    const suffix = loginError ? ` AIS message: ${loginError}` : '';
    throw new Error(`AIS login did not complete after ${maxAttempts} attempt(s). Current URL: ${this.page.url()}.${suffix}`);
  }

  async dismissLoginInfoPopup() {
    const dialog = this.page.locator('div.ui-dialog:has(#flash_messages)').first();
    const message = await dialog.innerText({ timeout: 3000 }).catch(() => '');

    if (!/you need to sign in or sign up before continuing|debe iniciar sesión|necesita iniciar sesión/i.test(message)) {
      return false;
    }

    const acceptButton = dialog.locator('button:has-text("OK")').first();
    if (!await acceptButton.isVisible().catch(() => false)) {
      return false;
    }

    this.log('Accepting AIS login confirmation popup');
    await acceptButton.click();
    await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    return true;
  }

  async clickLoginSubmit(namePattern, selector) {
    try {
      await this.clickByRoleOrSelector(namePattern, selector);
      return;
    } catch (error) {
      this.log(`Normal login submit click failed, trying DOM click: ${error.message}`);
    }

    const fallbackSelector = selector || 'input[type="submit"], button[type="submit"]';
    const submit = this.page.locator(fallbackSelector).first();
    await submit.waitFor({ state: 'attached', timeout: 10000 });
    await submit.evaluate((element) => {
      if (element.disabled) {
        throw new Error('Login submit is disabled.');
      }
      element.click();
    });
  }

  async fillLoginForm() {
    const selectors = this.config.selectors || {};

    if (selectors.loginForm) {
      await this.page.locator(selectors.loginForm).waitFor({ state: 'visible', timeout: 15000 });
    }

    if (selectors.email) {
      await this.page.locator(selectors.email).fill(this.config.email);
    } else {
      await this.page.getByLabel(/email|correo/i).fill(this.config.email);
    }
    await this.pauseAfterInteraction();

    if (selectors.password) {
      await this.page.locator(selectors.password).fill(this.config.password);
    } else {
      await this.page.getByLabel(/password|contraseña/i).fill(this.config.password);
    }
    await this.pauseAfterInteraction();

  }

  async acceptLoginPolicy() {
    const selectors = this.config.selectors || {};
    const checkboxSelector = selectors.policyCheckbox || 'input[type="checkbox"]';
    const checkbox = this.page.locator(checkboxSelector).first();

    if (!await checkbox.count()) {
      throw new Error(`AIS policy checkbox was not found: ${checkboxSelector}`);
    }

    await checkbox.check({ force: true });

    if (!await checkbox.isChecked()) {
      throw new Error(`AIS policy checkbox could not be selected: ${checkboxSelector}`);
    }

    await this.pauseAfterInteraction();
  }

  async waitForLoginCompletion(timeout = 20000) {
    const completed = await this.waitForLoginPageExit(timeout);

    if (completed) {
      // AIS changes the URL before the dashboard has finished rendering. Let the
      // page settle so the next action does not use a partially loaded dashboard.
      await this.waitForPostLoginPageReady();
      return;
    }

    const loginError = await this.readLoginErrorText();
    const suffix = loginError ? ` AIS message: ${loginError}` : '';
    throw new Error(`AIS login did not complete. Current URL: ${this.page.url()}.${suffix}`);
  }

  async waitForLoginPageExit(timeout) {
    return this.page.waitForFunction(
      () => !/\/users\/sign_in/.test(window.location.pathname),
      null,
      { timeout }
    ).then(() => true).catch(() => false);
  }

  isAutomaticLoginSubmitEnabled() {
    return this.config.manualLoginSubmit === true;
  }

  async hasActiveSession() {
    if (!this.isLoginPage()) return true;
    return this.isLoggedIn();
  }

  isLoginPage() {
    return /\/users\/sign_in/.test(new URL(this.page.url()).pathname);
  }

  async readLoginErrorText() {
    const errorSelectors = [
      '.error',
      '.alert',
      '.flash',
      '#flash',
      '[data-alert]',
      '[role="alert"]',
    ];

    for (const selector of errorSelectors) {
      const text = await this.page.locator(selector).first().innerText({ timeout: 500 }).catch(() => '');
      if (text && text.trim()) return text.trim().replace(/\s+/g, ' ');
    }

    return '';
  }

  async getAvailableAppointments() {
    await this.login();
    await this.openAvailabilityPage();

    this.log('Checking appointments');

    if (this.hasFormSelectors('consulate')) {
      return this.getSectionAppointments('consulate');
    }

    const selector = this.requiredSelector('availabilityItem');
    await this.page.waitForSelector(selector, { timeout: 15000 });

    const items = await this.page.locator(selector).evaluateAll(
      (nodes, selectorConfig) => nodes.map((node) => ({
        text: node.innerText || node.textContent || '',
        date: node.getAttribute(selectorConfig.dateAttribute),
        time: node.getAttribute(selectorConfig.timeAttribute),
      })),
      {
        dateAttribute: this.config.selectors.availabilityDateAttribute || 'data-date',
        timeAttribute: this.config.selectors.availabilityTimeAttribute || 'data-time',
      }
    );

    return items
      .map((item) => normalizeAppointment(item))
      .filter(Boolean);
  }

  async refreshAppointmentPageBeforeScan() {
    if (this.config.refreshAppointmentPageBeforeScan === false) return;

    await this.ensureReady();
    if (!this.isAppointmentPage()) return;

    this.log('Reloading AIS appointment page before the availability scan');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.pauseAfterInteraction();
    await this.waitForAvailabilityReady();
  }

  async reschedule(target, options = {}) {
    if (options.authorizedByTelegram !== true) {
      throw new Error('Reschedule blocked because Telegram authorization was not provided.');
    }

    await this.login();
    await this.openAvailabilityPage();

    const current = this.getConfiguredCurrentAppointment();
    if (!isEarlier(target, current)) {
      throw new Error('The selected appointment is not earlier than the current appointment.');
    }

    const selectedAppointment = await this.selectAppointment(target);
    await this.waitForSubmitReady();
    await this.clickSubmitWithDialogGuard();
    await this.handlePostSubmitConfirmationIfConfigured();
    await this.waitForPostSubmitResult();

    return selectedAppointment;
  }

  async findExactAvailability(target) {
    const appointments = await this.getAvailableAppointments();
    const exactConsularAppointmentExists = appointments.some((appointment) => sameAppointment(appointment, target));

    if (!exactConsularAppointmentExists) {
      return false;
    }

    if (!this.hasFormSelectors('asc')) {
      return true;
    }

    await this.selectFormAppointment('consulate', target);
    await this.waitForDependentSection('asc');

    const ascAppointment = await this.selectFirstAvailableFormAppointment('asc');
    return Boolean(ascAppointment);
  }

  getConfiguredCurrentAppointment() {
    return {
      date: this.config.currentDate,
      time: this.config.currentTime,
    };
  }

  async openAvailabilityPage() {
    const startedAt = Date.now();
    const selectors = this.config.selectors || {};
    let openedAppointmentUrlDirectly = false;

    if (this.isAppointmentPage()) {
      openedAppointmentUrlDirectly = true;
    } else if (this.isGroupsPage() && selectors.dashboardContinue) {
      await this.clickDashboardContinue(selectors.dashboardContinue);
    } else if (this.config.appointmentUrl) {
      await this.page.goto(this.config.appointmentUrl, { waitUntil: 'domcontentloaded' });
      await this.pauseAfterInteraction();
      openedAppointmentUrlDirectly = true;

      if (this.isGroupsPage() && selectors.dashboardContinue) {
        await this.clickDashboardContinue(selectors.dashboardContinue);
        openedAppointmentUrlDirectly = false;
      }
    } else if (selectors.dashboardContinue) {
      await this.clickDashboardContinue(selectors.dashboardContinue);
    } else {
      throw new AISInspectionRequiredError(
        'Missing AIS appointmentUrl or selectors.dashboardContinue. Inspect the logged-in AIS flow and configure the real selector or URL.'
      );
    }

    if (!openedAppointmentUrlDirectly && selectors.rescheduleOpenAction && selectors.rescheduleAction) {
      const rescheduleButton = this.page.locator(selectors.rescheduleAction).first();
      const buttonIsVisible = await rescheduleButton.isVisible({ timeout: 1000 }).catch(() => false);

      if (!buttonIsVisible) {
        await this.clickWithoutNavigationWait(this.page.locator(selectors.rescheduleOpenAction).first());
        await this.pauseAfterInteraction();
      }
    }

    if (!openedAppointmentUrlDirectly && selectors.rescheduleAction) {
      await this.clickWithoutNavigationWait(this.page.locator(selectors.rescheduleAction).first());
      await this.pauseAfterInteraction();
    }

    if (await this.isSecurityChallengeVisible()) {
      await this.waitForHumanIntervention('AIS is asking for human verification before availability can be checked.');
    }

    await this.waitForAvailabilityReady();
    this.log(`AIS appointment page ready in ${Date.now() - startedAt}ms`);
  }

  async clickDashboardContinue(selector) {
    const continueButton = await this.firstVisibleDashboardContinue(selector);
    const afterClickWait = Number(this.config.dashboardContinueAfterClickWaitMs ?? 5000);
    this.log('AIS dashboard is ready, clicking the first visible Continue button');
    await continueButton.scrollIntoViewIfNeeded().catch(() => {});
    await continueButton.evaluate((element) => element.click());
    if (afterClickWait > 0) {
      await this.page.waitForTimeout(afterClickWait);
    }
  }

  async waitForPostLoginPageReady(timeoutMs = 10000) {
    let remainingMs = Math.max(0, Number(timeoutMs));
    if (!remainingMs) return;

    const startedAt = Date.now();
    await this.page.waitForLoadState('domcontentloaded', { timeout: remainingMs }).catch(() => {});
    remainingMs -= Date.now() - startedAt;
    if (remainingMs <= 0) return;

    await this.page.waitForLoadState('networkidle', { timeout: remainingMs }).catch(() => {
      this.log('AIS still has background requests; continuing after the dashboard load timeout');
    });
  }

  async firstVisibleDashboardContinue(selector) {
    const buttons = this.page.locator(selector);
    const timeout = Number(this.config.dashboardReadyTimeoutMs || 15000);
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const count = await buttons.count();

      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (await button.isVisible().catch(() => false)) {
          return button;
        }
      }

      await this.page.waitForTimeout(200);
    }

    throw new Error(`AIS dashboard did not show a visible Continue button within ${timeout}ms: ${selector}`);
  }

  async clickWithoutNavigationWait(locator) {
    await locator.waitFor({ state: 'visible', timeout: Number(this.config.dashboardReadyTimeoutMs || 5000) });
    await locator.evaluate((element) => element.click());
  }

  isGroupsPage() {
    return /\/niv\/groups\/\d+/.test(new URL(this.page.url()).pathname);
  }

  isAppointmentPage() {
    return /\/niv\/schedule\/\d+\/appointment/.test(new URL(this.page.url()).pathname);
  }

  async hasUsableAISPage() {
    if (!this.page || this.page.isClosed()) return false;

    try {
      const url = new URL(this.page.url());
      if (url.hostname !== 'ais.usvisa-info.com' || /\/users\/sign_in/.test(url.pathname)) {
        return false;
      }

      const pageText = await this.page.locator('body').innerText({ timeout: 500 }).catch(() => '');
      return !/ERR_CONNECTION_REFUSED|This site can.t be reached/i.test(pageText);
    } catch {
      return false;
    }
  }

  async waitForAvailabilityReady() {
    if (!this.hasFormSelectors('consulate')) return;

    const timeout = Number(this.config.pageScanAvailabilityReadyTimeoutMs || 3000);
    const ready = await this.isAvailabilityReady(timeout);
    if (!ready) {
      throw new Error(`AIS appointment page did not load within ${timeout}ms. Current URL: ${this.page.url()}`);
    }
  }

  async isAvailabilityReady(timeout) {
    const dateSelector = this.requiredSelector('consulateDate');
    return this.page.locator(dateSelector).first().isVisible({ timeout }).catch(() => false);
  }

  async selectAppointment(target) {
    if (this.hasFormSelectors('consulate')) {
      await this.selectFormAppointment('consulate', target);

      if (this.hasFormSelectors('asc')) {
        await this.waitForDependentSection('asc');
        const ascAppointment = target.asc || await this.selectFirstAvailableFormAppointment('asc');
        if (!ascAppointment) {
          throw new Error('No ASC appointment is available for the selected consular date.');
        }

        if (target.asc) {
          await this.selectFormAppointment('asc', ascAppointment);
        }

        return {
          ...target,
          asc: ascAppointment,
        };
      }

      return target;
    }

    const dateSelector = renderSelectorTemplate(this.requiredSelector('dateOptionTemplate'), target);
    await this.page.locator(dateSelector).click();
    await this.pauseAfterInteraction();

    const timeSelector = renderSelectorTemplate(this.requiredSelector('timeOptionTemplate'), target);
    await this.page.locator(timeSelector).click();
    await this.pauseAfterInteraction();

    return target;
  }

  hasFormSelectors(section) {
    const selectors = this.config.selectors || {};
    return Boolean(selectors[`${section}Facility`] && selectors[`${section}Date`] && selectors[`${section}Time`]);
  }

  async getSectionAppointments(section) {
    if (this.config.availabilityScanMode === 'page') {
      return this.getSectionAppointmentsFromPage(section);
    }

    try {
      return await this.getSectionAppointmentsFromApi(section);
    } catch (error) {
      this.log(`AIS availability API failed for ${section}, falling back to page datepicker: ${error.message}`);
      return this.getSectionAppointmentsFromPage(section);
    }
  }

  async getSectionAppointmentsFromApi(section) {
    const facilityId = await this.getFacilityId(section);
    const days = await this.getAvailableDays(facilityId);
    const appointments = [];

    for (const day of days) {
      const date = normalizeDate(day.date || day);
      if (!date) continue;

      const times = await this.getAvailableTimes(facilityId, date);
      for (const time of times) {
        appointments.push({ date, time });
      }
    }

    return appointments;
  }

  async getSectionAppointmentsFromPage(section) {
    if (!this.hasFormSelectors(section)) {
      throw new AISInspectionRequiredError(`Missing form selectors for ${section} appointment fallback scan.`);
    }

    if (section === 'consulate' && this.hasFormSelectors('asc')) {
      const appointment = await this.selectFirstCompleteAppointmentFromPage();
      return appointment ? [appointment] : [];
    }

    const appointment = await this.selectFirstAvailableFormAppointment(section).catch((error) => {
      this.log(`No available ${section} appointment found through the page: ${error.message}`);
      return null;
    });

    return appointment ? [appointment] : [];
  }

  async selectFirstCompleteAppointmentFromPage() {
    const maxAttempts = Number(this.config.pageScanMaxConsularDates || 8);
    let afterDate = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const consularAvailability = await this.selectAvailableDateAndReadTimes('consulate', { afterDate, scan: true }).catch((error) => {
        this.log(`No available consular appointment found through the page: ${error.message}`);
        return null;
      });

      if (!consularAvailability) return null;

      if (consularAvailability.date >= this.config.currentDate) {
        this.log(`Stopping consular scan at ${consularAvailability.date}: it is not earlier than the current appointment ${this.config.currentDate}`);
        return null;
      }

      if (!consularAvailability.times.length) {
        this.log(`Consular date ${consularAvailability.date} has no available times`);
        afterDate = consularAvailability.date;
        continue;
      }

      const consularTimeSelector = this.requiredSelector('consulateTime');
      for (const timeOption of consularAvailability.times) {
        const consularTime = await this.selectTimeOption(consularTimeSelector, timeOption, { scan: true });
        await this.dispatchInputEvents(consularTimeSelector);
        await this.pauseAfterConsularTimeSelection();

        const ascReady = await this.waitForDependentSectionOrNoAvailability('asc', {
          timeout: this.pageScanDependentTimeoutMs(),
        });

        if (!ascReady) {
          this.log(`Consular appointment ${consularAvailability.date} ${consularTime} did not enable an ASC appointment`);
          continue;
        }

        const ascAppointment = await this.selectFirstAvailableFormAppointment('asc', {
          scan: true,
          maxDates: this.pageScanMaxAscDates(),
          requireSubmitReady: true,
        }).catch((error) => {
          this.log(`No available ASC appointment found for consular ${consularAvailability.date} ${consularTime}: ${error.message}`);
          return null;
        });

        if (ascAppointment) {
          return {
            date: consularAvailability.date,
            time: consularTime,
            asc: ascAppointment,
          };
        }
      }

      afterDate = consularAvailability.date;
    }

    this.log(`No complete consular/CAS appointment found after checking ${maxAttempts} consular dates`);
    return null;
  }

  async findEarliestAscAppointment() {
    try {
      return await this.selectFirstAvailableFormAppointment('asc');
    } catch (error) {
      this.log(`ASC appointment lookup through the page failed: ${error.message}`);
    }

    const appointments = await this.getSectionAppointments('asc').catch(() => []);
    return appointments.sort((left, right) => appointmentTimestamp(left) - appointmentTimestamp(right))[0] || null;
  }

  async getFacilityId(section) {
    const selector = this.requiredSelector(`${section}Facility`);
    await this.page.locator(selector).waitFor({ state: 'attached', timeout: 15000 });
    const facilityId = await this.page.locator(selector).inputValue();

    if (!facilityId) {
      throw new Error(`Could not read ${section} facility id.`);
    }

    return facilityId;
  }

  async getAvailableDays(facilityId) {
    const url = `${this.getAppointmentBasePath()}/days/${facilityId}.json?appointments%5Bexpedite%5D=false`;
    const data = await this.fetchJsonFromPage(url);
    const days = Array.isArray(data) ? data : data.available_days || data.days || [];
    return days.filter((day) => day && day.business_day !== false);
  }

  async getAvailableTimes(facilityId, date) {
    const url = `${this.getAppointmentBasePath()}/times/${facilityId}.json?date=${encodeURIComponent(date)}&appointments%5Bexpedite%5D=false`;
    const data = await this.fetchJsonFromPage(url);
    const times = data.available_times || data.business_times || data.times || [];
    return times
      .map((time) => normalizeTime(time))
      .filter(Boolean);
  }

  getAppointmentBasePath() {
    const pathname = new URL(this.page.url()).pathname;
    const match = pathname.match(/^(\/[a-z]{2}-[a-z]{2}\/niv\/schedule\/\d+\/appointment)/);

    if (!match) {
      throw new Error(`Could not derive AIS appointment base path from URL: ${this.page.url()}`);
    }

    return match[1];
  }

  async fetchJsonFromPage(pathname) {
    return this.page.evaluate(async (path) => {
      const response = await fetch(path, {
        headers: {
          accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Request failed ${response.status}: ${path}`);
      }

      return response.json();
    }, pathname);
  }

  async selectFormAppointment(section, appointment) {
    const dateSelector = this.requiredSelector(`${section}Date`);
    const timeSelector = this.requiredSelector(`${section}Time`);

    await this.waitForFormField(section, 'Date');
    await this.selectDate(dateSelector, appointment.date);

    await this.waitForFormField(section, 'Time');
    await this.waitForTimeOption(timeSelector, appointment.time);
    await this.selectTime(timeSelector, appointment.time);
    await this.dispatchInputEvents(timeSelector);
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  async selectFirstAvailableFormAppointment(section, options = {}) {
    const fieldTimeout = options.fieldTimeout || (options.scan ? this.pageScanFieldTimeoutMs() : undefined);
    const timeOptionTimeout = options.timeOptionTimeout || (options.scan ? this.pageScanTimeOptionTimeoutMs() : undefined);
    const maxDates = Number(options.maxDates || 1);
    let afterDate = options.afterDate || null;

    for (let attempt = 0; attempt < maxDates; attempt += 1) {
      const availability = await this.selectAvailableDateAndReadTimes(section, {
        ...options,
        afterDate,
        fieldTimeout,
        timeOptionTimeout,
      });

      const timeSelector = this.requiredSelector(`${section}Time`);
      for (const timeOption of availability.times) {
        const time = await this.selectTimeOption(timeSelector, timeOption, options);
        await this.dispatchInputEvents(this.requiredSelector(`${section}Time`));

        if (options.requireSubmitReady) {
          const ready = await this.isSubmitReady(this.pageScanSubmitReadyTimeoutMs());
          if (!ready) {
            this.log(`${section} appointment ${availability.date} ${time} did not leave the form ready`);
            continue;
          }
        }

        if (!options.scan) {
          await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        }

        return { date: availability.date, time };
      }

      if (availability.times.length) {
        this.log(`${section} date ${availability.date} had ${availability.times.length} time option(s), but none completed the form`);
      } else {
        this.log(`${section} date ${availability.date} has no available times`);
      }
      afterDate = availability.date;
    }

    throw new Error(`No available ${section} date/time combination found after checking ${maxDates} dates.`);
  }

  async selectAvailableDateAndReadTimes(section, options = {}) {
    const fieldTimeout = options.fieldTimeout || (options.scan ? this.pageScanFieldTimeoutMs() : undefined);
    const timeOptionTimeout = options.timeOptionTimeout || (options.scan ? this.pageScanTimeOptionTimeoutMs() : undefined);

    const dateSelector = this.requiredSelector(`${section}Date`);
    const timeSelector = this.requiredSelector(`${section}Time`);

    await this.openDatePicker(dateSelector, { ...options, timeout: fieldTimeout });
    const date = await this.selectFirstAvailableDateWithDatepicker(options.afterDate, options);
    await this.dispatchInputEvents(dateSelector);

    if (options.scan && section === 'consulate') {
      await this.pauseAfterConsularDateSelection();
    }

    const timeReady = await this.isFormFieldReady(section, 'Time', fieldTimeout || 20000);
    if (!timeReady) {
      return { date, times: [] };
    }

    const times = await this.getAvailableTimeOptions(timeSelector, { timeout: timeOptionTimeout })
      .catch(() => []);

    return { date, times };
  }

  async waitForDependentSection(section, options = {}) {
    const containerSelector = this.config.selectors[`${section}DateTime`];
    const timeout = options.timeout || 20000;

    if (containerSelector) {
      await this.page.waitForFunction(
        (selector) => {
          const element = document.querySelector(selector);
          if (!element) return false;

          const styles = window.getComputedStyle(element);
          return element.offsetParent !== null && styles.display !== 'none' && styles.visibility !== 'hidden';
        },
        containerSelector,
        { timeout }
      );
    }

    await this.waitForFormField(section, 'Date', { timeout });
  }

  async waitForDependentSectionOrNoAvailability(section, options = {}) {
    const timeout = options.timeout || 20000;
    const messageDelay = Number(this.config.pageScanNoAvailabilityMessageDelayMs || 1500);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      if (await this.isFormFieldReady(section, 'Date', 300)) {
        return true;
      }

      if (Date.now() - startedAt >= messageDelay && await this.isNoAvailabilityMessageVisible()) {
        return false;
      }

      await this.page.waitForTimeout(300);
    }

    return false;
  }

  async waitForFormField(section, field, options = {}) {
    const selector = this.requiredSelector(`${section}${field}`);
    const timeout = options.timeout || 20000;

    const ready = await this.page.waitForFunction(
      (fieldSelector) => {
        const element = document.querySelector(fieldSelector);
        if (!element) return false;

        const styles = window.getComputedStyle(element);
        return !element.disabled && element.offsetParent !== null && styles.display !== 'none' && styles.visibility !== 'hidden';
      },
      selector,
      { timeout }
    ).then(() => true).catch(() => false);

    if (!ready) {
      throw new Error(`${section}${field} field was not ready within ${timeout}ms.`);
    }
  }

  async isFormFieldReady(section, field, timeout = 300) {
    const selector = this.requiredSelector(`${section}${field}`);

    return this.page.waitForFunction(
      (fieldSelector) => {
        const element = document.querySelector(fieldSelector);
        if (!element) return false;

        const styles = window.getComputedStyle(element);
        return !element.disabled && element.offsetParent !== null && styles.display !== 'none' && styles.visibility !== 'hidden';
      },
      selector,
      { timeout }
    ).then(() => true).catch(() => false);
  }

  async isNoAvailabilityMessageVisible() {
    const text = await this.page.locator('body').innerText({ timeout: 500 }).catch(() => '');
    return /no hay citas disponibles|no existen citas|no appointments available|no hay horarios disponibles|no hay horas disponibles|no hay citas/i.test(text);
  }

  async selectDate(selector, date) {
    await this.openDatePicker(selector);

    const selectedWithDatepicker = await this.selectDateWithDatepicker(date).catch((error) => {
      this.log(`Datepicker selection failed, trying direct input: ${error.message}`);
      return false;
    });

    if (!selectedWithDatepicker) {
      await this.page.locator(selector).fill(date);
      await this.pauseAfterInteraction();
    }

    await this.dispatchInputEvents(selector);
  }

  async openDatePicker(selector, options = {}) {
    const timeout = options.timeout || (options.scan ? this.pageScanDatePickerOpenTimeoutMs() : 10000);
    const rootSelector = this.config.selectors.datePicker || '#ui-datepicker-div';
    const field = this.page.locator(selector).first();

    await field.waitFor({ state: 'visible', timeout });
    await field.scrollIntoViewIfNeeded().catch(() => {});
    await field.click({ timeout });
    await this.pauseAfterInteractionForOptions(options);

    const opened = await this.page.locator(rootSelector).first().isVisible({ timeout }).catch(() => false);
    if (!opened) {
      throw new Error(`Datepicker did not open for ${selector} within ${timeout}ms.`);
    }
  }

  async selectDateWithDatepicker(date) {
    const [year, month, day] = date.split('-').map(Number);
    const rootSelector = this.config.selectors.datePicker || '#ui-datepicker-div';
    const nextSelector = this.config.selectors.datePickerNext || '#ui-datepicker-div a.ui-datepicker-next';
    const maxNextClicks = this.pageScanMaxDatePickerNextClicks();
    let nextClicks = 0;

    while (true) {
      const result = await this.page.evaluate(({ root, target }) => {
        const rootElement = document.querySelector(root);
        if (!rootElement || rootElement.offsetParent === null) return 'missing';

        const monthIndexes = {
          january: 1,
          february: 2,
          march: 3,
          april: 4,
          may: 5,
          june: 6,
          july: 7,
          august: 8,
          september: 9,
          october: 10,
          november: 11,
          december: 12,
          enero: 1,
          febrero: 2,
          marzo: 3,
          abril: 4,
          mayo: 5,
          junio: 6,
          julio: 7,
          agosto: 8,
          septiembre: 9,
          octubre: 10,
          noviembre: 11,
          diciembre: 12,
        };

        for (const group of rootElement.querySelectorAll('.ui-datepicker-group')) {
          const monthName = group.querySelector('.ui-datepicker-month')?.textContent.trim().toLowerCase();
          const visibleMonth = monthIndexes[monthName];
          const visibleYear = Number(group.querySelector('.ui-datepicker-year')?.textContent.trim());

          if (visibleMonth !== target.month || visibleYear !== target.year) continue;

          const dayLink = Array.from(group.querySelectorAll('td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default'))
            .find((link) => Number(link.textContent.trim()) === target.day);

          if (!dayLink) return 'disabled';

          dayLink.click();
          return 'selected';
        }

        return 'not-visible';
      }, {
        root: rootSelector,
        target: { year, month, day },
      });

      if (result === 'selected') {
        await this.pauseAfterInteraction();
        return true;
      }
      if (result === 'missing') return false;
      if (result === 'disabled') {
        throw new Error(`Date ${date} is visible but disabled in the datepicker.`);
      }

      const next = this.page.locator(nextSelector).first();
      const canGoNext = await next.isVisible({ timeout: 1000 }).catch(() => false);
      if (!canGoNext) return false;

      if (nextClicks >= maxNextClicks) {
        const message = `Date ${date} was not found after ${maxNextClicks} datepicker next click(s).`;
        this.log(message);
        throw new Error(message);
      }

      await next.click();
      nextClicks += 1;
      await this.pauseAfterInteraction();
      await this.page.waitForTimeout(250);
    }
  }

  async selectFirstAvailableDateWithDatepicker(afterDate = null, options = {}) {
    const rootSelector = this.config.selectors.datePicker || '#ui-datepicker-div';
    const nextSelector = this.config.selectors.datePickerNext || '#ui-datepicker-div a.ui-datepicker-next';
    const maxNextClicks = this.pageScanMaxDatePickerNextClicks();
    let nextClicks = 0;

    while (true) {
      const selectedDate = await this.page.evaluate(({ root, after }) => {
        const rootElement = document.querySelector(root);
        if (!rootElement || rootElement.offsetParent === null) return null;

        const monthIndexes = {
          january: 1,
          february: 2,
          march: 3,
          april: 4,
          may: 5,
          june: 6,
          july: 7,
          august: 8,
          september: 9,
          october: 10,
          november: 11,
          december: 12,
          enero: 1,
          febrero: 2,
          marzo: 3,
          abril: 4,
          mayo: 5,
          junio: 6,
          julio: 7,
          agosto: 8,
          septiembre: 9,
          octubre: 10,
          noviembre: 11,
          diciembre: 12,
        };

        for (const group of rootElement.querySelectorAll('.ui-datepicker-group')) {
          const monthName = group.querySelector('.ui-datepicker-month')?.textContent.trim().toLowerCase();
          const month = monthIndexes[monthName];
          const year = Number(group.querySelector('.ui-datepicker-year')?.textContent.trim());

          if (!month || !year) continue;

          const dayLinks = Array.from(group.querySelectorAll(
            'td:not(.ui-datepicker-other-month):not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default'
          ));

          for (const dayLink of dayLinks) {
            const day = Number(dayLink.textContent.trim());
            const candidateDate = [
              year,
              String(month).padStart(2, '0'),
              String(day).padStart(2, '0'),
            ].join('-');

            if (after && candidateDate <= after) continue;

            dayLink.click();

            return candidateDate;
          }
        }

        return null;
      }, { root: rootSelector, after: afterDate });

      if (selectedDate) {
        await this.pauseAfterInteractionForOptions(options);
        return selectedDate;
      }

      const next = this.page.locator(nextSelector).first();
      const canGoNext = await next.isVisible({ timeout: 1000 }).catch(() => false);
      if (!canGoNext) break;

      if (nextClicks >= maxNextClicks) {
        const message = `No selectable date found after ${maxNextClicks} datepicker next click(s).`;
        this.log(message);
        throw new Error(message);
      }

      await next.click();
      nextClicks += 1;
      await this.pauseAfterInteractionForOptions(options);
      await this.page.waitForTimeout(250);
    }

    throw new Error('No available date was found in the datepicker.');
  }

  async dispatchInputEvents(selector) {
    await this.page.locator(selector).evaluate((element) => {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async waitForTimeOption(selector, time) {
    await this.page.waitForFunction(
      ({ selectSelector, expectedTime }) => {
        const select = document.querySelector(selectSelector);
        if (!select) return false;
        return Array.from(select.options).some((option) => (
          option.value === expectedTime || option.textContent.trim() === expectedTime
        ));
      },
      { selectSelector: selector, expectedTime: time },
      { timeout: 15000 }
    );
  }

  async waitForAnyTimeOption(selector, options = {}) {
    const timeout = options.timeout || 15000;

    await this.page.waitForFunction(
      (selectSelector) => {
        const select = document.querySelector(selectSelector);
        if (!select) return false;
        return Array.from(select.options).some((option) => /\d{1,2}:\d{2}/.test(option.value || option.textContent));
      },
      selector,
      { timeout }
    );
  }

  async selectEarliestAvailableTime(selector, options = {}) {
    const option = (await this.getAvailableTimeOptions(selector, options))[0];

    if (!option) {
      throw new Error(`No available time option found for ${selector}.`);
    }

    return this.selectTimeOption(selector, option, options);
  }

  async getAvailableTimeOptions(selector, options = {}) {
    const timeout = options.timeout || 15000;
    await this.waitForAnyTimeOption(selector, { timeout });

    return this.page.locator(selector).evaluate((select) => {
      return Array.from(select.options)
        .map((item) => ({
          value: item.value,
          label: item.textContent.trim(),
        }))
        .filter((item) => /\d{1,2}:\d{2}/.test(item.value || item.label));
    });
  }

  async selectTimeOption(selector, option, options = {}) {
    const time = normalizeTime(option.value) || normalizeTime(option.label);
    const optionValue = normalizeTime(option.value) ? option.value : null;

    if (!time) {
      throw new Error(`Invalid time option for ${selector}.`);
    }

    if (optionValue) {
      await this.page.locator(selector).selectOption(optionValue).catch(async () => {
        await this.page.locator(selector).selectOption({ label: option.label });
      });
      await this.pauseAfterInteractionForOptions(options);
      return time;
    }

    await this.page.locator(selector).selectOption({ label: option.label });
    await this.pauseAfterInteractionForOptions(options);

    return time;
  }

  async waitForSubmitReady() {
    const ready = await this.isSubmitReady(20000);
    if (!ready) {
      throw new Error('Reschedule submit button was not ready within 20000ms.');
    }
  }

  async isSubmitReady(timeout = 3000) {
    const selectors = this.config.selectors || {};
    const submitSelector = this.requiredSelector('submitReschedule');

    return this.page.waitForFunction(
      ({ submit, consulateDate, consulateTime, ascDate, ascTime }) => {
        const submitElement = document.querySelector(submit);
        if (!submitElement) return false;

        const fields = [consulateDate, consulateTime, ascDate, ascTime]
          .filter(Boolean)
          .map((selector) => document.querySelector(selector));

        const allFieldsHaveValues = fields.every((field) => field && field.value);
        const submitStyles = window.getComputedStyle(submitElement);

        return (
          allFieldsHaveValues &&
          !submitElement.disabled &&
          submitElement.offsetParent !== null &&
          submitStyles.display !== 'none' &&
          submitStyles.visibility !== 'hidden'
        );
      },
      {
        submit: submitSelector,
        consulateDate: selectors.consulateDate,
        consulateTime: selectors.consulateTime,
        ascDate: selectors.ascDate,
        ascTime: selectors.ascTime,
      },
      { timeout }
    ).then(() => true).catch(() => false);
  }

  async handlePostSubmitConfirmationIfConfigured() {
    const selector = this.config.selectors && this.config.selectors.postSubmitConfirmAction;
    if (!selector) {
      await this.failIfUnknownConfirmationAppears();
      return;
    }

    const confirm = this.page.locator(selector).first();
    const visible = await confirm.isVisible({ timeout: 10000 }).catch(() => false);
    if (visible) {
      this.log('Confirming AIS post-submit reschedule dialog');
      await confirm.click();
      await this.pauseAfterInteraction();
      return;
    }

    await this.failIfUnknownConfirmationAppears();
  }

  async waitForPostSubmitResult() {
    const timeout = Number(this.config.postSubmitResultTimeoutMs || 45000);
    const startedAt = Date.now();
    const successSelector = this.config.selectors && this.config.selectors.successMessage;

    while (Date.now() - startedAt < timeout) {
      if (successSelector) {
        const successVisible = await this.page.locator(successSelector).first().isVisible({ timeout: 500 }).catch(() => false);
        if (successVisible) {
          this.log('AIS reschedule success message detected');
          return;
        }
      }

      const bodyText = await this.page.locator('body').innerText({ timeout: 500 }).catch(() => '');
      if (/usted ha programado exitosamente su cita de visa/i.test(bodyText)) {
        this.log('AIS reschedule success text detected');
        return;
      }

      const failure = this.extractPostSubmitFailure(bodyText);
      if (failure) {
        throw new Error(`AIS reschedule failed: ${failure}`);
      }

      await this.page.waitForTimeout(500);
    }

    throw new Error(`AIS did not show a reschedule result within ${timeout}ms. Current URL: ${this.page.url()}`);
  }

  extractPostSubmitFailure(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const patterns = [
      /el sistema est[aá] ocupado\.?\s*por favor,? int[eé]ntelo de nuevo m[aá]s tarde/i,
      /no hay citas disponibles/i,
      /no existen citas disponibles/i,
      /no fue posible/i,
      /se produjo un error/i,
      /error al/i,
    ];

    const match = patterns
      .map((pattern) => normalized.match(pattern))
      .find(Boolean);

    return match ? match[0] : '';
  }

  async clickSubmitWithDialogGuard() {
    const dialogPromise = this.page.waitForEvent('dialog', { timeout: 5000 })
      .then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        throw new AISInspectionRequiredError(
          `AIS displayed a native confirmation dialog after submit: ${message}. Automatic confirmation is not configured.`
        );
      })
      .catch((error) => {
        if (error.name === 'TimeoutError') return null;
        throw error;
      });

    await this.page.locator(this.requiredSelector('submitReschedule')).click();
    await this.pauseAfterInteraction();
    await dialogPromise;
  }


  async failIfUnknownConfirmationAppears() {
    const modalSelector = [
      '#modal',
      '.reveal',
      '.modal',
      '[role="dialog"]',
      'button:has-text("Confirmar")',
      'button:has-text("Aceptar")',
      'a:has-text("Confirmar")',
      'a:has-text("Aceptar")',
    ].join(', ');

    const modal = this.page.locator(modalSelector).first();
    const visible = await modal.isVisible({ timeout: 3000 }).catch(() => false);

    if (visible) {
      throw new AISInspectionRequiredError(
        'AIS displayed a post-submit confirmation. Inspect that popup and configure selectors.postSubmitConfirmAction before automatic confirmation.'
      );
    }
  }

  async selectTime(selector, time) {
    await this.page.locator(selector).selectOption(time).catch(async () => {
      await this.page.locator(selector).selectOption({ label: time });
    });
    await this.pauseAfterInteraction();
  }

  async pauseAfterInteraction() {
    const delayMs = Number(this.config.interactionDelayMs || 0);
    if (delayMs > 0) {
      await this.page.waitForTimeout(delayMs);
    }
  }

  async pauseAfterScanInteraction() {
    const fallbackDelay = Math.min(Number(this.config.interactionDelayMs || 0), 250);
    const delayMs = Number(this.config.pageScanInteractionDelayMs ?? fallbackDelay);
    if (delayMs > 0) {
      await this.page.waitForTimeout(delayMs);
    }
  }

  async pauseAfterConsularDateSelection() {
    const delayMs = Number(this.config.pageScanConsularDateSelectionDelayMs ?? 2000);
    if (delayMs > 0) await this.page.waitForTimeout(delayMs);
  }

  async pauseAfterConsularTimeSelection() {
    const delayMs = Number(this.config.pageScanConsularTimeSelectionDelayMs ?? 2000);
    if (delayMs > 0) await this.page.waitForTimeout(delayMs);
  }

  async pauseAfterInteractionForOptions(options = {}) {
    if (options.scan) {
      await this.pauseAfterScanInteraction();
      return;
    }

    await this.pauseAfterInteraction();
  }

  pageScanDependentTimeoutMs() {
    return Number(this.config.pageScanDependentTimeoutMs || 3000);
  }

  pageScanDatePickerOpenTimeoutMs() {
    return Number(this.config.pageScanDatePickerOpenTimeoutMs || 3000);
  }

  pageScanFieldTimeoutMs() {
    return Number(this.config.pageScanFieldTimeoutMs || 4000);
  }

  pageScanTimeOptionTimeoutMs() {
    return Number(this.config.pageScanTimeOptionTimeoutMs || 8000);
  }

  pageScanSubmitReadyTimeoutMs() {
    return Number(this.config.pageScanSubmitReadyTimeoutMs || 3000);
  }

  pageScanMaxAscDates() {
    return Number(this.config.pageScanMaxAscDates || 8);
  }

  pageScanMaxDatePickerNextClicks() {
    const configured = Number(this.config.pageScanMaxDatePickerNextClicks ?? 6);
    return Number.isFinite(configured) ? Math.max(0, configured) : 6;
  }

  async isLoggedIn() {
    const marker = this.config.selectors && this.config.selectors.loggedInMarker;
    if (!marker) return false;
    return this.page.locator(marker).first().isVisible({ timeout: 1500 }).catch(() => false);
  }

  async isSecurityChallengeVisible() {
    const captchaSelector = this.config.selectors && this.config.selectors.captchaContainer;
    if (captchaSelector) {
      const hasCaptchaContent = await this.page.locator(captchaSelector).evaluate((element) => {
        if (!element) return false;

        const styles = window.getComputedStyle(element);
        if (element.offsetParent === null || styles.display === 'none' || styles.visibility === 'hidden') {
          return false;
        }

        const text = element.innerText || element.textContent || '';
        return Boolean(
          element.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], textarea[name*="captcha"], input[name*="captcha"], [role="checkbox"]') ||
          /recaptcha|hcaptcha|captcha/i.test(text)
        );
      }).catch(() => false);

      if (hasCaptchaContent) return true;
    }

    const body = await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return /captcha|recaptcha|hcaptcha|mfa|two[-\s]?factor|security check|verificación de seguridad|verificación humana/i.test(body);
  }

  async waitForHumanIntervention(message) {
    this.log(message);
    await waitForEnter('Complete the manual step in the browser, then press Enter to continue...');
  }

  async clickByRoleOrSelector(namePattern, selector) {
    if (selector) {
      const target = this.page.locator(selector).first();
      await target.waitFor({ state: 'attached', timeout: 6000 });
      await target.scrollIntoViewIfNeeded().catch(() => {});

      const visible = await target.isVisible({ timeout: 5000 }).catch(() => false);
      const enabled = await target.isEnabled({ timeout: 5000 }).catch(() => false);

      if (!visible) {
        throw new Error(`Configured selector is not visible: ${selector}`);
      }

      if (!enabled) {
        throw new Error(`Configured selector is disabled: ${selector}`);
      }

      await target.evaluate((element) => element.click());
      return;
    }

    const button = this.page.getByRole('button', { name: namePattern });
    if (await button.count()) {
      const target = button.first();
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.evaluate((element) => element.click());
      return;
    }

    const submit = this.page.locator('input[type="submit"], button[type="submit"]').first();
    await submit.waitFor({ state: 'visible', timeout: 10000 });
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click({ timeout: 10000 });
  }

  requiredSelector(name) {
    const value = this.config.selectors && this.config.selectors[name];
    if (!value) {
      throw new AISInspectionRequiredError(
        `Missing AIS selector: ${name}. Inspect the real portal while logged in and add it to config.json.`
      );
    }
    return value;
  }
}

function normalizeAppointment(item) {
  const date = normalizeDate(item.date) || normalizeDateFromText(item.text);
  const time = normalizeTime(item.time) || normalizeTimeFromText(item.text);

  if (!date || !time) return null;
  return { date, time };
}

function normalizeDate(value) {
  if (!value) return null;
  const trimmed = String(value).trim();

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return trimmed;

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, day, month, year] = slash;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

function normalizeTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function normalizeDateFromText(text) {
  const iso = String(text).match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return normalizeDate(iso[1]);

  const slash = String(text).match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (slash) return normalizeDate(slash[1]);

  return null;
}

function normalizeTimeFromText(text) {
  const match = String(text).match(/(\d{1,2}:\d{2})/);
  return match ? normalizeTime(match[1]) : null;
}

function isEarlier(candidate, current) {
  return appointmentTimestamp(candidate) < appointmentTimestamp(current);
}

function appointmentTimestamp(appointment) {
  return new Date(`${appointment.date}T${appointment.time || '00:00'}:00`).getTime();
}

function sameAppointment(left, right) {
  return left.date === right.date && left.time === right.time;
}

function renderSelectorTemplate(template, appointment) {
  return template
    .replaceAll('{{date}}', appointment.date)
    .replaceAll('{{time}}', appointment.time);
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${prompt}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

module.exports = {
  AISClient,
  AISInspectionRequiredError,
  isEarlier,
  sameAppointment,
};
