// Every string the principal reads in the window (es-ES), in one place so it can be reviewed
// at once, as `packages/protocol/src/strings.ts` does for the bot. What ANOMANDER answers in the
// chat is not here: it comes from the daemon, verbatim.

export const MAX_TEXT_LENGTH = 4096;
export const MAX_IMAGES = 10;

export const strings = {
  appName: 'ANOMANDER',
  loading: 'Abriendo…',
  shellUnavailable:
    'No encuentro la parte de la app que arranca a ANOMANDER. Cierra la app y vuelve a abrirla.',

  // Status (DK-6 AC1, DK-1 AC2, DK-2).
  state: {
    running: 'En marcha',
    starting: 'Arrancando…',
    stopped: 'Parado',
    failing: 'Con problemas',
  },
  reason: {
    not_configured: 'Antes de empezar necesito el token del bot de Telegram y tu chat ID.',
    already_running:
      'Ya hay otro ANOMANDER en marcha con estos mismos datos, así que no arranco otro.',
    bot_in_use:
      'Otro ANOMANDER está usando el bot de Telegram, quizá el de Docker. Páralo y vuelve a arrancarme.',
    gave_up: 'Me he parado tras fallar 3 veces en 5 minutos. Este es el último error:',
    stopped_by_principal: 'Me has parado tú. Arráncame cuando quieras.',
  },
  stoppedNoReason: 'Estoy parado.',
  failingNoReason: 'Algo falla y lo estoy reintentando.',
  start: 'Arrancar',
  stop: 'Parar',
  configure: 'Configurar',
  settings: 'Ajustes',
  startFailed: 'No he podido arrancar. Inténtalo otra vez.',
  stopFailed: 'No he podido pararme. Inténtalo otra vez.',

  // Chat (DK-4).
  conversation: 'Conversación',
  emptyTitle: 'Aquí hablamos tú y yo',
  emptyHint:
    'Escríbeme un gasto, como «23 € cena», o arrastra aquí la foto de un ticket. Lo que hablemos aquí también lo sé en Telegram.',
  you: 'Tú',
  composerLabel: 'Mensaje para ANOMANDER',
  composerPlaceholder: 'Escribe un gasto o una pregunta…',
  composerHint: 'Intro para enviar, Mayúsculas+Intro para una línea nueva',
  send: 'Enviar',
  attach: 'Añadir fotos de tickets',
  removeAttachment: (name: string) => `Quitar ${name}`,
  dropHere: 'Suelta aquí el ticket',
  tooManyImages: `Solo puedo recibir ${MAX_IMAGES} imágenes a la vez; he añadido las primeras.`,
  tooLong: (length: number) => `${length} de ${MAX_TEXT_LENGTH} caracteres: es demasiado largo.`,
  tooHeavy: 'Estas imágenes pesan demasiado para enviarlas juntas. Prueba con menos.',
  unreadableFile: 'No he podido abrir ese archivo.',
  sending: 'Enviando…',
  notSent: 'No se ha enviado.',
  retry: 'Reintentar',
  pressNotSent: 'No he recibido tu respuesta. Vuelve a pulsar.',
  chosen: 'Elegido',
  newReply: (text: string) => `ANOMANDER: ${text}`,
  receiptImage: (index: number) => `Imagen ${index} del ticket`,
  noChannel: {
    connecting: 'Conectando con ANOMANDER…',
    stopped: 'ANOMANDER está parado: arráncalo para hablar con él.',
    starting: 'ANOMANDER está arrancando…',
  },

  // Setup (DK-5 AC1).
  setupTitle: 'Configuración',
  setupIntro:
    'Lo que escribas aquí se guarda en el llavero de macOS. Ni yo ni la app lo volvemos a mostrar.',
  back: 'Volver',
  telegramGroup: 'Telegram',
  modelsGroup: 'Modelos',
  botTokenLabel: 'Token del bot de Telegram',
  botTokenHint: 'Te lo da @BotFather al crear el bot.',
  botTokenStored: 'Guardado. Déjalo en blanco para no cambiarlo.',
  chatIdLabel: 'Tu chat ID de Telegram',
  chatIdHint: 'Solo números. Te lo dice @userinfobot.',
  chatIdInvalid: 'El chat ID son solo números.',
  modelLabel: 'Modelo',
  visionModelLabel: 'Modelo de visión',
  modelHint: 'Proveedor y modelo, por ejemplo openai/gpt-4o-mini.',
  visionModelHint: 'El que lee las fotos de los tickets. Por ejemplo openai/gpt-4o-mini.',
  modelInvalid: 'Escríbelo como proveedor/modelo, por ejemplo openai/gpt-4o-mini.',
  botTokenRequired: 'Necesito el token del bot para arrancar.',
  keysTitle: 'Claves de los proveedores',
  keysEmpty: 'Todavía no hay ninguna clave guardada.',
  keyStored: 'Guardada',
  keyNew: 'Nueva, se guarda al pulsar Guardar',
  keyRemoved: 'Se quitará al pulsar Guardar',
  remove: 'Quitar',
  undo: 'No quitar',
  removeKey: (name: string) => `Quitar ${name}`,
  undoRemoveKey: (name: string) => `No quitar ${name}`,
  keyVariableLabel: 'Variable',
  keyVariableOther: 'Otra…',
  keyVariableCustomLabel: 'Nombre de la variable',
  keyVariableInvalid: 'Tiene que acabar en _API_KEY, en mayúsculas, como MISTRAL_API_KEY.',
  keyValueLabel: 'Clave',
  keyValueRequired: 'Escribe la clave antes de añadirla.',
  addKey: 'Añadir clave',
  save: 'Guardar',
  saving: 'Guardando…',
  saveFailed: 'No he podido guardar la configuración. Inténtalo otra vez.',
} as const;
