# Visa Appointment Monitor

Aplicacion local en Node.js y Playwright para revisar disponibilidad de citas de visa de EE. UU. en AIS Colombia y enviar alertas por Telegram cuando aparezca una combinacion anterior a la cita actual.

El flujo actual es:

```text
AIS -> buscar cita consular + CAS -> enviar alerta Telegram -> esperar autorizacion -> revalidar -> reprogramar -> confirmar popup AIS -> enviar resultado Telegram
```

El script no confirma un cambio de cita durante el escaneo normal. El reagendamiento solo se ejecuta cuando respondes desde Telegram.

## Requisitos

- Node.js 18 o superior.
- Una cuenta activa en AIS Colombia.
- Google Chrome instalado, o Chromium instalado por Playwright.
- Un bot de Telegram con `botToken` y `chatId`.

## Instalacion

```bash
npm install
npx playwright install chromium
```

Si usas Google Chrome instalado en el sistema, puedes mantener:

```json
"browserChannel": "chrome"
```

## Archivos Locales

Estos archivos son locales y estan ignorados por Git:

- `config.json`: configuracion sensible del monitor.
- `state.json`: estado interno del ultimo aviso/cita actual.
- `ais-inspection.txt`: salida del inspector de AIS.
- `playwright/.auth/`: perfil persistente del navegador.

No compartas `config.json` con tokens, correo o contrasena reales.

## Configuracion Base

Ejemplo seguro de `config.json`:

```json
{
  "ais": {
    "loginUrl": "https://ais.usvisa-info.com/es-co/niv/users/sign_in",
    "appointmentUrl": "https://ais.usvisa-info.com/es-co/niv/schedule/TU_SCHEDULE_ID/appointment",
    "email": "TU_EMAIL",
    "password": "TU_PASSWORD",
    "headless": false,
    "browserChannel": "chrome",
    "interactionDelayMs": 1000,
    "pageScanInteractionDelayMs": 200,
    "pageScanDatePickerOpenTimeoutMs": 3000,
    "pageScanAvailabilityReadyTimeoutMs": 3000,
    "pageScanDependentTimeoutMs": 8000,
    "pageScanNoAvailabilityMessageDelayMs": 1500,
    "pageScanSubmitReadyTimeoutMs": 3000,
    "pageScanFieldTimeoutMs": 4000,
    "pageScanTimeOptionTimeoutMs": 8000,
    "manualLoginSubmit": true,
    "manualLoginTimeoutMs": 180000,
    "availabilityScanMode": "page",
    "pageScanMaxConsularDates": 8,
    "pageScanMaxAscDates": 8,
    "postSubmitResultTimeoutMs": 10000,
    "selectors": {
      "loginForm": "#sign_in_form",
      "email": "#user_email",
      "password": "#user_password",
      "policyCheckbox": "#policy_confirmed",
      "signInButton": "input[name=\"commit\"]",
      "captchaContainer": "div.captcha_container",
      "loggedInMarker": "a:has-text(\"Finalizar sesión\")",
      "dashboardContinue": "div.application.attend_appointment.card.success a.button.primary.small",
      "rescheduleOpenAction": "li.accordion-item:has(a.accordion-title:has-text(\"Reprogramar cita\")) a.accordion-title",
      "rescheduleAction": "li.accordion-item:has(a.accordion-title:has-text(\"Reprogramar cita\")) a.button.small.primary.small-only-expanded",
      "availabilityItem": "",
      "availabilityDateAttribute": "data-date",
      "availabilityTimeAttribute": "data-time",
      "consulateFacility": "#appointments_consulate_appointment_facility_id",
      "consulateDate": "#appointments_consulate_appointment_date",
      "consulateTime": "#appointments_consulate_appointment_time",
      "ascFacility": "#appointments_asc_appointment_facility_id",
      "ascDateTime": "#asc_date_time",
      "ascDate": "#appointments_asc_appointment_date",
      "ascTime": "#appointments_asc_appointment_time",
      "datePicker": "#ui-datepicker-div",
      "datePickerNext": "#ui-datepicker-div a.ui-datepicker-next",
      "datePickerAvailableDay": "#ui-datepicker-div td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default",
      "dateOptionTemplate": "",
      "timeOptionTemplate": "",
      "submitReschedule": "#appointments_submit",
      "postSubmitConfirmAction": "div.reveal:has-text(\"Desea reprogramar esta cita\") a.button.alert:has-text(\"Confirmar\")",
      "successMessage": "#flash_messages:has-text(\"Usted ha programado exitosamente su cita de visa\")"
    }
  },
  "telegram": {
    "botToken": "TU_BOT_TOKEN",
    "chatId": "TU_CHAT_ID",
    "requestTimeoutMs": 3000,
    "requestRetries": 2
  },
  "appointment": {
    "currentDate": "YYYY-MM-DD",
    "currentTime": "HH:mm",
    "currentAscDate": "YYYY-MM-DD",
    "currentAscTime": "HH:mm",
    "city": "Bogota",
    "visaType": "B2"
  },
  "monitor": {
    "intervalMinutes": 5
  }
}
```

## Login

El modo actual recomendado es semimanual:

```json
"manualLoginSubmit": true
```

Con ese valor, el script:

- Abre AIS.
- Llena email y contrasena.
- No marca el checkbox.
- No da click en continuar.
- Espera que marques el checkbox y hagas click manualmente.
- Continua solo cuando detecta que salio de `/users/sign_in`.

El tiempo maximo para completar ese paso se controla con:

```json
"manualLoginTimeoutMs": 180000
```

Si la sesion ya esta activa, el script intenta reutilizarla. Primero valida si ya estas en una pagina util de AIS, y si no, abre `appointmentUrl`. Solo vuelve al login cuando AIS redirige realmente a `/users/sign_in`.

## Sesion

Playwright usa un perfil persistente en:

```text
playwright/.auth/
```

Ahi se conservan cookies y storage del navegador. Por eso no se reinicia Chrome en cada ciclo. Si AIS expira la sesion del servidor, el siguiente ciclo volvera al login y pedira el paso semimanual.

## Escaneo

El modo actual de escaneo esta configurado asi:

```json
"availabilityScanMode": "page"
```

Eso significa que el monitor usa la pagina visible y sus datepickers, no los endpoints internos `/days/...`, porque en algunas cuentas AIS responde esos endpoints con `404`.

El escaneo busca una combinacion completa:

- Fecha consular disponible.
- Hora consular disponible.
- Bloque CAS habilitado.
- Fecha CAS disponible.
- Hora CAS disponible.
- Boton final de reprogramacion habilitable.

## Exploracion Consular y CAS

El flujo de busqueda por pagina es:

1. Abre el datepicker consular.
2. Avanza mes a mes hasta encontrar una fecha habilitada.
3. Lee todas las horas consulares disponibles para esa fecha.
4. Prueba cada hora consular.
5. Despues de cada hora, espera que se habilite el bloque CAS.
6. Si CAS no se habilita o aparece mensaje de no disponibilidad, prueba la siguiente hora.
7. Si ninguna hora sirve, pasa a la siguiente fecha consular.
8. Cuando CAS se habilita, abre el datepicker CAS.
9. Prueba fechas CAS y horas CAS.
10. Solo notifica Telegram si la combinacion queda completa.

Limites de exploracion:

```json
"pageScanMaxConsularDates": 8,
"pageScanMaxAscDates": 8
```

## Timeouts y Ritmo

Estos valores controlan tiempos del escaneo:

- `interactionDelayMs`: pausa normal despues de acciones relevantes fuera del escaneo rapido.
- `pageScanInteractionDelayMs`: pausa corta durante busqueda en datepickers.
- `pageScanDatePickerOpenTimeoutMs`: maximo para abrir un datepicker.
- `pageScanAvailabilityReadyTimeoutMs`: maximo para detectar que la pagina de appointment esta lista.
- `pageScanDependentTimeoutMs`: maximo para esperar que CAS se habilite despues de una hora consular.
- `pageScanNoAvailabilityMessageDelayMs`: tiempo minimo antes de aceptar un mensaje de no disponibilidad.
- `pageScanSubmitReadyTimeoutMs`: maximo para validar que el boton final quedo listo durante el escaneo.
- `pageScanFieldTimeoutMs`: maximo para esperar campos de fecha/hora.
- `pageScanTimeOptionTimeoutMs`: maximo para esperar opciones de hora.
- `postSubmitResultTimeoutMs`: maximo para esperar exito o error despues de confirmar el popup final de AIS.

Para pruebas rapidas puedes usar intervalos cortos. Para dejarlo corriendo por mas tiempo conviene usar valores prudentes.

## Reprogramacion

Cuando encuentra una cita menor a la actual, el monitor envia un mensaje de Telegram con boton `REAGENDAR`.

Si presionas ese boton:

1. Revalida que la cita siga disponible.
2. Selecciona cita consular.
3. Selecciona cita CAS.
4. Verifica que el boton `Reprogramar` este habilitado.
5. Da click en `Reprogramar`.
6. Espera el popup de AIS.
7. Da click en `Confirmar`.
8. Espera el resultado final.
9. Envia Telegram de exito o fallo.

El popup de confirmacion se controla con:

```json
"postSubmitConfirmAction": "div.reveal:has-text(\"Desea reprogramar esta cita\") a.button.alert:has-text(\"Confirmar\")"
```

El exito final se detecta con:

```json
"successMessage": "#flash_messages:has-text(\"Usted ha programado exitosamente su cita de visa\")"
```

## Telegram

Crea el bot con `@BotFather` y copia el token en:

```json
"botToken": "TU_BOT_TOKEN"
```

Para obtener el `chatId`:

1. Escribele cualquier mensaje a tu bot.
2. Abre:

```text
https://api.telegram.org/botTU_BOT_TOKEN/getUpdates
```

3. Busca `message.chat.id`.
4. Copia ese valor en:

```json
"chatId": "TU_CHAT_ID"
```

El programa ignora callbacks que no provengan de ese `chatId`.

Parametros de red:

```json
"requestTimeoutMs": 3000,
"requestRetries": 2
```

Si falla el envio de Telegram:

- No reprograma nada.
- Registra `Telegram notification failed`.
- No guarda esa cita como notificada.
- En el siguiente ciclo vuelve a intentar si la cita sigue disponible.

Si falla Telegram despues de que AIS ya reprogramo exitosamente, el cambio queda guardado en `state.json` y el log indica que fallo solo la notificacion de exito.

## Cita Actual

Configura tu cita actual para que el monitor solo notifique citas anteriores:

```json
"appointment": {
  "currentDate": "YYYY-MM-DD",
  "currentTime": "HH:mm",
  "currentAscDate": "YYYY-MM-DD",
  "currentAscTime": "HH:mm",
  "city": "Bogota",
  "visaType": "B2"
}
```

Despues de un reagendamiento exitoso, `state.json` guarda la nueva cita como `currentAppointment`. A partir de ese momento el monitor compara contra esa nueva fecha.

## Intervalo del Monitor

El intervalo se configura en minutos:

```json
"monitor": {
  "intervalMinutes": 5
}
```

El tiempo se cuenta despues de terminar cada ciclo.

Ejemplo con `intervalMinutes: 5`:

```text
01:00:00 inicia escaneo
01:00:40 termina sin cita valida
01:05:40 inicia el siguiente escaneo
```

El navegador no se cierra entre ciclos.

## Inspector AIS

Para inspeccionar la pagina actual y generar `ais-inspection.txt`:

```bash
npm run inspect:ais
```

Uso:

1. Abre el inspector.
2. Navega manualmente hasta la pantalla que quieras analizar.
3. Presiona Enter en la terminal.
4. El archivo `ais-inspection.txt` se reemplaza con el estado actual.
5. Escribe `q` y Enter para cerrar.

El inspector ayuda a encontrar selectores de botones, modales, datepickers, campos y mensajes de AIS.

## Ejecutar

```bash
npm start
```

Comportamiento esperado en consola:

```text
Monitor started
Opening AIS
Filling AIS login form
Waiting for manual checkbox and login submit
Login completed
AIS appointment page ready in XXXXms
Checking appointments
```

Si la sesion ya esta activa:

```text
Existing AIS session detected
AIS appointment page ready in XXXXms
Checking appointments
```

## Detener

```text
Ctrl+C
```

## Seguridad

El programa no intenta evadir CAPTCHA, MFA, rate limits ni controles de seguridad del portal.

Si AIS muestra una verificacion real, el script se pausa y deja el navegador abierto para intervencion manual.

Si alguna credencial o token fue compartido accidentalmente en logs, chats o capturas, rota esa credencial antes de dejar el monitor corriendo.
