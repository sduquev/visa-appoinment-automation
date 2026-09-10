# Visa Appointment Monitor

Aplicación local en Node.js y Playwright para consultar citas de visa en AIS Colombia. Cuando detecta una combinación Consular/CAS anterior a la cita actual, envía una alerta a Telegram y solo reprograma si se autoriza desde allí.

```text
AIS → buscar Consular + CAS → alerta Telegram → decisión del usuario → reprogramar → resultado Telegram
```

El escaneo normal nunca cambia una cita. CAPTCHA, MFA y otros desafíos de seguridad siempre requieren intervención humana.

## Requisitos

- Node.js 18 o superior.
- Cuenta activa en AIS Colombia.
- Google Chrome o Chromium de Playwright.
- Bot de Telegram y su `chatId` autorizado.

## Instalación y ejecución

```bash
npm install
npx playwright install chromium
npm start
```

Si usas Chrome instalado en el equipo, configura:

```json
"browserChannel": "chrome"
```

Para detener el monitor, usa `Ctrl+C`.

## Archivos locales

Los siguientes archivos no se suben a Git:

- `config.json`: credenciales y configuración.
- `state.json`: última alerta y cita vigente tras un reagendamiento exitoso.
- `ais-inspection.txt`: resultado del inspector de AIS.
- `playwright/.auth/`: perfil persistente de Chrome, cookies y storage.

No compartas `config.json`, tokens ni contraseñas.

## Configuración

Crea `config.json` en la raíz con este ejemplo. Sustituye los valores `TU_*` y verifica los selectores con tu cuenta de AIS.

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
    "dashboardReadyTimeoutMs": 15000,
    "manualLoginSubmit": true,
    "manualLoginTimeoutMs": 180000,
    "loginSubmitAttempts": 2,
    "loginSubmitResponseTimeoutMs": 10000,
    "loginPopupRetryDelayMs": 2000,
    "availabilityScanMode": "page",
    "pageScanInteractionDelayMs": 200,
    "pageScanDatePickerOpenTimeoutMs": 3000,
    "pageScanAvailabilityReadyTimeoutMs": 3000,
    "pageScanDependentTimeoutMs": 8000,
    "pageScanNoAvailabilityMessageDelayMs": 1500,
    "pageScanSubmitReadyTimeoutMs": 3000,
    "pageScanFieldTimeoutMs": 4000,
    "pageScanTimeOptionTimeoutMs": 8000,
    "pageScanMaxConsularDates": 8,
    "pageScanMaxAscDates": 8,
    "pageScanMaxDatePickerNextClicks": 6,
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

### Referencia completa de opciones

Todas las duraciones se expresan en milisegundos. Los valores vacíos (`""`) son intencionales: desactivan rutas alternativas que no se usan en el modo `page` con los campos Consular/CAS.

#### `ais`

| Campo | Explicación |
| --- | --- |
| `loginUrl` | URL de inicio de sesión de AIS. Es la primera URL que abre el programa. Requerida. |
| `appointmentUrl` | URL del formulario de citas de tu schedule. Se usa solo tras tener sesión. |
| `email` / `password` | Credenciales de AIS. Requeridas. |
| `headless` | `false` deja Chrome visible; `true` lo ejecuta sin ventana. |
| `browserChannel` | Canal de Playwright. Usa `"chrome"` para el Chrome instalado; omítelo para Chromium de Playwright. |
| `interactionDelayMs` | Pausa normal entre acciones, incluido correo, contraseña, checkbox y clics del flujo normal. |
| `dashboardReadyTimeoutMs` | Máximo para esperar que aparezca un botón `Continuar` visible en el grupo. |
| `dashboardContinueAfterClickWaitMs` | Espera breve después de pulsar `Continuar` para que AIS cargue el formulario de citas. |
| `manualLoginSubmit` | `true` activa el envío automático: marca política y pulsa iniciar sesión. `false` espera que lo hagas manualmente. |
| `manualLoginTimeoutMs` | Máximo de espera cuando `manualLoginSubmit` es `false`. |
| `loginSubmitAttempts` | Número de envíos automáticos de login si AIS permanece en el formulario. |
| `loginSubmitResponseTimeoutMs` | Presupuesto máximo total por intento desde el envío del login hasta detectar el cambio de página y dejar que la página posterior se estabilice. |
| `loginPopupRetryDelayMs` | Pausa tras aceptar el popup “You need to sign in…” antes de reintentar login. |
| `availabilityScanMode` | `"page"` usa los campos y datepickers visibles. Otro valor usa el modo alterno basado en datos de disponibilidad. |
| `refreshAppointmentPageBeforeScan` | Recarga la página de citas al inicio de cada ciclo antes de consultar disponibilidad. Si es `false`, conserva la página tal como quedó. |
| `pageScanConsularDateSelectionDelayMs` | Espera después de seleccionar la fecha Consular antes de revisar las horas disponibles. |
| `pageScanConsularTimeSelectionDelayMs` | Espera después de seleccionar la hora Consular antes de comprobar que CAS se habilitó. |
| `pageScanInteractionDelayMs` | Pausa corta entre acciones durante el escaneo de datepickers. |
| `pageScanDatePickerOpenTimeoutMs` | Máximo para abrir un datepicker durante el escaneo. |
| `pageScanAvailabilityReadyTimeoutMs` | Máximo para confirmar que el formulario de citas está listo. |
| `pageScanDependentTimeoutMs` | Máximo para esperar que el bloque CAS se habilite luego de elegir Consular. |
| `pageScanNoAvailabilityMessageDelayMs` | Espera mínima antes de interpretar un mensaje de “sin disponibilidad”. |
| `pageScanSubmitReadyTimeoutMs` | Máximo para confirmar que el botón final puede enviarse. |
| `pageScanFieldTimeoutMs` | Máximo para esperar campos de fecha/hora. |
| `pageScanTimeOptionTimeoutMs` | Máximo para esperar horas disponibles. |
| `pageScanMaxConsularDates` | Número máximo de fechas Consulares completas que se prueban. |
| `pageScanMaxAscDates` | Número máximo de fechas CAS completas que se prueban por la combinación Consular elegida. |
| `pageScanMaxDatePickerNextClicks` | Máximo de clics en “Siguiente” sin hallar fecha. Aplica a Consular, CAS, escaneo y selección directa. |
| `postSubmitResultTimeoutMs` | Máximo para esperar el resultado final de AIS tras confirmar el reagendamiento. |

#### `ais.selectors`

Los selectores son CSS compatibles con Playwright. Deben ajustarse con `npm run inspect:ais` si AIS cambia su interfaz.

| Campo | Elemento que identifica |
| --- | --- |
| `loginForm` | Formulario de inicio de sesión. |
| `email` / `password` | Campos de correo y contraseña. |
| `policyCheckbox` | Checkbox de aceptación de política. |
| `signInButton` | Botón o `input` para iniciar sesión. |
| `captchaContainer` | Contenedor que permite detectar CAPTCHA o verificación humana. |
| `loggedInMarker` | Elemento visible que identifica una sesión autenticada. |
| `dashboardContinue` | Botón `Continuar` de la página de grupos. |
| `rescheduleOpenAction` | Encabezado que expande la sección `Reprogramar cita`. |
| `rescheduleAction` | Acción/botón de reprogramación dentro de esa sección. |
| `consulateFacility` / `ascFacility` | Selectores de sede Consular y CAS; se conservan para flujos de AIS que los requieran. |
| `consulateDate` / `consulateTime` | Campos de fecha y hora Consular. |
| `ascDateTime` | Contenedor cuya disponibilidad indica que CAS se habilitó. |
| `ascDate` / `ascTime` | Campos de fecha y hora CAS. |
| `datePicker` | Raíz del datepicker de jQuery UI. |
| `datePickerNext` | Botón “Siguiente” del datepicker. |
| `submitReschedule` | Botón final para enviar el cambio. |
| `postSubmitConfirmAction` | Botón de confirmación en el diálogo posterior a `Reprogramar`. |
| `successMessage` | Mensaje de éxito final de AIS. |
| `availabilityItem` | Selector de cada cita en el modo alterno; déjalo vacío con el formulario Consular/CAS. |
| `availabilityDateAttribute` / `availabilityTimeAttribute` | Atributos que contienen fecha y hora en cada `availabilityItem`. |
| `dateOptionTemplate` / `timeOptionTemplate` | Plantillas de selectores del modo alterno para una fecha/hora específica; déjalas vacías en el modo actual. |
| `datePickerAvailableDay` | Valor conservado por compatibilidad de configuración; el escáner actual calcula los días habilitados directamente desde `datePicker`. |

#### `telegram`, `appointment` y `monitor`

| Campo | Explicación |
| --- | --- |
| `telegram.botToken` | Token entregado por `@BotFather`. Requerido. |
| `telegram.chatId` | Único chat autorizado a decidir `REAGENDAR` o `NO AGENDAR`. Requerido. |
| `telegram.requestTimeoutMs` | Máximo de cada solicitud HTTP a Telegram. |
| `telegram.requestRetries` | Reintentos de una solicitud fallida a Telegram, además del primer intento. |
| `appointment.currentDate` / `currentTime` | Fecha y hora de la cita Consular actual. Se usan como referencia para decidir si una cita es anterior. Requeridos. |
| `appointment.currentAscDate` / `currentAscTime` | Fecha y hora CAS actuales. Recomendados para mostrarlos en la alerta. |
| `appointment.city` / `visaType` | Texto informativo que se envía en Telegram. Requeridos. |
| `monitor.intervalMinutes` | Minutos entre ciclos finalizados de revisión; el mínimo efectivo es 1. |

`appointmentUrl` se usa después de que AIS ha establecido una sesión para abrir el formulario de citas. Al arrancar, el programa abre siempre `loginUrl`; así evita intentar la URL de citas sin sesión.

## Inicio de sesión y sesión activa

El perfil persistente permite reutilizar una sesión de AIS ya iniciada:

- Si el navegador ya está en una página válida de AIS, se reutiliza.
- Si está vacío o muestra un error de conexión, se abre `loginUrl`.
- Si la cookie sigue vigente, AIS redirige al grupo o a las citas sin completar el formulario.
- Si AIS deja el navegador en `/users/sign_in`, se realiza el login configurado.

Con el valor actual de la bandera:

```json
"manualLoginSubmit": true
```

el script llena correo y contraseña, espera `interactionDelayMs` entre acciones, marca la política y pulsa el botón de inicio de sesión. Si AIS continúa en el formulario, reintenta hasta `loginSubmitAttempts` veces. Si aparece el aviso de AIS “You need to sign in or sign up before continuing”, pulsa `OK`, espera `loginPopupRetryDelayMs` y reintenta.

Para llenar y enviar el formulario tú mismo:

```json
"manualLoginSubmit": false
```

En ese modo espera hasta `manualLoginTimeoutMs` para que abandones la URL de login.

## Escaneo de citas

El modo recomendado es:

```json
"availabilityScanMode": "page"
```

Usa la página visible de AIS y sus datepickers. Busca una combinación completa:

1. Fecha y hora Consular.
2. Bloque CAS habilitado para esa selección.
3. Fecha y hora CAS.
4. Formulario listo para el envío final.

Solo una combinación completa genera una alerta.

### Límites del datepicker

```json
"pageScanMaxConsularDates": 8,
"pageScanMaxAscDates": 8,
"pageScanMaxDatePickerNextClicks": 6
```

`pageScanMaxDatePickerNextClicks` limita a seis pulsaciones de “Siguiente” sin hallar una fecha. Aplica tanto al datepicker Consular como al CAS, y tanto al escaneo como a la selección de una fecha concreta. Al alcanzar el límite se registra que no se encontró una fecha seleccionable y ese intento se detiene.

Los demás valores `pageScan*TimeoutMs` controlan los máximos de espera de campos, opciones de hora, habilitación de CAS y resultado del formulario. `pageScanInteractionDelayMs` es la pausa corta entre acciones del escaneo.

## Telegram y reagendamiento

Cuando hay una cita anterior, Telegram recibe dos botones:

- `🔄 REAGENDAR`: confirma la recepción y envía una notificación de que está procesando el cambio. Después intenta directamente seleccionar y enviar la cita alertada, sin ejecutar un segundo escaneo completo.
- `✋ NO AGENDAR`: conserva la cita actual y confirma la decisión; no hace cambios en AIS.

El bot permanece en long-poll esperando callbacks de Telegram. Una pulsación se recibe inmediatamente aunque la solicitud de long-poll tenga una espera máxima de 25 segundos.

Al reagendar, AIS selecciona la cita Consular y CAS, habilita `Reprogramar`, confirma el diálogo configurado en `postSubmitConfirmAction` y espera éxito o error. El éxito se detecta con `successMessage`.

Si AIS rechaza la cita o falla cualquier paso:

1. Se registra el error.
2. Telegram recibe `ERROR AL REAGENDAR`.
3. El monitor reinicia inmediatamente la revisión de disponibilidad.

Tras éxito, `state.json` guarda la nueva cita; las siguientes comparaciones usan esa cita como referencia.

Solo se aceptan callbacks procedentes del `chatId` configurado. Para obtenerlo, escribe a tu bot y consulta:

```text
https://api.telegram.org/botTU_BOT_TOKEN/getUpdates
```

Busca `message.chat.id` y colócalo en `telegram.chatId`.

## Intervalo de revisión

```json
"monitor": {
  "intervalMinutes": 5
}
```

El siguiente ciclo se programa al terminar el actual. Con `5` minutos, un ciclo que finaliza a las `01:00:40` vuelve a comenzar cerca de las `01:05:40`. El mínimo es un minuto.

## Logs

Los logs usan la zona horaria local de la máquina e incluyen el desfase UTC y milisegundos:

```text
[2026-09-08 09:28:54.327 UTC-05:00] Telegram callback received: chat=123, data=reschedule:2026-09-14:07:45
```

Esto permite distinguir acciones consecutivas que ocurren durante el mismo segundo. Algunos mensajes relevantes son:

```text
Telegram callback received: ...
Telegram callback acknowledged: reschedule
Reschedule requested from Telegram: ...
Submitting the Telegram-selected appointment without another availability check
Reschedule completed: ...
Restarting appointment checks after reschedule failure
No selectable date found after 6 datepicker next click(s).
```

## Inspector de AIS

Para revisar los selectores y el estado de la página actual:

```bash
npm run inspect:ais
```

Completa manualmente los pasos que AIS solicite, navega a la página que quieras inspeccionar y presiona Enter en la terminal. El reporte se escribe en `ais-inspection.txt`. Escribe `q` y Enter para cerrar.

## Seguridad

No se intenta evadir CAPTCHA, MFA, límites de velocidad ni otros controles de AIS. Si aparece una verificación humana, el navegador queda abierto para que la completes.

Si compartiste accidentalmente credenciales o un token en un chat, captura o log, revócalos y crea otros antes de seguir usando el monitor.
