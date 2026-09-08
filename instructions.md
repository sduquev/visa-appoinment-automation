# Visa Appointment Monitor

## 1. Objetivo

Crear una aplicación local sencilla en Node.js para monitorear la disponibilidad de citas de visa de EE. UU. en el portal oficial AIS de Colombia y permitir reagendar una cita cuando aparezca una fecha anterior a la cita actual.

La aplicación es exclusivamente para uso personal y local.

El flujo principal debe ser:

AIS → detectar cita anterior → enviar alerta por Telegram → usuario pulsa REAGENDAR → verificar disponibilidad nuevamente → reagendar → informar resultado.

No se necesita una arquitectura robusta, escalable ni preparada para múltiples usuarios.

---

## 2. Stack tecnológico

Usar:

- Node.js
- JavaScript
- Playwright
- Telegram Bot API

No utilizar TypeScript.

No utilizar:

- Docker
- bases de datos
- Redis
- Kubernetes
- microservicios
- servidores cloud
- servicios externos de backend
- sistemas complejos de autenticación
- frameworks innecesarios

Todo debe ejecutarse localmente en una única computadora.

---

## 3. Estructura del proyecto

Mantener el proyecto pequeño.

Estructura preferida:

visa-monitor/
  src/
    index.js
    ais.js
    monitor.js
    telegram.js
  config.json
  state.json
  package.json
  .gitignore
  README.md

No crear archivos adicionales salvo que sean realmente necesarios.

---

## 4. Configuración

Usar un único archivo config.json para la configuración local.

Ejemplo:

{
  "ais": {
    "email": "TU_EMAIL",
    "password": "TU_PASSWORD"
  },
  "telegram": {
    "botToken": "TU_BOT_TOKEN",
    "chatId": "TU_CHAT_ID"
  },
  "appointment": {
    "currentDate": "2027-02-23",
    "currentTime": "10:30",
    "city": "Bogota",
    "visaType": "B2"
  },
  "monitor": {
    "intervalMinutes": 5
  }
}

Las credenciales pueden permanecer directamente en config.json porque el proyecto es exclusivamente local.

No imprimir la contraseña en los logs.

Agregar config.json al .gitignore.

---

## 5. Estado

Usar state.json para guardar únicamente información mínima necesaria para evitar notificaciones duplicadas.

Ejemplo:

{
  "lastNotification": {
    "date": "2026-12-18",
    "time": "08:00"
  }
}

No utilizar una base de datos.

Si una misma cita ya fue notificada, no enviar continuamente la misma alerta.

Si una cita desaparece y posteriormente vuelve a aparecer, puede volver a notificarse.

---

## 6. Navegador

Utilizar Playwright con Chromium.

Durante el desarrollo utilizar navegador visible:

headless: false

Esto permitirá observar exactamente qué está haciendo el programa y facilitará el debugging.

El programa debe abrir el portal AIS real y utilizar la interfaz actual del sitio.

Antes de implementar la automatización, inspeccionar el portal real y determinar:

- URL actual;
- página de login;
- campos de usuario;
- campos de contraseña;
- botones;
- navegación;
- página de citas;
- elementos que contienen la disponibilidad;
- flujo actual de reagendamiento.

No inventar URLs, selectores, nombres de campos ni pasos del portal.

Los selectores deben basarse en la estructura real del portal.

---

## 7. Login

Crear una función sencilla para iniciar sesión en AIS.

Debe:

1. Abrir AIS.
2. Introducir el email configurado.
3. Introducir la contraseña configurada.
4. Iniciar sesión.
5. Esperar a que el login termine.
6. Continuar hacia la sección de citas.

Si la sesión ya está activa, reutilizarla cuando sea posible.

No implementar un sistema complejo de gestión de sesiones.

Mantener el navegador abierto mientras el monitor esté ejecutándose.

---

## 8. CAPTCHA, MFA y controles de seguridad

Si AIS presenta:

- CAPTCHA;
- MFA;
- challenge;
- verificación adicional;
- cualquier mecanismo que requiera interacción humana;

la automatización debe detenerse temporalmente y permitir que el usuario intervenga manualmente.

No intentar:

- evadir CAPTCHA;
- resolver CAPTCHA automáticamente;
- evadir MFA;
- evadir rate limits;
- evadir mecanismos anti-bot;
- ocultar automatización frente a los controles del sitio.

Después de que el usuario complete manualmente la verificación, el programa debe poder continuar.

---

## 9. Monitor de citas

Crear una función para consultar periódicamente la disponibilidad.

La aplicación debe obtener las citas disponibles y determinar cuál es la fecha más temprana disponible.

La condición inicial para considerar una cita como interesante es:

fechaDisponible < fechaCitaActual

Ejemplo:

Cita actual:
23/02/2027 10:30

Nueva disponibilidad:
18/12/2026 08:00

Resultado:

CITA INTERESANTE

Una fecha posterior a la cita actual debe ignorarse.

Inicialmente no aplicar filtros adicionales por hora.

Cualquier horario de una fecha anterior puede generar una alerta.

---

## 10. Intervalo de consulta

El intervalo debe estar definido en config.json:

"intervalMinutes": 5

No hardcodear el intervalo.

El comportamiento debe ser:

consultar → procesar resultado → esperar → consultar nuevamente.

No ejecutar consultas simultáneas.

Debe existir como máximo una consulta activa a AIS en cada momento.

---

## 11. Detección de la cita más temprana

La aplicación debe analizar las citas disponibles y seleccionar la mejor oportunidad según este criterio:

1. Fecha anterior a la cita actual.
2. Entre las fechas anteriores, preferir la más temprana.

Ejemplo:

Cita actual:
23/02/2027

Disponibles:
20/02/2027
15/01/2027
18/12/2026

Seleccionar:

18/12/2026

No es necesario implementar un algoritmo complejo.

---

## 12. Telegram

Utilizar directamente Telegram Bot API.

No utilizar servicios intermediarios.

Crear un bot de Telegram específico para este proyecto.

El bot enviará las alertas al chatId configurado.

Solo aceptar acciones provenientes del chatId configurado.

Ignorar cualquier callback proveniente de otro usuario.

---

## 13. Mensaje de alerta

Cuando se encuentre una cita anterior, enviar un mensaje similar a:

🚨 NUEVA CITA DISPONIBLE

📍 Bogotá
🎫 B2

Nueva cita:
📅 18/12/2026
🕐 08:00

Cita actual:
📅 23/02/2027
🕐 10:30

El mensaje debe contener UN ÚNICO BOTÓN:

🔄 REAGENDAR

No crear botón de cancelar.

No crear botón de confirmación.

No solicitar una segunda confirmación.

Pulsar REAGENDAR constituye la autorización del usuario para intentar realizar el cambio.

---

## 14. Botón REAGENDAR

Cuando el usuario pulse REAGENDAR:

1. Telegram envía el callback al programa.
2. El programa verifica que el callback pertenece al chatId configurado.
3. El programa identifica la fecha y hora de la oportunidad.
4. El programa vuelve a consultar AIS.
5. Comprueba que esa misma fecha/hora continúa disponible.
6. Si continúa disponible, ejecuta el flujo de reagendamiento.
7. Si ya no está disponible, no realiza ningún cambio.
8. En ambos casos, informar el resultado mediante Telegram.

No confiar en que una cita detectada minutos antes continúa disponible.

La segunda consulta inmediatamente antes de reagendar es obligatoria.

---

## 15. Reagendamiento

Implementar una función específica para el proceso de reagendamiento.

La función debe utilizar el flujo real del portal AIS.

No asumir cómo funciona el botón de reagendar.

Inspeccionar el portal y utilizar los controles reales.

Antes de realizar el cambio:

- comprobar que la cita seleccionada sigue disponible;
- asegurarse de que corresponde a una fecha anterior a la cita actual.

Nunca cambiar automáticamente la cita solo porque fue detectada.

El único disparador para intentar un reagendamiento es que el usuario pulse el botón REAGENDAR.

---

## 16. Resultado exitoso

Si el reagendamiento se completa correctamente, enviar algo similar a:

✅ CITA REAGENDADA

📍 Bogotá
📅 18/12/2026
🕐 08:00

El mensaje puede incluir la fecha anterior y la nueva fecha si resulta sencillo obtenerlas.

Actualizar state.json con la nueva cita.

---

## 17. Cita ya tomada

Si después de pulsar REAGENDAR la cita ya no está disponible:

Enviar algo similar a:

❌ LA CITA YA NO ESTÁ DISPONIBLE

La oportunidad fue tomada antes de completar el reagendamiento.

No realizar ningún cambio sobre la cita actual.

Continuar monitoreando.

---

## 18. Errores durante el reagendamiento

Si ocurre un error durante el proceso:

- no repetir automáticamente acciones potencialmente destructivas;
- no intentar múltiples reagendamientos;
- detener el proceso actual;
- informar el error por Telegram;
- conservar la cita actual siempre que sea posible.

Ejemplo:

⚠️ ERROR AL REAGENDAR

No fue posible completar el cambio.

Revisar el navegador para determinar el estado actual.

---

## 19. Evitar alertas duplicadas

Guardar en state.json la última oportunidad notificada.

Ejemplo:

{
  "lastNotification": {
    "date": "2026-12-18",
    "time": "08:00"
  }
}

Si el monitor encuentra nuevamente exactamente la misma fecha/hora, no enviar otra alerta inmediatamente.

No crear un sistema complejo de historial.

---

## 20. Logs

Utilizar console.log().

Los logs deben ser simples y útiles.

Ejemplos:

[2026-09-07 16:30:00] Monitor started
[2026-09-07 16:30:02] Opening AIS
[2026-09-07 16:30:05] Login successful
[2026-09-07 16:30:10] Checking appointments
[2026-09-07 16:30:12] Earliest appointment: 2027-02-23 10:30
[2026-09-07 16:30:12] No earlier appointment found

Cuando aparezca una oportunidad:

[2026-09-07 16:35:12] Earlier appointment found: 2026-12-18 08:00
[2026-09-07 16:35:13] Telegram notification sent

Cuando el usuario pulse el botón:

[2026-09-07 16:40:01] Reschedule requested
[2026-09-07 16:40:03] Rechecking appointment availability

Nunca imprimir credenciales.

---

## 21. Manejo de errores generales

Si una consulta de disponibilidad falla temporalmente:

- registrar el error;
- esperar el intervalo configurado;
- intentar nuevamente.

No terminar el programa por un error temporal.

Si el navegador se cierra inesperadamente, intentar volver a abrirlo de manera sencilla.

No implementar sistemas complejos de recuperación.

---

## 22. Seguridad

No incluir las credenciales en el código fuente.

Usar config.json.

Agregar a .gitignore:

node_modules/
config.json
state.json
playwright/.auth/
.env
.DS_Store

No enviar credenciales mediante Telegram.

No mostrar contraseñas en logs.

---

## 23. Git

El proyecto puede utilizar Git para facilitar el desarrollo local.

No es necesario configurar CI/CD.

No es necesario desplegarlo en ningún servidor.

No subir config.json.

---

## 24. README

Crear un README sencillo con:

1. Requisitos.
2. Instalación.
3. Configuración de config.json.
4. Instalación de Playwright.
5. Cómo crear el bot de Telegram.
6. Cómo obtener el bot token.
7. Cómo obtener el chatId.
8. Cómo ejecutar el monitor.
9. Cómo detenerlo.
10. Qué hacer si AIS solicita CAPTCHA o MFA.

No crear documentación extensa.

---

## 25. package.json

Debe permitir iniciar el programa mediante:

npm install

y:

npm start

El script start debe ejecutar el archivo principal.

---

## 26. Principio de simplicidad

Este proyecto es únicamente para:

1 usuario
1 computador
1 cuenta AIS
1 cuenta de Telegram
1 proceso Node.js

No necesita:

- escalabilidad;
- alta disponibilidad;
- múltiples usuarios;
- múltiples cuentas;
- base de datos;
- backend remoto;
- interfaz web;
- Docker;
- infraestructura cloud.

La prioridad es:

1. Que funcione.
2. Que sea sencillo de entender.
3. Que sea fácil de modificar cuando AIS cambie.
4. Que sea fácil de depurar.

Evitar abstracciones innecesarias.

Preferir código directo sobre patrones de diseño complejos.

---

## 27. Flujo completo esperado

Al ejecutar:

npm start

debe ocurrir:

Node.js inicia
↓
Playwright abre Chromium
↓
AIS
↓
Login
↓
Ir a citas
↓
Consultar disponibilidad
↓
Comparar contra cita actual
↓
¿Existe una cita anterior?

NO:
esperar intervalo
↓
consultar nuevamente

SÍ:
enviar Telegram
↓
mostrar:

[ 🔄 REAGENDAR ]

Usuario pulsa REAGENDAR
↓
volver a consultar AIS
↓
¿La misma cita sigue disponible?

NO:
informar que ya no está disponible
↓
continuar monitoreando

SÍ:
ejecutar reagendamiento
↓
informar resultado
↓
actualizar state.json

---

## 28. Criterio de implementación

Construir primero un MVP funcional.

No agregar funcionalidades que no estén especificadas aquí.

Si durante la implementación AIS presenta un flujo diferente al esperado, adaptar el código al portal real en lugar de inventar una solución.

Si una funcionalidad no puede automatizarse debido a CAPTCHA, MFA o una interacción humana requerida, detenerse y permitir intervención manual.

El resultado final debe ser pequeño, local y funcional.

El objetivo no es crear un sistema empresarial.

El objetivo es automatizar de forma sencilla este flujo personal:

MONITOREAR → ALERTAR → BOTÓN REAGENDAR → VERIFICAR → REAGENDAR.