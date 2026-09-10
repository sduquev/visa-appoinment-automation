const fs = require('fs');
const { isEarlier, sameAppointment } = require('./ais');

class AppointmentMonitor {
  constructor({ ais, telegram, config, statePath, log }) {
    this.ais = ais;
    this.telegram = telegram;
    this.config = config;
    this.statePath = statePath;
    this.log = log;
    this.running = false;
    this.checking = false;
    this.timer = null;
  }

  start() {
    this.running = true;
    this.telegram.setRescheduleHandler((appointment) => this.handleRescheduleRequest(appointment));
    this.telegram.setSkipRescheduleHandler((appointment) => this.handleSkipRescheduleRequest(appointment));
    this.scheduleNextCheck(0);
  }

  stop() {
    this.running = false;
    this.telegram.stop();
    if (this.timer) clearTimeout(this.timer);
  }

  async checkOnce() {
    if (this.checking) {
      this.log('Skipping check because another AIS query is still running');
      return;
    }

    this.checking = true;
    try {
      await this.ais.refreshAppointmentPageBeforeScan();
      const appointments = await this.ais.getAvailableAppointments();
      const current = this.getCurrentAppointment();
      const earliest = findEarliestEarlierAppointment(appointments, current);

      if (!earliest) {
        this.log('No earlier appointment found');
        this.clearLastNotificationIfNeeded();
        return;
      }

      this.log(`Earlier appointment found: ${earliest.date} ${earliest.time}`);

      const state = this.readState();
      if (state.lastNotification && sameAppointment(state.lastNotification, earliest)) {
        this.log('Appointment was already notified');
        return;
      }

      try {
        await this.telegram.sendAppointmentAlert(earliest, current);
        this.telegram.startPolling();
        this.log('Waiting for a Telegram decision; callback polling is active');
      } catch (error) {
        this.log(`Telegram notification failed: ${error.message}`);
        return;
      }

      this.writeState({ ...state, lastNotification: earliest });
      this.log('Telegram notification sent');
    } catch (error) {
      this.log(`Availability check failed: ${error.message}`);
    } finally {
      this.checking = false;
    }
  }

  async handleRescheduleRequest(appointment) {
    this.log(`Reschedule requested from Telegram: ${appointment.date} ${appointment.time}`);
    await this.telegram.sendRescheduleProcessing(appointment).catch((error) => {
      this.log(`Telegram processing notification failed: ${error.message}`);
    });

    if (this.checking) {
      this.log('Waiting for active AIS query to finish before rescheduling');
      await waitUntil(() => !this.checking);
    }

    let restartChecks = false;
    this.checking = true;
    try {
      const current = this.getCurrentAppointment();
      if (!isEarlier(appointment, current)) {
        throw new Error('Requested appointment is not earlier than the current appointment.');
      }

      this.log('Submitting the Telegram-selected appointment without another availability check');
      const rescheduledAppointment = await this.ais.reschedule(appointment, { authorizedByTelegram: true });

      const state = this.readState();
      this.writeState({
        ...state,
        currentAppointment: rescheduledAppointment,
        lastNotification: rescheduledAppointment,
      });

      await this.telegram.sendRescheduleSuccess(rescheduledAppointment, current).catch((error) => {
        this.log(`Telegram success notification failed: ${error.message}`);
      });
      this.log(`Reschedule completed: ${rescheduledAppointment.date} ${rescheduledAppointment.time}`);
    } catch (error) {
      this.log(`Reschedule failed: ${error.message}`);
      await this.telegram.sendRescheduleError(error).catch((telegramError) => {
        this.log(`Telegram failure notification failed: ${telegramError.message}`);
      });
      restartChecks = true;
    } finally {
      this.checking = false;
    }

    if (restartChecks) {
      this.log('Restarting appointment checks after reschedule failure');
      this.scheduleNextCheck(0);
    }
  }

  async handleSkipRescheduleRequest(appointment) {
    this.log(`User chose not to reschedule: ${appointment.date} ${appointment.time}`);
    await this.telegram.sendNoRescheduleConfirmation(appointment).catch((error) => {
      this.log(`Telegram no-reschedule notification failed: ${error.message}`);
    });
  }

  scheduleNextCheck(delayMs) {
    if (!this.running) return;

    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.checkOnce();
      this.scheduleNextCheck(this.intervalMs());
    }, delayMs);
  }

  intervalMs() {
    const minutes = Number(this.config.monitor.intervalMinutes || 5);
    return Math.max(minutes, 1) * 60 * 1000;
  }

  getCurrentAppointment() {
    const state = this.readState();
    const appointment = state.currentAppointment || this.config.appointment;

    return {
      date: appointment.date || appointment.currentDate,
      time: appointment.time || appointment.currentTime,
      ascDate: appointment.ascDate || appointment.currentAscDate || appointment.asc?.date,
      ascTime: appointment.ascTime || appointment.currentAscTime || appointment.asc?.time,
      city: this.config.appointment.city,
      visaType: this.config.appointment.visaType,
    };
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return { lastNotification: null };
    }
  }

  writeState(state) {
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  clearLastNotificationIfNeeded() {
    const state = this.readState();
    if (!state.lastNotification) return;
    this.writeState({ ...state, lastNotification: null });
  }
}

function findEarliestEarlierAppointment(appointments, current) {
  return appointments
    .filter((appointment) => isEarlier(appointment, current))
    .sort((left, right) => appointmentTimestamp(left) - appointmentTimestamp(right))[0] || null;
}

function appointmentTimestamp(appointment) {
  return new Date(`${appointment.date}T${appointment.time || '00:00'}:00`).getTime();
}

function waitUntil(predicate) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!predicate()) return;
      clearInterval(timer);
      resolve();
    }, 500);
  });
}

module.exports = {
  AppointmentMonitor,
  findEarliestEarlierAppointment,
};
