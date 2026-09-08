class TelegramBot {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.offset = 0;
    this.running = false;
    this.onReschedule = null;
  }

  setRescheduleHandler(handler) {
    this.onReschedule = handler;
  }

  async sendAppointmentAlert(appointment, current) {
    const text = [
      '🚨 NUEVA CITA DISPONIBLE',
      '',
      `📍 ${current.city}`,
      `🎫 ${current.visaType}`,
      '',
      'Nueva cita:',
      `📅 ${formatDateForMessage(appointment.date)}`,
      `🕐 ${appointment.time}`,
      appointment.asc ? '' : null,
      appointment.asc ? 'Cita CAS disponible:' : null,
      appointment.asc ? `📅 ${formatDateForMessage(appointment.asc.date)}` : null,
      appointment.asc ? `🕐 ${appointment.asc.time}` : null,
      '',
      'Cita actual:',
      `📅 ${formatDateForMessage(current.date)}`,
      `🕐 ${current.time}`,
      current.ascDate && current.ascTime ? '' : null,
      current.ascDate && current.ascTime ? 'Cita CAS actual:' : null,
      current.ascDate && current.ascTime ? `📅 ${formatDateForMessage(current.ascDate)}` : null,
      current.ascDate && current.ascTime ? `🕐 ${current.ascTime}` : null,
    ].filter((line) => line !== null).join('\n');

    await this.call('sendMessage', {
      chat_id: this.config.chatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🔄 REAGENDAR',
            callback_data: `reschedule:${appointment.date}:${appointment.time}`,
          },
        ]],
      },
    });
  }

  async sendRescheduleSuccess(appointment, current) {
    const text = [
      '✅ CITA REAGENDADA',
      '',
      `📍 ${current.city}`,
      'Cita Consular:',
      `📅 ${formatDateForMessage(appointment.date)}`,
      `🕐 ${appointment.time}`,
      appointment.asc ? '' : null,
      appointment.asc ? 'Cita CAS:' : null,
      appointment.asc ? `📅 ${formatDateForMessage(appointment.asc.date)}` : null,
      appointment.asc ? `🕐 ${appointment.asc.time}` : null,
    ].filter((line) => line !== null).join('\n');

    await this.sendMessage(text);
  }

  async sendNoLongerAvailable() {
    await this.sendMessage([
      '❌ LA CITA YA NO ESTÁ DISPONIBLE',
      '',
      'La oportunidad fue tomada antes de completar el reagendamiento.',
    ].join('\n'));
  }

  async sendRescheduleError(error) {
    await this.sendMessage([
      '⚠️ ERROR AL REAGENDAR',
      '',
      'No fue posible completar el cambio.',
      'Revisar el navegador para determinar el estado actual.',
      '',
      `Detalle: ${error.message}`,
    ].join('\n'));
  }

  async sendMessage(text) {
    await this.call('sendMessage', {
      chat_id: this.config.chatId,
      text,
    });
  }

  startPolling() {
    if (this.running) return;
    this.running = true;
    this.poll().catch((error) => {
      this.log(`Telegram polling stopped: ${error.message}`);
    });
  }

  stop() {
    this.running = false;
  }

  async poll() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['callback_query'],
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.log(`Telegram polling error: ${error.message}`);
        await sleep(5000);
      }
    }
  }

  async handleUpdate(update) {
    const callback = update.callback_query;
    if (!callback) return;

    const chatId = callback.message && callback.message.chat && callback.message.chat.id;
    if (String(chatId) !== String(this.config.chatId)) {
      return;
    }

    await this.call('answerCallbackQuery', {
      callback_query_id: callback.id,
    });

    const appointment = parseCallbackData(callback.data);
    if (!appointment || !this.onReschedule) return;

    await this.onReschedule(appointment);
  }

  async call(method, payload) {
    const retries = Number(this.config.requestRetries || 2);
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.callOnce(method, payload);
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  async callOnce(method, payload) {
    const timeoutMs = Number(this.config.requestTimeoutMs || 15000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (timeout.unref) timeout.unref();

    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      const cause = error.cause && (error.cause.code || error.cause.message);
      const detail = cause ? `${error.message} (${cause})` : error.message;
      throw new Error(`Telegram ${method} request failed: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      throw new Error(`Telegram ${method} failed: invalid JSON response ${response.status}`);
    }

    if (!data.ok) {
      throw new Error(`Telegram ${method} failed: ${data.description || response.statusText}`);
    }

    return data.result;
  }
}

function parseCallbackData(data) {
  const match = String(data || '').match(/^reschedule:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/);
  if (!match) return null;
  return { date: match[1], time: match[2] };
}

function formatDateForMessage(date) {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  TelegramBot,
  formatDateForMessage,
};
