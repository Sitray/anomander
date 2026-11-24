// Every string the principal reads in the window, in Spanish (`es-ES`) and in English, in one
// place so they can be reviewed together. Nothing else in `src/` may build text for the
// principal. The daemon's own answers are not here: the chat shows them exactly as received
// (DK-4 AC1).
//
// Two voices: the status and the setup describe ANOMANDER from outside, plainly; the chat's own
// lines speak as the bot does in `packages/protocol/src/strings.ts`: first person, warm, short.
//
// The language is the window's (`locale.ts`): each section is read in it at the moment it is
// read, so a section kept in a variable still follows it.

import { type ExpenseMode, type OAuthConnectionName, perLocale } from '@anomander/protocol';

/** DK-17: `2026-11` as the name of its month and its year in `locale`. */
const monthTitle = (locale: string, month: string): string =>
  new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

/** DK-4: how many files one message carries, as the daemon accepts. */
export const MAX_ATTACHMENTS = 10;

const es = {
  status: {
    loading: 'Abriendo…',
    starting: 'Arrancando…',
    running: 'En marcha',
    stopped: 'Parado',
    failing: 'Se ha cerrado',
    notConfigured: 'Falta configurarlo',

    /** DK-1 AC2: the shell is already starting it again. */
    failingDetail: 'ANOMANDER se ha cerrado solo. Arrancando otra vez…',
    reasons: {
      not_configured: 'Para arrancar hace falta elegir un modelo. Telegram es opcional.',
      already_running:
        'Ya hay otro ANOMANDER abierto con estos mismos datos. Cierra el otro y arranca este.',
      bot_in_use:
        'Otro ANOMANDER está usando tu bot de Telegram, por ejemplo el de Docker. Detén el otro y arranca este.',
      gave_up:
        'Ha fallado 3 veces en 5 minutos y ya no se reintenta solo. Mira el error y arráncalo cuando quieras.',
      stopped_by_principal: 'Lo has parado tú.',
    },
    /** Stopped before it ever ran, with no reason from the shell: only the error says why. */
    failedToStart: 'No ha podido arrancar.',

    start: 'Arrancar',
    stop: 'Parar',
    configure: 'Configurar',
    startBusy: 'Arrancando…',
    stopBusy: 'Parando…',
    openSetup: 'Configuración',
    openConnections: 'Conexiones',
    openSubscriptions: 'Suscripciones',
    openExpenses: 'Gastos',
    closeSetup: 'Volver al chat',

    lastError: 'Último error',
    errorDetail: 'Detalle del error',
    showAll: 'Ver todo',
    showLess: 'Ver menos',
    startFailed: 'No se ha podido arrancar.',
    stopFailed: 'No se ha podido parar.',
    dismiss: 'Cerrar aviso',

    /** The window cannot reach its own shell. */
    shellUnreachable: 'La ventana no consigue hablar con la aplicación.',
    retry: 'Reintentar',
  },

  chat: {
    conversation: 'Conversación',
    you: 'Tú',
    bot: 'ANOMANDER',

    emptyTitle: 'Cuéntame un gasto',
    emptyBody:
      'Escríbelo como te salga, por ejemplo «23\u00a0€\u00a0cena», o suelta aquí la foto de un ticket.',

    /** The empty chat while there is no daemon to talk to: it says what to do, not what to type. */
    emptyStopped: {
      title: 'ANOMANDER está parado',
      body: 'Arráncalo para empezar a contarme gastos.',
      /** Not the status bar's "Arrancar": the two are on screen together. */
      action: 'Arrancar ANOMANDER',
    },
    emptyNotConfigured: {
      title: 'Falta configurarlo',
      body: 'Termina la configuración y podrás escribirme aquí.',
    },
    emptyStarting: {
      title: 'Arrancando…',
      body: 'En un momento puedes escribirme.',
    },
    emptyFailing: {
      title: 'Se está reiniciando',
      body: 'ANOMANDER se ha cerrado solo y vuelve a arrancar. Espera un momento.',
    },

    placeholder: 'Escribe algo…',
    message: 'Mensaje',
    send: 'Enviar',
    attach: 'Adjuntar fotos',
    attachments: 'Archivos por enviar',
    removeAttachment: (name: string) => `Quitar ${name}`,
    file: 'Archivo',
    dropHere: 'Suelta aquí el ticket',
    tooMany: `Caben ${MAX_ATTACHMENTS} archivos por mensaje. Me quedo con los ${MAX_ATTACHMENTS} primeros.`,
    tooHeavy: 'Pesan demasiado para ir juntos. Envíalos en varios mensajes.',

    /** The model of the setup, under the composer (S2); read before its name. */
    model: 'Modelo:',

    /** DK-9, DK-13: a look at the screen the daemon routed the principal's words to. */
    screenCapture: 'Captura de pantalla',
    screenUnavailable: 'Desde esta ventana no puedo ver tu pantalla.',
    screenPermission:
      'macOS no me deja ver la pantalla. Actívame en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y audio, y vuelve a abrir ANOMANDER.',
    screenFailed: 'No he podido capturar la pantalla. Prueba otra vez.',

    /** DK-13: a look or a task that did not leave; nothing was done, so it can start again. */
    lookNotSent: 'No he llegado a mirar tu pantalla.',
    taskNotSent: 'No he llegado a empezar la tarea.',
    startAgain: 'Intentar otra vez',
    /** DK-11 AC13: the web search, offered in one press when it is missing. */
    addWebSearch: 'Añadir búsqueda web',
    addingWebSearch: 'Añadiendo…',
    webSearchAdded: 'Búsqueda web añadida. ANOMANDER vuelve a buscarlo en cuanto esté listo.',
    webSearchFailed:
      'No se ha podido añadir la búsqueda web. Inténtalo otra vez o añádela en Conexiones.',
    webSearchAlreadyOn: 'La búsqueda web ya estaba activada. ANOMANDER vuelve a buscarlo.',
    /** The daemon did not come back within a minute: the request is not asked again. */
    webSearchNotBack:
      'La búsqueda web está añadida, pero ANOMANDER no ha vuelto a arrancar en un minuto. Pulsa otra vez cuando esté en marcha.',
    /** The connection was lost while a look or the first step of a task was on its way. */
    startUnknown:
      'Se cortó la conexión y no sé si me llegó. Pídemelo otra vez si aún lo necesitas.',

    /** DK-10: a task on the computer, one allowed step at a time. */
    computerUnavailable: 'Desde esta ventana no puedo usar tu ordenador.',
    /** A routine step: performed without asking. */
    computerAuto: 'Paso rutinario: lo hago sin preguntar.',
    computerRunning: 'Estoy usando tu ordenador…',
    computerStop: 'Detener tarea',
    computerBusy: 'Estoy usando tu ordenador. Detén la tarea o espera a que termine.',
    computerAllow: 'Permitir',
    computerRefuse: 'Detener',
    /** The capture around the point an action would touch. */
    computerPreview: 'Dónde lo haría',
    computerRefused: 'Detenido. No he hecho nada más.',
    /** The step may have been performed: it is never offered again. */
    computerUnknown:
      'No sé si este paso llegó a hacerse. Mira tu pantalla antes de pedírmelo otra vez.',
    /** T1b: what the shell read where a step it asks for would act: `noun` such as "campo". */
    computerSeen: (noun: string, label: string) =>
      label === '' ? `En pantalla: ${noun} sin nombre.` : `En pantalla: ${noun} «${label}».`,
    /** T1b: the step targets an app ANOMANDER never acts on; the task ends. */
    computerBlocked: (app: string) =>
      `No actúo sobre ${app}: es una app protegida. He detenido la tarea.`,
    computerPermission:
      'macOS no me deja usar el ordenador. Actívame en Ajustes del Sistema › Privacidad y seguridad › Accesibilidad y vuelve a abrir ANOMANDER.',

    thinking: 'ANOMANDER está pensando…',

    /** `rejected`, or never left: nothing was done, so sending again is safe. */
    notSent: 'No se ha enviado.',
    sendAgain: 'Enviar otra vez',
    /** The connection was lost in flight: the daemon may have handled it. No resend is offered. */
    unknown:
      'Se cortó la conexión y no sé si me llegó. Puede que ya esté apuntado: compruébalo antes de enviarlo otra vez.',
    pressNotSent: 'Tu respuesta no se ha enviado. Pulsa otra vez.',
    pressUnknown:
      'Se cortó la conexión y no sé si me llegó tu respuesta. Pulsa otra vez: si ya estaba contestada, te lo diré.',
    /** A `{label, url}` button: this window cannot open links. */
    linkOnlyInTelegram: (label: string) => `«${label}» solo se puede abrir desde Telegram.`,

    /** DK-16: a stored message that came through Telegram. */
    viaTelegram: 'Por Telegram',
    /** DK-16: erasing the stored conversation, asked first. */
    clearConversation: 'Borrar conversación',
    confirmClear:
      '¿Borrar la conversación? ANOMANDER la borra de este Mac y deja de tenerla en cuenta. Lo que hay en Telegram sigue en Telegram.',
    confirmClearYes: 'Sí, borrar',
    keepConversation: 'No borrar',
    clearing: 'Borrando…',
    clearFailed: 'No se ha borrado la conversación. Inténtalo otra vez.',
    clearUnknown:
      'Se cortó la conexión y no sé si se ha borrado. Inténtalo otra vez cuando vuelva a conectar.',

    /** Why the composer is disabled. */
    disabled: {
      stopped: 'ANOMANDER está parado. Arráncalo para escribirle.',
      notConfigured: 'Termina la configuración para empezar a escribirle.',
      starting: 'Arrancando… En un momento puedes escribir.',
      failing: 'ANOMANDER se está reiniciando. Espera un momento.',
      connecting: 'Conectando…',
    },
    /** S5: Enter while nothing can be sent; the message stays in the composer. */
    heldBack: (reason: string): string => `Aún no se puede enviar. ${reason}`,
  },

  setup: {
    title: 'Configuración',
    close: 'Volver al chat',
    sectionTelegram: 'Telegram (opcional)',
    sectionModels: 'Modelos',
    intro: 'Las claves se guardan en el llavero de macOS, nunca en un archivo.',

    /** Beside the label of a field the daemon cannot start without, while it is not stored. */
    required: 'Obligatorio',

    botToken: 'Token del bot de Telegram',
    botTokenHelp: 'Te lo da @BotFather en Telegram cuando creas el bot.',
    botTokenStored: 'Guardado. Déjalo en blanco para mantenerlo.',
    botTokenMissing:
      'Falta el token del bot. Telegram necesita el token y tu ID de chat; sin Telegram, deja los dos en blanco.',

    chatId: 'Tu ID de chat',
    chatIdHelp: 'Escribe a @userinfobot en Telegram y te lo dice.',
    chatIdInvalid: 'Tiene que ser un número, como 4242.',
    chatIdMissing:
      'Falta tu ID de chat. Telegram necesita el token y tu ID de chat; sin Telegram, deja los dos en blanco.',

    model: 'Modelo',
    modelHelp: 'Entiende lo que escribes. Va con su proveedor delante.',
    modelExample: 'openai/gpt-4o-mini',
    /** As a placeholder it must read as an example, not as a value already set. */
    modelPlaceholder: 'p. ej. openai/gpt-4o-mini',
    visionModel: 'Modelo para fotos',
    visionModelHelp: 'Lee las fotos de los tickets. Mismo formato que el anterior.',
    modelInvalid: 'Escríbelo con el proveedor delante, como openai/gpt-4o-mini.',
    modelMissing: 'Falta el modelo. Sin él ANOMANDER no puede contestarte.',

    keys: 'Claves de proveedores',
    keysHelp: 'La clave de API del proveedor de cada modelo. Está en su panel de desarrollador.',
    keysNone: 'Todavía no hay ninguna.',
    keyStored: 'Guardada',
    keyNew: 'Nueva, sin guardar',
    keyReplaced: 'Se cambiará al guardar',
    keyRemoved: 'Se quitará al guardar',
    removeKey: (name: string) => `Quitar ${name}`,
    undoKey: (name: string) => `No quitar ${name}`,
    undoKeyChange: (name: string) => `No cambiar ${name}`,
    remove: 'Quitar',
    undo: 'Deshacer',
    provider: 'Proveedor',
    otherProvider: 'Otra…',
    keyName: 'Nombre de la variable',
    keyNameInvalid: 'Tiene que ser como OPENAI_API_KEY: en mayúsculas y acabado en _API_KEY.',
    keyValue: 'Clave',
    keyValueMissing: 'Falta la clave.',
    addKey: 'Añadir',

    save: 'Guardar y arrancar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    fixFields: 'Revisa los campos marcados.',
    /** The shell refused the setup; its own message follows, verbatim. */
    rejected: 'No se ha guardado. Esto dice la aplicación:',
    savedIncomplete: 'Guardado. Para arrancar aún falta el modelo.',
    /** DK-11 AC11: the web search, checked on the first setup. */
    webSearch: 'Añadir la búsqueda web: busca en internet sin usar el ordenador',
    /** The web search was saved before the setup was refused: it stays. */
    webSearchKept:
      'La búsqueda web sí se ha añadido y sigue activada; puedes quitarla en Conexiones.',
  },

  /** DK-11: the servers of `mcp.json`. */
  connections: {
    title: 'Conexiones',
    intro:
      'Los servidores MCP que ANOMANDER usa en una tarea con conexiones. Están en el archivo mcp.json; sus valores, en el llavero de macOS.',
    loading: 'Leyendo…',
    loadFailed: 'No se han podido leer las conexiones.',
    /** The file is not as the daemon reads it; where, in the shell's own words, follows. */
    invalid:
      'El archivo mcp.json no está como ANOMANDER lo lee, así que no se conecta ningún servidor. Corrígelo a mano: desde aquí no se cambia nada.',
    servers: 'Servidores',
    none: 'Todavía no hay ninguno.',
    add: 'Añadir servidor',

    /** DK-11 AC12 (T8): the ready-made connections, one press each. */
    connectors: 'Conectores',
    connectorsIntro:
      'Un botón por servicio. Si el servicio pide permiso, se abre tu navegador para que se lo des.',
    connect: 'Conectar',
    connectFor: (title: string) => `Conectar ${title}`,
    connecting: 'Conectando…',
    connectorConnected: 'Conectado',
    /** The shell refused to save it; its own message follows, verbatim. */
    connectorRejected: (title: string) => `No se ha añadido «${title}». Esto dice la aplicación:`,
    connectorAbout: {
      Notion: 'Tus páginas y bases de datos de Notion.',
      Linear: 'Las incidencias y los proyectos de Linear.',
      Atlassian: 'Jira y Confluence.',
    } satisfies Record<OAuthConnectionName, string>,
    /** T17: the web search connection. */
    webSearch: 'Búsqueda web',
    webSearchAbout: 'Busca en internet sin usar el ordenador.',
    /** DK-11 AC13: an add of the web search that did not answer in time. */
    webSearchTimedOut: 'La búsqueda web no se ha guardado a tiempo. Inténtalo otra vez.',
    webSearchNote:
      'La búsqueda web añade pi-web-access, que viene con ANOMANDER en una versión fija. Lo que ANOMANDER busca se envía a Exa (exa.ai), sin cuenta, y busca sin pedirte permiso; para usar otro buscador o un proxy te lo pide antes. Las páginas se leen desde este Mac, siempre después de «Permitir». Si tienes ~/.pi/agent/web-search.json, se usan sus claves, buscadores y proxy.',
    edit: 'Editar',
    editServer: (name: string) => `Editar ${name}`,
    remove: 'Quitar',
    removeServer: (name: string) => `Quitar ${name}`,
    confirmRemove: (name: string) =>
      `¿Quitar «${name}»? Sus valores guardados se borrarán del llavero.`,
    confirmRemoveYes: 'Sí, quitar',
    keepServer: 'No quitar',
    removing: 'Quitando…',
    /** The shell refused; its own message follows, verbatim. */
    removeRejected: 'No se ha quitado. Esto dice la aplicación:',
    close: 'Cerrar',
    /** The form, for any other server. */
    advanced: 'Avanzado',
    advancedNote:
      'Para cualquier otro servidor MCP: un programa de este Mac o una dirección, escritos a mano.',

    oauthConnected: 'Conectado con OAuth',
    connectOAuth: 'Conectar con OAuth',
    connectOAuthFor: (name: string) => `Conectar ${name} con OAuth`,
    reconnectOAuth: 'Volver a conectar',
    reconnectOAuthFor: (name: string) => `Volver a conectar ${name} con OAuth`,
    forgetOAuth: 'Olvidar OAuth',
    forgetOAuthFor: (name: string) => `Olvidar el acceso OAuth de ${name}`,
    authorizing:
      'Se ha abierto tu navegador: da permiso a ANOMANDER en esa página. Tienes 5 minutos. Puedes cerrar esta pantalla mientras tanto.',
    oauthOutcome: {
      connected: 'Conectado con OAuth.',
      denied: 'No se ha conectado: en el navegador no se dio permiso.',
      timed_out: 'No se ha conectado: el navegador no volvió en 5 minutos.',
    },
    /** The shell's own message follows, verbatim. */
    oauthFailed: 'No se ha podido conectar con OAuth. Esto dice la aplicación:',
    forgetting: 'Olvidando…',
    oauthForgotten: 'Se ha olvidado el acceso OAuth.',
    forgetFailed: 'No se ha olvidado el acceso OAuth. Esto dice la aplicación:',

    newTitle: 'Añadir servidor',
    editTitle: (name: string) => `Editar «${name}»`,
    name: 'Nombre',
    nameHelp: 'Así lo verás en el chat.',
    nameInvalid:
      'Empieza por una letra o un número y lleva solo letras, números, espacios, puntos y guiones: 40 caracteres como mucho.',
    nameTaken: 'Ya hay un servidor con ese nombre.',
    kind: 'Tipo',
    kindProcess: 'Un programa en este Mac',
    kindHttp: 'Un servidor por HTTP',
    command: 'Comando',
    commandHelp: 'El programa que arranca el servidor, como npx.',
    commandMissing: 'Falta el comando.',
    args: 'Argumentos',
    argsHelp: 'Uno por línea.',
    url: 'URL',
    urlHelp: 'Con https. Solo vale http si el servidor está en este Mac.',
    urlInvalid: 'Tiene que empezar por https://, o por http:// si es localhost.',
    /** A program's `env` and a URL's `headers`, in plain words. */
    env: 'Claves y ajustes del programa',
    envHelp:
      'Lo que el programa lee al arrancar, como una clave de API (sus variables de entorno). Los valores se guardan en el llavero de macOS; aquí solo se ve el nombre.',
    headers: 'Claves de acceso',
    headersHelp:
      'Lo que se envía con cada petición, como un token en Authorization (sus cabeceras). Los valores se guardan en el llavero de macOS; aquí solo se ve el nombre.',
    envNone: 'Todavía no hay ninguna.',
    valueStored: 'Guardado',
    valueEmpty: 'Sin valor',
    valueNew: 'Nuevo, sin guardar',
    valueReplaced: 'Se cambiará al guardar',
    valueRemoved: 'Se quitará al guardar',
    removeValue: (name: string) => `Quitar ${name}`,
    undoValue: (name: string) => `No quitar ${name}`,
    undoValueChange: (name: string) => `No cambiar ${name}`,
    envName: 'Nombre, como API_KEY',
    headerName: 'Nombre, como Authorization',
    valueNameMissing: 'Falta el nombre.',
    value: 'Valor',
    valueMissing: 'Falta el valor.',
    addValue: 'Añadir',
    readOnly: 'Herramientas que solo leen',
    readOnlyHelp:
      'Una por línea. Solo estas se usan sin pedirte permiso; cualquier otra espera a que pulses «Permitir». Pon solo las que no cambian nada.',

    save: 'Guardar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    restartNote: 'Al guardar, ANOMANDER se reinicia para leer los cambios.',
  },

  /** DK-15: the subscription logins (R-27), connected and disconnected from the app. */
  subscriptions: {
    title: 'Suscripciones',
    intro:
      'Conecta tu suscripción de ChatGPT o de Kimi Code y ANOMANDER usará sus modelos con ella, sin clave de API. La cuenta se guarda en el llavero de macOS.',
    /** In the setup screen: opens this one. */
    open: '¿Tienes una suscripción de ChatGPT o de Kimi Code? Conéctala',
    loading: 'Leyendo…',
    loadFailed: 'No se han podido leer las cuentas.',
    accounts: 'Cuentas',
    connected: 'Conectada',
    notConnected: 'No conectada',
    connect: 'Conectar',
    connectFor: (account: string) => `Conectar ${account}`,
    disconnect: 'Desconectar',
    disconnectFor: (account: string) => `Desconectar ${account}`,
    disconnecting: 'Desconectando…',
    disconnected: (account: string) => `Desconectado de ${account}.`,
    disconnectFailed: 'No se ha desconectado. Esto dice la aplicación:',

    /** The shell is starting the login; the browser is about to open. */
    starting: 'Abriendo tu navegador…',
    opened: (account: string) =>
      `Se ha abierto tu navegador: entra con tu cuenta de ${account} en esa página. Tienes 10 minutos, y puedes cerrar esta pantalla mientras tanto.`,
    deviceCode: (account: string) =>
      `Se ha abierto tu navegador: escribe este código en esa página para entrar con tu cuenta de ${account}. Tienes 10 minutos.`,
    /** The code to type, read aloud. */
    deviceCodeLabel: 'Código',
    /** ChatGPT: when its redirect to this Mac fails, the address of the error page says it all. */
    pasteLabel: 'Dirección a la que te ha llevado el navegador',
    pasteHelp:
      'Normalmente no hace falta: la página termina sola. Si el navegador acaba en una página de error, copia su dirección completa y pégala aquí.',
    pasteMissing: 'Pega la dirección completa.',
    pasteSend: 'Enviar',
    pasteFailed: 'No se ha podido enviar la dirección. Esto dice la aplicación:',
    outcome: {
      connected: (account: string) => `Conectado con tu cuenta de ${account}.`,
      timed_out: 'No se ha conectado: el navegador no volvió en 10 minutos.',
      cancelled: 'No se ha conectado: se canceló el inicio de sesión.',
    },
    /** The shell's own message follows, verbatim. */
    failed: 'No se ha podido conectar. Esto dice la aplicación:',
    restartNote: 'Al conectar o desconectar una cuenta, ANOMANDER se reinicia para usarla.',
    close: 'Cerrar',
  },

  ledger: {
    title: 'Traer el ledger de Docker',
    /** In the setup screen: opens this one. */
    open: '¿Vienes de una instalación con Docker? Trae tu ledger',
    intro:
      'Si usabas ANOMANDER con Docker, copia su ledger a este Mac y escribe aquí dónde lo has dejado. Solo se importa en un ANOMANDER sin gastos; el ledger que tiene ahora se guarda aparte, nunca se borra.',
    howIntro: 'Para copiarlo, en la carpeta del proyecto, primero una orden y luego la otra:',
    /** Shown as a block the principal can select and copy. */
    howCommands:
      'docker compose stop\ndocker compose cp daemon:/app/data/anomander.db ~/Downloads/anomander.db',
    path: 'Archivo del ledger',
    pathHelp: 'La ruta completa del archivo. Puedes pegarla.',
    pathMissing: 'Escribe la ruta del archivo.',
    pathNotFull: 'Escribe la ruta completa: empieza por / o por ~/.',
    import: 'Importar',
    importing: 'Importando… ANOMANDER se detiene mientras tanto.',
    /** The import failed; the shell's own words follow. */
    failed: 'No se ha podido importar el ledger. El de ANOMANDER sigue como estaba.',
    outcome: {
      imported:
        'Ledger importado: ANOMANDER ya trabaja con él. Si había otro, está guardado aparte en la carpeta de datos.',
      missing: 'No hay ningún archivo en esa ruta.',
      same_file: 'Ese es el ledger que ANOMANDER ya usa.',
      not_a_ledger: 'Ese archivo no es un ledger de ANOMANDER. No se ha importado nada.',
      newer_ledger:
        'Ese ledger es de una versión de ANOMANDER más nueva que esta app. Actualiza la app y vuelve a intentarlo.',
      damaged: 'Ese ledger está dañado. No se ha importado nada.',
      daemon_running:
        'Otro ANOMANDER está usando el ledger de esta app. Detenlo y vuelve a intentarlo.',
      own_has_expenses:
        'Este ANOMANDER ya tiene gastos, así que no se importa nada para no perderlos.',
      not_a_path: 'Escribe la ruta completa: empieza por / o por ~/.',
    },
  },
  /** DK-17: the expenses of a month, read only. */
  expenses: {
    title: 'Gastos',
    intro: 'Lo que ANOMANDER tiene apuntado, mes a mes, y cómo lo sabe.',
    /** `2026-11` → `noviembre de 2026`. */
    month: (month: string): string => monthTitle('es-ES', month),
    previous: 'Mes anterior',
    next: 'Mes siguiente',
    caption: (month: string) => `Gastos de ${month}`,
    date: 'Fecha',
    merchant: 'Comercio',
    category: 'Categoría',
    amount: 'Importe',
    mode: 'Cómo lo sé',
    /** The header of the per-row action's column, shown only once there is one (DK-17 AC6). */
    actions: 'Acciones',
    noMerchant: 'Sin comercio',
    noCategory: 'Sin categoría',
    lines: (count: number) => (count === 1 ? '1 línea' : `${count} líneas`),
    /** Principle 2: the `modo` of the `gastos` view, for the whole expense. */
    modes: {
      declared: 'Me lo dijiste',
      confirmed: 'Lo confirmaste',
      corroborated: 'Deducido y comprobado',
      inferred: 'Deducido',
    } satisfies Record<ExpenseMode, string>,
    total: 'Total',
    pending: (count: number, amount: string) =>
      count === 1
        ? `1 gasto pendiente de confirmar (${amount}), fuera del total.`
        : `${count} gastos pendientes de confirmar (${amount}), fuera del total.`,
    empty: (month: string) => `No hay gastos apuntados en ${month}.`,
    loading: 'Cargando gastos…',
    failed: 'No se han podido cargar los gastos.',
    retry: 'Reintentar',
    closed: 'ANOMANDER no está en marcha. Arráncalo para ver tus gastos.',
  },
} as const;

/** The shape of the text, the same in every language: the Spanish keys and parameters. */
type Text<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { readonly [K in keyof T]: Text<T[K]> };

export type Strings = Text<typeof es>;

const en: Strings = {
  status: {
    loading: 'Opening…',
    starting: 'Starting…',
    running: 'Running',
    stopped: 'Stopped',
    failing: 'Closed unexpectedly',
    notConfigured: 'Not set up yet',

    failingDetail: 'ANOMANDER closed on its own. Starting it again…',
    reasons: {
      not_configured: 'To start, choose a model. Telegram is optional.',
      already_running:
        'Another ANOMANDER is already open with this same data. Close the other one and start this one.',
      bot_in_use:
        'Another ANOMANDER is using your Telegram bot, for example the one in Docker. Stop the other one and start this one.',
      gave_up:
        'It failed 3 times in 5 minutes and no longer retries on its own. Check the error and start it when you like.',
      stopped_by_principal: 'You stopped it.',
    },
    failedToStart: 'It could not start.',

    start: 'Start',
    stop: 'Stop',
    configure: 'Set up',
    startBusy: 'Starting…',
    stopBusy: 'Stopping…',
    openSetup: 'Settings',
    openConnections: 'Connections',
    openSubscriptions: 'Subscriptions',
    openExpenses: 'Expenses',
    closeSetup: 'Back to chat',

    lastError: 'Last error',
    errorDetail: 'Error details',
    showAll: 'Show all',
    showLess: 'Show less',
    startFailed: 'It could not start.',
    stopFailed: 'It could not stop.',
    dismiss: 'Dismiss',

    shellUnreachable: 'The window cannot reach the app.',
    retry: 'Try again',
  },

  chat: {
    conversation: 'Conversation',
    you: 'You',
    bot: 'ANOMANDER',

    emptyTitle: 'Tell me about an expense',
    emptyBody:
      'Write it however it comes to you, for example “€23 dinner”, or drop a photo of a receipt here.',

    emptyStopped: {
      title: 'ANOMANDER is stopped',
      body: 'Start it to begin telling me your expenses.',
      action: 'Start ANOMANDER',
    },
    emptyNotConfigured: {
      title: 'Not set up yet',
      body: 'Finish the setup and you can write to me here.',
    },
    emptyStarting: {
      title: 'Starting…',
      body: 'You can write to me in a moment.',
    },
    emptyFailing: {
      title: 'Restarting',
      body: 'ANOMANDER closed on its own and is starting again. Wait a moment.',
    },

    placeholder: 'Write something…',
    message: 'Message',
    send: 'Send',
    attach: 'Attach photos',
    attachments: 'Files to send',
    removeAttachment: (name: string) => `Remove ${name}`,
    file: 'File',
    dropHere: 'Drop the receipt here',
    tooMany: `A message holds ${MAX_ATTACHMENTS} files. I'm keeping the first ${MAX_ATTACHMENTS}.`,
    tooHeavy: 'They are too heavy to go together. Send them in several messages.',

    model: 'Model:',

    screenCapture: 'Screenshot',
    screenUnavailable: "I can't see your screen from this window.",
    screenPermission:
      "macOS won't let me see the screen. Turn me on in System Settings › Privacy & Security › Screen & System Audio Recording, and open ANOMANDER again.",
    screenFailed: "I couldn't take a screenshot. Try again.",

    lookNotSent: "I didn't get to look at your screen.",
    taskNotSent: "I didn't get to start the task.",
    startAgain: 'Try again',
    /** DK-11 AC13: the web search, offered in one press when it is missing. */
    addWebSearch: 'Add web search',
    addingWebSearch: 'Adding…',
    webSearchAdded: 'Web search added. ANOMANDER searches again as soon as it is ready.',
    webSearchFailed: "Web search couldn't be added. Try again, or add it in Connections.",
    webSearchAlreadyOn: 'Web search was already on. ANOMANDER searches again.',
    webSearchNotBack:
      "Web search is added, but ANOMANDER didn't start again within a minute. Press again once it is running.",
    startUnknown:
      "The connection dropped and I don't know if it reached me. Ask me again if you still need it.",

    computerUnavailable: "I can't use your computer from this window.",
    computerAuto: 'Routine step: I do it without asking.',
    computerRunning: "I'm using your computer…",
    computerStop: 'Stop task',
    computerBusy: "I'm using your computer. Stop the task or wait for it to finish.",
    computerAllow: 'Allow',
    computerRefuse: 'Stop',
    computerPreview: "Where I'd do it",
    computerRefused: "Stopped. I haven't done anything else.",
    computerUnknown:
      "I don't know if this step went through. Look at your screen before asking me again.",
    computerSeen: (noun: string, label: string) =>
      label === '' ? `On screen: an unnamed ${noun}.` : `On screen: the ${noun} “${label}”.`,
    computerBlocked: (app: string) =>
      `I don't act on ${app}: it's a protected app. I've stopped the task.`,
    computerPermission:
      "macOS won't let me use the computer. Turn me on in System Settings › Privacy & Security › Accessibility and open ANOMANDER again.",

    thinking: 'ANOMANDER is thinking…',

    notSent: 'Not sent.',
    sendAgain: 'Send again',
    unknown:
      "The connection dropped and I don't know if it reached me. It may already be recorded: check before sending it again.",
    pressNotSent: "Your answer wasn't sent. Press again.",
    pressUnknown:
      "The connection dropped and I don't know if your answer reached me. Press again: if it was already answered, I'll tell you.",
    linkOnlyInTelegram: (label: string) => `“${label}” can only be opened from Telegram.`,

    viaTelegram: 'Via Telegram',
    clearConversation: 'Erase conversation',
    confirmClear:
      'Erase the conversation? ANOMANDER erases it from this Mac and stops taking it into account. What is in Telegram stays in Telegram.',
    confirmClearYes: 'Yes, erase',
    keepConversation: "Don't erase",
    clearing: 'Erasing…',
    clearFailed: "The conversation wasn't erased. Try again.",
    clearUnknown:
      "The connection dropped and I don't know if it was erased. Try again once it connects.",

    disabled: {
      stopped: 'ANOMANDER is stopped. Start it to write to it.',
      notConfigured: 'Finish the setup to start writing to it.',
      starting: 'Starting… You can write in a moment.',
      failing: 'ANOMANDER is restarting. Wait a moment.',
      connecting: 'Connecting…',
    },
    heldBack: (reason: string): string => `It can't be sent yet. ${reason}`,
  },

  setup: {
    title: 'Settings',
    close: 'Back to chat',
    sectionTelegram: 'Telegram (optional)',
    sectionModels: 'Models',
    intro: 'Keys are kept in the macOS Keychain, never in a file.',

    required: 'Required',

    botToken: 'Telegram bot token',
    botTokenHelp: '@BotFather gives it to you in Telegram when you create the bot.',
    botTokenStored: 'Saved. Leave it blank to keep it.',
    botTokenMissing:
      'The bot token is missing. Telegram needs the token and your chat ID; without Telegram, leave both blank.',

    chatId: 'Your chat ID',
    chatIdHelp: 'Message @userinfobot in Telegram and it tells you.',
    chatIdInvalid: 'It has to be a number, like 4242.',
    chatIdMissing:
      'Your chat ID is missing. Telegram needs the token and your chat ID; without Telegram, leave both blank.',

    model: 'Model',
    modelHelp: 'It understands what you write. Its provider goes first.',
    modelExample: 'openai/gpt-4o-mini',
    modelPlaceholder: 'e.g. openai/gpt-4o-mini',
    visionModel: 'Model for photos',
    visionModelHelp: 'It reads the photos of receipts. Same format as the one above.',
    modelInvalid: 'Write it with the provider first, like openai/gpt-4o-mini.',
    modelMissing: "The model is missing. Without it ANOMANDER can't answer you.",

    keys: 'Provider keys',
    keysHelp: "The API key of each model's provider. It's in their developer dashboard.",
    keysNone: 'None yet.',
    keyStored: 'Saved',
    keyNew: 'New, not saved',
    keyReplaced: 'Changes on save',
    keyRemoved: 'Removed on save',
    removeKey: (name: string) => `Remove ${name}`,
    undoKey: (name: string) => `Keep ${name}`,
    undoKeyChange: (name: string) => `Don't change ${name}`,
    remove: 'Remove',
    undo: 'Undo',
    provider: 'Provider',
    otherProvider: 'Other…',
    keyName: 'Variable name',
    keyNameInvalid: 'It has to be like OPENAI_API_KEY: in capitals and ending in _API_KEY.',
    keyValue: 'Key',
    keyValueMissing: 'The key is missing.',
    addKey: 'Add',

    save: 'Save and start',
    saving: 'Saving…',
    cancel: 'Cancel',
    fixFields: 'Check the marked fields.',
    rejected: 'Not saved. This is what the app says:',
    savedIncomplete: 'Saved. It still needs the model to start.',
    /** DK-11 AC11: the web search, checked on the first setup. */
    webSearch: 'Add web search: searches the internet without using the computer',
    webSearchKept: 'Web search was added and stays on; you can remove it in Connections.',
  },

  connections: {
    title: 'Connections',
    intro:
      'The MCP servers ANOMANDER uses in a task with connections. They are in the mcp.json file; their values, in the macOS Keychain.',
    loading: 'Reading…',
    loadFailed: 'The connections could not be read.',
    invalid:
      "The mcp.json file isn't as ANOMANDER reads it, so no server connects. Fix it by hand: nothing can be changed from here.",
    servers: 'Servers',
    none: 'None yet.',
    add: 'Add server',

    connectors: 'Connectors',
    connectorsIntro:
      'One button per service. If the service asks for permission, your browser opens so you can give it.',
    connect: 'Connect',
    connectFor: (title: string) => `Connect ${title}`,
    connecting: 'Connecting…',
    connectorConnected: 'Connected',
    connectorRejected: (title: string) => `“${title}” was not added. This is what the app says:`,
    connectorAbout: {
      Notion: 'Your Notion pages and databases.',
      Linear: 'Linear issues and projects.',
      Atlassian: 'Jira and Confluence.',
    },
    webSearch: 'Web search',
    webSearchAbout: 'Searches the internet without using the computer.',
    webSearchTimedOut: "Web search wasn't saved in time. Try again.",
    webSearchNote:
      'Web search adds pi-web-access, which comes with ANOMANDER at a fixed version. What ANOMANDER searches for is sent to Exa (exa.ai), with no account, and it searches without asking you; to use another search engine or a proxy it asks you first. Pages are read from this Mac, always after “Allow”. If you have ~/.pi/agent/web-search.json, its keys, search engines and proxy are used.',
    edit: 'Edit',
    editServer: (name: string) => `Edit ${name}`,
    remove: 'Remove',
    removeServer: (name: string) => `Remove ${name}`,
    confirmRemove: (name: string) =>
      `Remove “${name}”? Its saved values will be deleted from the Keychain.`,
    confirmRemoveYes: 'Yes, remove',
    keepServer: "Don't remove",
    removing: 'Removing…',
    removeRejected: 'Not removed. This is what the app says:',
    close: 'Close',
    advanced: 'Advanced',
    advancedNote: 'For any other MCP server: a program on this Mac or an address, written by hand.',

    oauthConnected: 'Connected with OAuth',
    connectOAuth: 'Connect with OAuth',
    connectOAuthFor: (name: string) => `Connect ${name} with OAuth`,
    reconnectOAuth: 'Reconnect',
    reconnectOAuthFor: (name: string) => `Reconnect ${name} with OAuth`,
    forgetOAuth: 'Forget OAuth',
    forgetOAuthFor: (name: string) => `Forget the OAuth access of ${name}`,
    authorizing:
      'Your browser has opened: give ANOMANDER permission on that page. You have 5 minutes. You can close this screen in the meantime.',
    oauthOutcome: {
      connected: 'Connected with OAuth.',
      denied: 'Not connected: permission was not given in the browser.',
      timed_out: 'Not connected: the browser did not come back within 5 minutes.',
    },
    oauthFailed: 'Could not connect with OAuth. This is what the app says:',
    forgetting: 'Forgetting…',
    oauthForgotten: 'The OAuth access has been forgotten.',
    forgetFailed: 'The OAuth access was not forgotten. This is what the app says:',

    newTitle: 'Add server',
    editTitle: (name: string) => `Edit “${name}”`,
    name: 'Name',
    nameHelp: "That's how you'll see it in the chat.",
    nameInvalid:
      'It starts with a letter or a number and has only letters, numbers, spaces, dots and hyphens: 40 characters at most.',
    nameTaken: 'There is already a server with that name.',
    kind: 'Type',
    kindProcess: 'A program on this Mac',
    kindHttp: 'A server over HTTP',
    command: 'Command',
    commandHelp: 'The program that starts the server, like npx.',
    commandMissing: 'The command is missing.',
    args: 'Arguments',
    argsHelp: 'One per line.',
    url: 'URL',
    urlHelp: 'With https. Plain http only works if the server is on this Mac.',
    urlInvalid: 'It has to start with https://, or with http:// if it is localhost.',
    env: 'Program keys and settings',
    envHelp:
      'What the program reads when it starts, like an API key (its environment variables). The values are kept in the macOS Keychain; only the name shows here.',
    headers: 'Access keys',
    headersHelp:
      'What is sent with each request, like a token in Authorization (its headers). The values are kept in the macOS Keychain; only the name shows here.',
    envNone: 'None yet.',
    valueStored: 'Saved',
    valueEmpty: 'No value',
    valueNew: 'New, not saved',
    valueReplaced: 'Changes on save',
    valueRemoved: 'Removed on save',
    removeValue: (name: string) => `Remove ${name}`,
    undoValue: (name: string) => `Keep ${name}`,
    undoValueChange: (name: string) => `Don't change ${name}`,
    envName: 'Name, like API_KEY',
    headerName: 'Name, like Authorization',
    valueNameMissing: 'The name is missing.',
    value: 'Value',
    valueMissing: 'The value is missing.',
    addValue: 'Add',
    readOnly: 'Tools that only read',
    readOnlyHelp:
      'One per line. Only these are used without asking you; any other waits until you press “Allow”. List only the ones that change nothing.',

    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    restartNote: 'On saving, ANOMANDER restarts to read the changes.',
  },

  subscriptions: {
    title: 'Subscriptions',
    intro:
      'Connect your ChatGPT or Kimi Code subscription and ANOMANDER will use its models with it, with no API key. The account is kept in the macOS Keychain.',
    open: 'Have a ChatGPT or Kimi Code subscription? Connect it',
    loading: 'Reading…',
    loadFailed: 'The accounts could not be read.',
    accounts: 'Accounts',
    connected: 'Connected',
    notConnected: 'Not connected',
    connect: 'Connect',
    connectFor: (account: string) => `Connect ${account}`,
    disconnect: 'Disconnect',
    disconnectFor: (account: string) => `Disconnect ${account}`,
    disconnecting: 'Disconnecting…',
    disconnected: (account: string) => `Disconnected from ${account}.`,
    disconnectFailed: 'Not disconnected. This is what the app says:',

    starting: 'Opening your browser…',
    opened: (account: string) =>
      `Your browser has opened: sign in with your ${account} account on that page. You have 10 minutes, and you can close this screen in the meantime.`,
    deviceCode: (account: string) =>
      `Your browser has opened: type this code on that page to sign in with your ${account} account. You have 10 minutes.`,
    deviceCodeLabel: 'Code',
    pasteLabel: 'The address the browser took you to',
    pasteHelp:
      "Usually you don't need this: the page finishes on its own. If the browser ends up on an error page, copy its full address and paste it here.",
    pasteMissing: 'Paste the full address.',
    pasteSend: 'Send',
    pasteFailed: 'The address could not be sent. This is what the app says:',
    outcome: {
      connected: (account: string) => `Connected with your ${account} account.`,
      timed_out: 'Not connected: the browser did not come back within 10 minutes.',
      cancelled: 'Not connected: the sign-in was cancelled.',
    },
    failed: 'Could not connect. This is what the app says:',
    restartNote: 'When an account is connected or disconnected, ANOMANDER restarts to use it.',
    close: 'Close',
  },

  ledger: {
    title: 'Bring the ledger from Docker',
    open: 'Coming from a Docker install? Bring your ledger',
    intro:
      'If you used ANOMANDER with Docker, copy its ledger to this Mac and write here where you left it. It is only imported into an ANOMANDER with no expenses; the ledger it has now is kept aside, never deleted.',
    howIntro: 'To copy it, in the project folder, run one command and then the other:',
    howCommands:
      'docker compose stop\ndocker compose cp daemon:/app/data/anomander.db ~/Downloads/anomander.db',
    path: 'Ledger file',
    pathHelp: 'The full path of the file. You can paste it.',
    pathMissing: 'Write the path of the file.',
    pathNotFull: 'Write the full path: it starts with / or ~/.',
    import: 'Import',
    importing: 'Importing… ANOMANDER stops in the meantime.',
    failed: "The ledger could not be imported. ANOMANDER's stays as it was.",
    outcome: {
      imported:
        'Ledger imported: ANOMANDER now works with it. If there was another one, it is kept aside in the data folder.',
      missing: 'There is no file at that path.',
      same_file: 'That is the ledger ANOMANDER already uses.',
      not_a_ledger: 'That file is not an ANOMANDER ledger. Nothing was imported.',
      newer_ledger:
        'That ledger is from a newer version of ANOMANDER than this app. Update the app and try again.',
      damaged: 'That ledger is damaged. Nothing was imported.',
      daemon_running: "Another ANOMANDER is using this app's ledger. Stop it and try again.",
      own_has_expenses:
        'This ANOMANDER already has expenses, so nothing is imported, so as not to lose them.',
      not_a_path: 'Write the full path: it starts with / or ~/.',
    },
  },
  expenses: {
    title: 'Expenses',
    intro: 'What ANOMANDER has noted down, month by month, and how it knows.',
    month: (month: string): string => monthTitle('en-GB', month),
    previous: 'Previous month',
    next: 'Next month',
    caption: (month: string) => `Expenses of ${month}`,
    date: 'Date',
    merchant: 'Merchant',
    category: 'Category',
    amount: 'Amount',
    mode: 'How I know',
    actions: 'Actions',
    noMerchant: 'No merchant',
    noCategory: 'No category',
    lines: (count: number) => (count === 1 ? '1 line' : `${count} lines`),
    modes: {
      declared: 'You told me',
      confirmed: 'You confirmed it',
      corroborated: 'Inferred and checked',
      inferred: 'Inferred',
    },
    total: 'Total',
    pending: (count: number, amount: string) =>
      count === 1
        ? `1 expense waiting for confirmation (${amount}), not in the total.`
        : `${count} expenses waiting for confirmation (${amount}), not in the total.`,
    empty: (month: string) => `No expenses noted down in ${month}.`,
    loading: 'Loading expenses…',
    failed: 'The expenses could not be loaded.',
    retry: 'Try again',
    closed: 'ANOMANDER is not running. Start it to see your expenses.',
  },
};

/** The text of the window, each section in the window's language at the moment it is read. */
export const strings: Strings = {
  status: perLocale<Strings['status']>({ es: es.status, en: en.status }),
  chat: perLocale<Strings['chat']>({ es: es.chat, en: en.chat }),
  setup: perLocale<Strings['setup']>({ es: es.setup, en: en.setup }),
  connections: perLocale<Strings['connections']>({ es: es.connections, en: en.connections }),
  subscriptions: perLocale<Strings['subscriptions']>({
    es: es.subscriptions,
    en: en.subscriptions,
  }),
  ledger: perLocale<Strings['ledger']>({ es: es.ledger, en: en.ledger }),
  expenses: perLocale<Strings['expenses']>({ es: es.expenses, en: en.expenses }),
};
