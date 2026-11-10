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
} as const;
