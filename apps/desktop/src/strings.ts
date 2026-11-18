// Every string the principal reads in the window (`es-ES`), in one place so they can be reviewed
// together. Nothing else in `src/` may build text for the principal. The daemon's own answers
// are not here: the chat shows them exactly as received (DK-4 AC1).
//
// Two voices: the status and the setup describe ANOMANDER from outside, plainly; the chat's own
// lines speak as the bot does in `packages/protocol/src/strings.ts`: first person, warm, short.

/** DK-4: how many files one message carries, as the daemon accepts. */
export const MAX_ATTACHMENTS = 10;

export const strings = {
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
      not_configured: 'Para arrancar hacen falta el token de tu bot de Telegram y tu ID de chat.',
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

    /** A look at the screen: the capture waits in the composer, in sight, until it is sent. */
    screen: 'Preguntar por mi pantalla',
    screenCapture: 'Captura de pantalla',
    /** What is asked when a capture is sent with no words. */
    screenQuestion: '¿Qué ves en mi pantalla?',
    screenAlone: 'La captura va sola: envía los tickets en otro mensaje.',
    screenPermission:
      'macOS no me deja ver la pantalla. Actívame en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y audio, y vuelve a abrir ANOMANDER.',
    screenFailed: 'No he podido capturar la pantalla. Prueba otra vez.',

    /** DK-11: a task with the servers the principal connected. */
    connect: 'Usar mis conexiones',
    connectMode:
      'Voy a usar tus conexiones. Lo que solo lee lo hago sin preguntar; antes de cualquier otra cosa te enseño qué quiero hacer y espero tu permiso.',
    connectPlaceholder: '¿Qué hago con tus conexiones?',
    connectAlone: 'Una tarea con conexiones va sin archivos. Quítalos o envíalos antes.',

    /** DK-10: a task on the computer, one allowed step at a time. */
    computer: 'Hacer algo en mi ordenador',
    computerMode:
      'Voy a usar tu ordenador. Los pasos rutinarios los hago sin preguntar; antes de algo delicado te enseño qué quiero hacer y espero tu permiso.',
    computerPlaceholder: '¿Qué hago en tu ordenador?',
    computerAlone: 'Una tarea en el ordenador va sin archivos. Quítalos o envíalos antes.',
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

    /** Why the composer is disabled. */
    disabled: {
      stopped: 'ANOMANDER está parado. Arráncalo para escribirle.',
      notConfigured: 'Termina la configuración para empezar a escribirle.',
      starting: 'Arrancando… En un momento puedes escribir.',
      failing: 'ANOMANDER se está reiniciando. Espera un momento.',
      connecting: 'Conectando…',
    },
  },

  setup: {
    title: 'Configuración',
    close: 'Volver al chat',
    sectionTelegram: 'Telegram',
    sectionModels: 'Modelos',
    intro: 'Las claves se guardan en el llavero de macOS, nunca en un archivo.',

    botToken: 'Token del bot de Telegram',
    botTokenHelp: 'Te lo da @BotFather en Telegram cuando creas el bot.',
    botTokenStored: 'Guardado. Déjalo en blanco para mantenerlo.',

    chatId: 'Tu ID de chat',
    chatIdHelp: 'Escribe a @userinfobot en Telegram y te lo dice.',
    chatIdInvalid: 'Tiene que ser un número, como 4242.',

    model: 'Modelo',
    modelHelp: 'Entiende lo que escribes. Va con su proveedor delante.',
    modelExample: 'openai/gpt-4o-mini',
    visionModel: 'Modelo para fotos',
    visionModelHelp: 'Lee las fotos de los tickets. Mismo formato que el anterior.',
    modelInvalid: 'Escríbelo con el proveedor delante, como openai/gpt-4o-mini.',

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
    savedIncomplete: 'Guardado. Para arrancar aún faltan el token del bot y tu ID de chat.',
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
    env: 'Variables de entorno',
    headers: 'Cabeceras',
    valuesHelp: 'Sus valores se guardan en el llavero de macOS. Aquí solo se ve el nombre.',
    envNone: 'Todavía no hay ninguna.',
    valueStored: 'Guardado',
    valueEmpty: 'Sin valor',
    valueNew: 'Nuevo, sin guardar',
    valueReplaced: 'Se cambiará al guardar',
    valueRemoved: 'Se quitará al guardar',
    removeValue: (name: string) => `Quitar ${name}`,
    undoValue: (name: string) => `No quitar ${name}`,
    undoValueChange: (name: string) => `No cambiar ${name}`,
    envName: 'Nombre de la variable',
    headerName: 'Nombre de la cabecera',
    valueNameMissing: 'Falta el nombre.',
    value: 'Valor',
    valueMissing: 'Falta el valor.',
    addValue: 'Añadir',
    readOnly: 'Herramientas de solo lectura',
    readOnlyHelp: 'Una por línea. Solo estas se usan sin pedirte permiso.',

    save: 'Guardar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    restartNote: 'Al guardar, ANOMANDER se reinicia para leer los cambios.',
  },

  ledger: {
    title: 'Traer el ledger de Docker',
    /** In the setup screen: opens this one. */
    open: '¿Vienes de una instalación con Docker? Trae tu ledger',
    intro:
      'Si usabas ANOMANDER con Docker, copia su ledger a este Mac y escribe aquí dónde lo has dejado. Solo se importa en un ANOMANDER sin gastos; el ledger que tiene ahora se guarda aparte, nunca se borra.',
    how: 'Para copiarlo, en la carpeta del proyecto: docker compose stop y después docker compose cp daemon:/app/data/anomander.db ~/Downloads/anomander.db',
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
} as const;
