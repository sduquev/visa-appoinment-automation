# Visa Appointment Monitor

Aplicación local en Node.js para revisar disponibilidad de citas de visa de EE. UU. en AIS Colombia y enviar alertas por Telegram cuando aparezca una cita anterior a la cita actual.

El flujo es:

AIS -> detectar cita anterior -> enviar alerta por Telegram -> pulsar REAGENDAR -> verificar disponibilidad de nuevo -> reagendar -> informar resultado.

## Requisitos

- Node.js 18 o superior.
- Una cuenta activa en AIS Colombia.
- Un bot de Telegram.
- Chromium instalado por Playwright.

## Instalación

```bash
npm install
npx playwright install chromium
```

## Configuración

Edita `config.json` con tus datos locales:

```json
{
  "ais": {
    "loginUrl": "https://asc.usvisa-info.com/es-co/user/sign_in",
    "appointmentUrl": "",
    "email": "TU_EMAIL",
    "password": "TU_PASSWORD",
    "headless": false,
    "browserChannel": "chrome",
    "selectors": {
      "loginForm": "#sign_in_form",
      "email": "#user_email",
      "password": "#user_password",
      "policyCheckbox": "#policy_confirmed",
      "signInButton": "input[name=\"commit\"]",
      "captchaContainer": "div.captcha_container",
      "loggedInMarker": "",
      "dashboardContinue": "",
      "rescheduleOpenAction": "",
      "rescheduleAction": "",
      "availabilityItem": "",
      "availabilityDateAttribute": "data-date",
      "availabilityTimeAttribute": "data-time",
      "consulateFacility": "#appointments_consulate_appointment_facility_id",
      "consulateDate": "#appointments_consulate_appointment_date",
      "consulateTime": "#appointments_consulate_appointment_time",
      "ascFacility": "#appointments_asc_appointment_facility_id",
      "ascDate": "#appointments_asc_appointment_date",
      "ascTime": "#appointments_asc_appointment_time",
      "dateOptionTemplate": "",
      "timeOptionTemplate": "",
      "submitReschedule": "#appointments_submit",
      "postSubmitConfirmAction": "",
      "successMessage": ""
    }
  },
  "telegram": {
    "botToken": "TU_BOT_TOKEN",
    "chatId": "TU_CHAT_ID"
  },
  "appointment": {
    "currentDate": "2027-02-23",
    "currentTime": "10:30",
    "currentAscDate": "2027-02-19",
    "currentAscTime": "10:30",
    "city": "Bogota",
    "visaType": "B2"
  },
  "monitor": {
    "intervalMinutes": 5
  }
}
```

`config.json` y `state.json` están en `.gitignore`.

## Selectores de AIS

La página pública de login de Colombia está en `https://asc.usvisa-info.com/es-co/user/sign_in`.

Los selectores posteriores al login deben inspeccionarse en tu sesión real antes de usarlos. No están prellenados porque el portal puede cambiar y no conviene automatizar con pasos inventados.

Puedes abrir un inspector local con:

```bash
npm run inspect:ais
```

Ese comando abre Chrome, te deja iniciar sesión manualmente, y cuando presionas Enter en la terminal imprime candidatos de selectores para la página real en la que estés.

Campos esperados:

- `loggedInMarker`: selector visible solo cuando ya estás autenticado.
- `dashboardContinue`: selector del botón/enlace para continuar a tu solicitud, si no usas `appointmentUrl`.
- `rescheduleOpenAction`: selector del acordeón o control que abre la acción de reprogramar, si aplica.
- `rescheduleAction`: selector de la acción real para reprogramar, si aplica.
- `availabilityItem`: selector de cada elemento que contiene una fecha y hora disponible.
- `availabilityDateAttribute`: atributo con fecha ISO `YYYY-MM-DD`, si existe.
- `availabilityTimeAttribute`: atributo con hora `HH:mm`, si existe.
- `consulateFacility`: selector del campo de ubicación consular.
- `consulateDate`: selector del campo de fecha consular.
- `consulateTime`: selector del campo de hora consular.
- `ascFacility`: selector del campo de ubicación ASC/CAS.
- `ascDate`: selector del campo de fecha ASC/CAS.
- `ascTime`: selector del campo de hora ASC/CAS.
- `dateOptionTemplate`: selector para elegir una fecha. Puedes usar `{{date}}`.
- `timeOptionTemplate`: selector para elegir una hora. Puedes usar `{{time}}`.
- `submitReschedule`: selector del botón real para confirmar el reagendamiento.
- `postSubmitConfirmAction`: selector del botón de confirmación posterior al submit, si AIS muestra uno.
- `successMessage`: selector de un mensaje visible cuando el reagendamiento fue exitoso.

Si el texto del elemento de disponibilidad contiene una fecha `YYYY-MM-DD` o `DD/MM/YYYY` y una hora `HH:mm`, el monitor puede leerlas aunque no existan atributos.

## Crear el bot de Telegram

1. Abre Telegram y busca `@BotFather`.
2. Envía `/newbot`.
3. Elige nombre y usuario para el bot.
4. Copia el token entregado por BotFather en `telegram.botToken`.

## Obtener el chatId

1. Escríbele un mensaje cualquiera a tu bot.
2. Abre en el navegador:

```text
https://api.telegram.org/botTU_BOT_TOKEN/getUpdates
```

3. Busca `message.chat.id` y cópialo en `telegram.chatId`.

El programa ignora callbacks que no provengan de ese `chatId`.

## Ejecutar el monitor

```bash
npm start
```

El navegador abre visible porque `headless` está en `false`. Si ya tienes Google Chrome instalado, `browserChannel: "chrome"` evita depender de la descarga del Chromium empaquetado de Playwright.

## Detenerlo

Presiona `Ctrl+C` en la terminal.

## CAPTCHA, MFA o verificaciones

Si AIS solicita CAPTCHA, MFA o cualquier challenge, el programa se detiene temporalmente y deja el navegador abierto. Completa la verificación manualmente y luego presiona Enter en la terminal para continuar.

El programa no intenta evadir CAPTCHA, MFA, rate limits ni controles de seguridad del portal.
