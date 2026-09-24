# Preparar WhatsApp Agents Bridge en Windows

Esta guía descarga y comprueba el bridge desde PowerShell. Es un componente para que otra aplicación se conecte a WhatsApp: no instala una ventana de chat, no incluye agentes y no vincula una cuenta automáticamente.

Puedes instalarlo y ejecutar todas sus pruebas sin una cuenta de WhatsApp ni claves. Para usarlo con una cuenta real, una aplicación supervisora debe administrar las claves persistentes y ofrecer el flujo de vinculación al dueño de la cuenta.

## 1. Instalar Git y Node.js

Instala [Git para Windows](https://git-scm.com/download/win) y [Node.js](https://nodejs.org/en/download). Se necesita Node.js 24 o superior. La versión fijada para las comprobaciones del proyecto está en [`.nvmrc`](../.nvmrc).

Cierra y vuelve a abrir PowerShell después de instalarlos. Comprueba que estén disponibles:

```powershell
git --version
node --version
npm.cmd --version
```

La versión de Node debe empezar por `v24` o corresponder a una versión posterior. Esta guía usa `npm.cmd` para evitar que PowerShell intente ejecutar el archivo `npm.ps1`; no hace falta cambiar la política de ejecución del equipo.

## 2. Descargar e instalar el código

Estos comandos crean una carpeta `Projects` dentro de tu carpeta de usuario y descargan allí el repositorio:

```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\Projects" -Force | Out-Null
Set-Location "$env:USERPROFILE\Projects"
git clone https://github.com/otro-felipe/whatsapp-agents-bridge.git
Set-Location ".\whatsapp-agents-bridge"
npm.cmd ci --ignore-scripts
```

`npm ci` instala las versiones registradas en el lockfile. `--ignore-scripts` evita ejecutar scripts de instalación de las dependencias. Mantén esta ventana en la carpeta del repositorio para los pasos siguientes.

## 3. Comprobar la instalación

```powershell
npm.cmd run validate
npm.cmd run format:check
```

`validate` ejecuta las pruebas sintéticas, revisa TypeScript y compila el programa en `dist`. Usa bases de datos temporales e identidades ficticias; no contacta WhatsApp, no muestra QR ni envía mensajes reales. `format:check` comprueba el formato de los archivos sin modificarlos.

Para recompilar después de modificar el código:

```powershell
npm.cmd run build
```

El proyecto tiene comprobaciones de CI para Windows, Linux y macOS. Revisa el resultado de la revisión que descargaste en [GitHub Actions](https://github.com/otro-felipe/whatsapp-agents-bridge/actions). Que los comandos funcionen en otro sistema no demuestra que esa revisión haya pasado en Windows; las pruebas sintéticas tampoco verifican una vinculación o entrega real.

## 4. Uso con una aplicación supervisora

La aplicación que integra el bridge debe conservar un token y una clave maestra estable en su almacén protegido. La clave maestra permite abrir el estado cifrado después de reiniciar: no debe generarse una distinta en cada arranque. El bridge no ofrece una pantalla para administrar esas claves.

El ejemplo `serve-from-env.mjs` sirve únicamente cuando esa aplicación ya ha inyectado `WHATSAPP_BRIDGE_TOKEN` y `WHATSAPP_BRIDGE_MASTER_KEY` en el entorno del proceso. No pegues ni imprimas sus valores en PowerShell, no los pongas en argumentos y no los guardes en este repositorio. Si aún no tienes una aplicación que administre esas claves, termina en el paso 3.

Con ese entorno ya preparado por el host, el comando de arranque es:

```powershell
$bridgeState = Join-Path $env:LOCALAPPDATA "WhatsApp Agents Bridge\state"
node .\examples\serve-from-env.mjs --port 0 --data-dir "$bridgeState"
```

La ruta entre comillas admite espacios y deja el estado fuera del repositorio. El puerto `0` solicita un puerto local disponible. La única salida de disponibilidad del bridge es un objeto como `{"port":12345}`: no es una clave ni una interfaz web para abrir en el navegador.

El wrapper entrega las claves al hijo por su entrada privada y elimina esas variables del entorno del hijo. No crea ni guarda claves. Para cerrar el wrapper desde la terminal, pulsa **Ctrl+C**: solicita el cierre del hijo mediante IPC. Al integrar el CLI directamente, el host debe hacer la entrega de claves por stdin y abrir un canal IPC de Node para enviar el objeto exacto `{type:"shutdown"}`, sin campos adicionales, al cerrar. La desconexión de ese canal también cierra el bridge; esto permite un cierre ordenado en Windows sin depender de señales POSIX. Evita finalizarlo por fuerza desde el Administrador de tareas como mecanismo habitual.

Arrancar una instalación ya vinculada puede reconectar su cuenta. Vincular una nueva cuenta requiere una acción explícita del dueño en la aplicación supervisora. Las pruebas y los pasos de instalación anteriores no realizan esa acción.

## Estado privado y problemas habituales

En Windows, el bridge usa el PowerShell 5.1 incluido en el sistema para aplicar y verificar permisos privados mediante ACL antes de escribir contenido privado. Necesita un disco con permisos persistentes, como NTFS o ReFS; FAT y exFAT no sirven para este estado privado. La DACL permite sólo al usuario actual y desactiva la herencia de permisos. Un administrador del sistema todavía puede tomar control de los archivos.

Los modos `0700` y `0600` corresponden a Linux y macOS, no sustituyen las ACL de Windows. Si no puede establecer o verificar los permisos necesarios, la operación falla; no debes quitar esas comprobaciones para continuar. Usa una carpeta local dedicada bajo `%LOCALAPPDATA%` y evita ubicaciones compartidas o dentro del checkout. También se rechazan enlaces o puntos de redirección al preparar el almacenamiento.

- **`git`, `node` o `npm.cmd` no se reconoce:** cierra PowerShell y vuelve a abrirlo después de la instalación; comprueba que instalaste Git y Node.js.
- **La versión de Node es menor que 24:** instala una versión compatible y comprueba de nuevo `node --version`.
- **Ya existe la carpeta del repositorio:** entra en ella con `Set-Location` y omite el comando `git clone`.
- **Aparece `Protected environment configuration is required.`:** la aplicación supervisora debe proporcionar ambas claves mediante su mecanismo protegido; no las copies al chat ni al terminal para diagnosticarlo.
- **Aparece `private_storage_permissions_failed`:** comprueba que la carpeta sea local y dedicada, que el disco permita ACL persistentes y que Windows PowerShell esté disponible.
- **Falla una prueba o la comprobación de permisos:** conserva sólo el código de error y el nombre de la prueba. No compartas claves, QR, códigos de vinculación, bases de datos ni conversaciones reales.

Consulta el [README](../README.md) para el contrato HTTP, SSE, SDK y MCP, la retención de datos y los límites de seguridad.
