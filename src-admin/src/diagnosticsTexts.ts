// Fleet master (.consistency-master/src-admin/src/diagnosticsTexts.ts) — never edit the copy in an adapter.
//
// The words of the diagnostics card, the same in every adapter: the card texts krobi accepted on yamaha (2026-10-06,
// DB-09, DB-13), word for word, with the receiver noun swapped for "device". Registered by the card itself, so no
// adapter carries them in its own i18n files.

/** The card's words per admin language. */
export const DIAGNOSTICS_TEXTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    diag_loadingDevices: "Loading devices…",
    diag_listFailed: "The adapter did not answer with its device list. Is the instance running?",
    diag_intro: "Creates a diagnostics report for the selected device — read only, nothing on the device changes.",
    diag_contains: "The report contains:",
    diag_containsWhat: "what the device can do and what it answers",
    diag_containsDatapoints: "its datapoints",
    diag_containsLog: "the adapter's recent log lines",
    diag_after: "Reading takes up to a minute. Attach the file to a GitHub issue afterwards.",
    diag_noDevices: "This instance runs no device yet.",
    diag_device: "Device",
    diag_notConnected: "not connected",
    diag_offlineHint:
      "The device is not connected: the report contains what the adapter remembers about it and the log lines, but no live read.",
    diag_export: "Create diagnostics report",
    diag_reading: "Reading the device…",
    diag_done: "Saved as %s.",
    diag_openIssue: "Open a GitHub issue",
    diag_exportFailed: "The report could not be created.",
    diag_privacyTitle: "Privacy",
    diag_privacyMarkers:
      "Addresses, serial numbers, network and room names are replaced by markers before the file leaves the adapter.",
    diag_privacyMemory: "Nothing is written to disk — the report stays in memory only until your browser has it.",
    diag_generating:
      "Generating the diagnostics report — the device is being read over every protocol it speaks. This takes up to a minute; the file is offered for download when it is done.",
    diag_elapsed: "%s s",
    diag_notRunning: "The instance is not running. Start it, then open this tab again.",
    diag_stopped:
      "The instance stopped while the report was being made (a restart or a crash). Try again once it runs — the instance's log says what happened.",
    diag_noAnswer: "The adapter did not answer within %s s. Check the instance's log, then try again.",
  },
  de: {
    diag_loadingDevices: "Geräte werden geladen…",
    diag_listFailed: "Der Adapter hat keine Geräteliste geliefert. Läuft die Instanz?",
    diag_intro: "Erstellt einen Diagnosebericht für das gewählte Gerät – nur lesend, am Gerät ändert sich nichts.",
    diag_contains: "Der Bericht enthält:",
    diag_containsWhat: "was das Gerät kann und was es antwortet",
    diag_containsDatapoints: "seine Datenpunkte",
    diag_containsLog: "die letzten Logzeilen des Adapters",
    diag_after: "Das Auslesen dauert bis zu einer Minute. Die Datei danach an ein GitHub-Issue anhängen.",
    diag_noDevices: "Diese Instanz betreibt noch kein Gerät.",
    diag_device: "Gerät",
    diag_notConnected: "nicht verbunden",
    diag_offlineHint:
      "Das Gerät ist nicht verbunden: Der Bericht enthält, was der Adapter über das Gerät gespeichert hat, und die Logzeilen, aber kein aktuelles Auslesen.",
    diag_export: "Diagnosebericht erstellen",
    diag_reading: "Gerät wird ausgelesen…",
    diag_done: "Gespeichert als %s.",
    diag_openIssue: "GitHub-Issue öffnen",
    diag_exportFailed: "Der Bericht konnte nicht erstellt werden.",
    diag_privacyTitle: "Datenschutz",
    diag_privacyMarkers:
      "Adressen, Seriennummern, Netzwerk- und Raumnamen werden durch Platzhalter ersetzt, bevor die Datei den Adapter verlässt.",
    diag_privacyMemory:
      "Nichts wird auf die Festplatte geschrieben – der Bericht liegt nur im Speicher, bis dein Browser ihn hat.",
    diag_generating:
      "Diagnosebericht wird erstellt – das Gerät wird über jedes Protokoll ausgelesen, das es spricht. Das dauert bis zu einer Minute; danach wird die Datei zum Herunterladen angeboten.",
    diag_elapsed: "%s s",
    diag_notRunning: "Die Instanz läuft nicht. Bitte starten und diesen Tab dann erneut öffnen.",
    diag_stopped:
      "Die Instanz wurde beendet, während der Bericht entstand (Neustart oder Absturz). Erneut versuchen, sobald sie wieder läuft – das Log der Instanz zeigt, was passiert ist.",
    diag_noAnswer:
      "Der Adapter hat nicht innerhalb von %s s geantwortet. Bitte das Log der Instanz prüfen und es dann erneut versuchen.",
  },
  ru: {
    diag_loadingDevices: "Загрузка устройств…",
    diag_listFailed: "Адаптер не вернул список устройств. Запущен ли экземпляр?",
    diag_intro:
      "Создаёт диагностический отчёт для выбранного устройства — только чтение, на устройстве ничего не меняется.",
    diag_contains: "Отчёт содержит:",
    diag_containsWhat: "что умеет устройство и что оно отвечает",
    diag_containsDatapoints: "его точки данных",
    diag_containsLog: "последние строки журнала адаптера",
    diag_after: "Чтение занимает до минуты. Затем приложите файл к issue на GitHub.",
    diag_noDevices: "Этот экземпляр пока не управляет ни одним устройством.",
    diag_device: "Устройство",
    diag_notConnected: "не подключено",
    diag_offlineHint:
      "Устройство не подключено: отчёт содержит то, что адаптер о нём запомнил, и строки журнала, но без текущего считывания.",
    diag_export: "Создать диагностический отчёт",
    diag_reading: "Считывание устройства…",
    diag_done: "Сохранено как %s.",
    diag_openIssue: "Открыть issue на GitHub",
    diag_exportFailed: "Не удалось создать отчёт.",
    diag_privacyTitle: "Конфиденциальность",
    diag_privacyMarkers:
      "Адреса, серийные номера, имена сетей и комнат заменяются метками до того, как файл покинет адаптер.",
    diag_privacyMemory: "На диск ничего не записывается — отчёт хранится только в памяти, пока его не получит браузер.",
    diag_generating:
      "Создаётся диагностический отчёт: устройство считывается по всем поддерживаемым протоколам. Это занимает до минуты; затем файл будет предложен для загрузки.",
    diag_elapsed: "%s с",
    diag_notRunning: "Экземпляр не запущен. Запустите его и снова откройте эту вкладку.",
    diag_stopped:
      "Экземпляр остановился во время создания отчёта (перезапуск или сбой). Повторите попытку, когда он снова заработает — журнал экземпляра покажет, что произошло.",
    diag_noAnswer: "Адаптер не ответил в течение %s с. Проверьте журнал экземпляра и повторите попытку.",
  },
  pt: {
    diag_loadingDevices: "A carregar dispositivos…",
    diag_listFailed: "O adaptador não respondeu com a lista de dispositivos. A instância está em execução?",
    diag_intro: "Cria um relatório de diagnóstico do dispositivo selecionado — só leitura, nada muda no dispositivo.",
    diag_contains: "O relatório contém:",
    diag_containsWhat: "o que o dispositivo consegue fazer e o que responde",
    diag_containsDatapoints: "os seus pontos de dados",
    diag_containsLog: "as últimas linhas de registo do adaptador",
    diag_after: "A leitura demora até um minuto. Depois, anexa o ficheiro a um issue no GitHub.",
    diag_noDevices: "Esta instância ainda não gere nenhum dispositivo.",
    diag_device: "Dispositivo",
    diag_notConnected: "não ligado",
    diag_offlineHint:
      "O dispositivo não está ligado: o relatório contém o que o adaptador guardou sobre ele e as linhas de registo, mas nenhuma leitura atual.",
    diag_export: "Criar relatório de diagnóstico",
    diag_reading: "A ler o dispositivo…",
    diag_done: "Guardado como %s.",
    diag_openIssue: "Abrir um issue no GitHub",
    diag_exportFailed: "Não foi possível criar o relatório.",
    diag_privacyTitle: "Privacidade",
    diag_privacyMarkers:
      "Endereços, números de série, nomes de rede e de divisões são substituídos por marcadores antes de o ficheiro sair do adaptador.",
    diag_privacyMemory: "Nada é escrito no disco — o relatório fica só em memória até o navegador o receber.",
    diag_generating:
      "A gerar o relatório de diagnóstico — o dispositivo está a ser lido por todos os protocolos que fala. Demora até um minuto; depois o ficheiro é oferecido para transferência.",
    diag_elapsed: "%s s",
    diag_notRunning: "A instância não está em execução. Inicie-a e depois abra este separador novamente.",
    diag_stopped:
      "A instância parou enquanto o relatório estava a ser criado (reinício ou falha). Tente novamente quando estiver em execução — o registo da instância mostra o que aconteceu.",
    diag_noAnswer: "O adaptador não respondeu em %s s. Verifique o registo da instância e tente novamente.",
  },
  nl: {
    diag_loadingDevices: "Apparaten laden…",
    diag_listFailed: "De adapter gaf geen apparaatlijst terug. Draait de instantie?",
    diag_intro: "Maakt een diagnoserapport voor het gekozen apparaat — alleen lezen, aan het apparaat verandert niets.",
    diag_contains: "Het rapport bevat:",
    diag_containsWhat: "wat het apparaat kan en wat het antwoordt",
    diag_containsDatapoints: "zijn datapunten",
    diag_containsLog: "de laatste logregels van de adapter",
    diag_after: "Het uitlezen duurt tot een minuut. Voeg het bestand daarna toe aan een GitHub-issue.",
    diag_noDevices: "Deze instantie bestuurt nog geen apparaat.",
    diag_device: "Apparaat",
    diag_notConnected: "niet verbonden",
    diag_offlineHint:
      "Het apparaat is niet verbonden: het rapport bevat wat de adapter over het apparaat heeft onthouden en de logregels, maar geen actuele uitlezing.",
    diag_export: "Diagnoserapport maken",
    diag_reading: "Apparaat wordt uitgelezen…",
    diag_done: "Opgeslagen als %s.",
    diag_openIssue: "GitHub-issue openen",
    diag_exportFailed: "Het rapport kon niet worden gemaakt.",
    diag_privacyTitle: "Privacy",
    diag_privacyMarkers:
      "Adressen, serienummers, netwerk- en kamernamen worden door markeringen vervangen voordat het bestand de adapter verlaat.",
    diag_privacyMemory:
      "Er wordt niets naar de schijf geschreven — het rapport staat alleen in het geheugen tot je browser het heeft.",
    diag_generating:
      "Diagnoserapport wordt gemaakt – het apparaat wordt uitgelezen via elk protocol dat het spreekt. Dit duurt tot een minuut; daarna wordt het bestand aangeboden om te downloaden.",
    diag_elapsed: "%s s",
    diag_notRunning: "De instantie draait niet. Start deze en open dit tabblad daarna opnieuw.",
    diag_stopped:
      "De instantie is gestopt terwijl het rapport werd gemaakt (herstart of crash). Probeer het opnieuw zodra ze weer draait — het logboek van de instantie toont wat er gebeurde.",
    diag_noAnswer:
      "De adapter heeft niet binnen %s s geantwoord. Controleer het logboek van de instantie en probeer het opnieuw.",
  },
  fr: {
    diag_loadingDevices: "Chargement des appareils…",
    diag_listFailed: "L'adaptateur n'a pas renvoyé sa liste d'appareils. L'instance est-elle en cours d'exécution ?",
    diag_intro:
      "Crée un rapport de diagnostic pour l'appareil sélectionné — en lecture seule, rien ne change sur l'appareil.",
    diag_contains: "Le rapport contient :",
    diag_containsWhat: "ce que l'appareil sait faire et ce qu'il répond",
    diag_containsDatapoints: "ses points de données",
    diag_containsLog: "les dernières lignes du journal de l'adaptateur",
    diag_after: "La lecture dure jusqu'à une minute. Joins ensuite le fichier à un ticket GitHub.",
    diag_noDevices: "Cette instance ne gère encore aucun appareil.",
    diag_device: "Appareil",
    diag_notConnected: "non connecté",
    diag_offlineHint:
      "L'appareil n'est pas connecté : le rapport contient ce que l'adaptateur a retenu à son sujet et les lignes du journal, mais aucune lecture en direct.",
    diag_export: "Créer un rapport de diagnostic",
    diag_reading: "Lecture de l'appareil…",
    diag_done: "Enregistré sous %s.",
    diag_openIssue: "Ouvrir un ticket GitHub",
    diag_exportFailed: "Le rapport n'a pas pu être créé.",
    diag_privacyTitle: "Confidentialité",
    diag_privacyMarkers:
      "Les adresses, numéros de série, noms de réseau et de pièces sont remplacés par des marqueurs avant que le fichier ne quitte l'adaptateur.",
    diag_privacyMemory:
      "Rien n'est écrit sur le disque — le rapport reste en mémoire seulement jusqu'à ce que ton navigateur l'ait reçu.",
    diag_generating:
      "Création du rapport de diagnostic — l'appareil est lu par chaque protocole qu'il parle. Cela prend jusqu'à une minute ; le fichier est ensuite proposé au téléchargement.",
    diag_elapsed: "%s s",
    diag_notRunning: "L'instance n'est pas en cours d'exécution. Démarrez-la, puis rouvrez cet onglet.",
    diag_stopped:
      "L'instance s'est arrêtée pendant la création du rapport (redémarrage ou plantage). Réessayez lorsqu'elle tourne à nouveau — le journal de l'instance indique ce qui s'est passé.",
    diag_noAnswer: "L'adaptateur n'a pas répondu en %s s. Vérifiez le journal de l'instance, puis réessayez.",
  },
  it: {
    diag_loadingDevices: "Caricamento dei dispositivi…",
    diag_listFailed: "L'adattatore non ha restituito l'elenco dei dispositivi. L'istanza è in esecuzione?",
    diag_intro:
      "Crea un rapporto di diagnostica per il dispositivo selezionato: solo lettura, sul dispositivo non cambia nulla.",
    diag_contains: "Il rapporto contiene:",
    diag_containsWhat: "cosa sa fare il dispositivo e cosa risponde",
    diag_containsDatapoints: "i suoi punti dati",
    diag_containsLog: "le ultime righe di log dell'adattatore",
    diag_after: "La lettura richiede fino a un minuto. Poi allega il file a una issue su GitHub.",
    diag_noDevices: "Questa istanza non gestisce ancora alcun dispositivo.",
    diag_device: "Dispositivo",
    diag_notConnected: "non connesso",
    diag_offlineHint:
      "Il dispositivo non è connesso: il rapporto contiene ciò che l'adattatore ha memorizzato su di esso e le righe di log, ma nessuna lettura in tempo reale.",
    diag_export: "Crea rapporto di diagnostica",
    diag_reading: "Lettura del dispositivo…",
    diag_done: "Salvato come %s.",
    diag_openIssue: "Apri una issue su GitHub",
    diag_exportFailed: "Impossibile creare il rapporto.",
    diag_privacyTitle: "Privacy",
    diag_privacyMarkers:
      "Indirizzi, numeri di serie, nomi di rete e delle stanze vengono sostituiti da segnaposto prima che il file lasci l'adattatore.",
    diag_privacyMemory:
      "Non viene scritto nulla su disco: il rapporto resta in memoria solo finché il browser non lo riceve.",
    diag_generating:
      "Creazione del rapporto di diagnostica — il dispositivo viene letto tramite ogni protocollo che supporta. Richiede fino a un minuto; poi il file viene offerto per il download.",
    diag_elapsed: "%s s",
    diag_notRunning: "L'istanza non è in esecuzione. Avviala, poi riapri questa scheda.",
    diag_stopped:
      "L'istanza si è fermata mentre il rapporto veniva creato (riavvio o arresto anomalo). Riprova quando è di nuovo in esecuzione: il log dell'istanza indica cosa è successo.",
    diag_noAnswer: "L'adattatore non ha risposto entro %s s. Controlla il log dell'istanza, poi riprova.",
  },
  es: {
    diag_loadingDevices: "Cargando dispositivos…",
    diag_listFailed: "El adaptador no respondió con su lista de dispositivos. ¿Está en marcha la instancia?",
    diag_intro:
      "Crea un informe de diagnóstico del dispositivo seleccionado: solo lectura, en el dispositivo no cambia nada.",
    diag_contains: "El informe contiene:",
    diag_containsWhat: "lo que el dispositivo puede hacer y lo que responde",
    diag_containsDatapoints: "sus puntos de datos",
    diag_containsLog: "las últimas líneas del registro del adaptador",
    diag_after: "La lectura tarda hasta un minuto. Después, adjunta el archivo a un issue de GitHub.",
    diag_noDevices: "Esta instancia aún no gestiona ningún dispositivo.",
    diag_device: "Dispositivo",
    diag_notConnected: "no conectado",
    diag_offlineHint:
      "El dispositivo no está conectado: el informe contiene lo que el adaptador recuerda de él y las líneas de registro, pero ninguna lectura en vivo.",
    diag_export: "Crear informe de diagnóstico",
    diag_reading: "Leyendo el dispositivo…",
    diag_done: "Guardado como %s.",
    diag_openIssue: "Abrir un issue en GitHub",
    diag_exportFailed: "No se pudo crear el informe.",
    diag_privacyTitle: "Privacidad",
    diag_privacyMarkers:
      "Las direcciones, números de serie y nombres de red y de habitaciones se sustituyen por marcadores antes de que el archivo salga del adaptador.",
    diag_privacyMemory:
      "No se escribe nada en el disco: el informe solo está en memoria hasta que tu navegador lo tiene.",
    diag_generating:
      "Generando el informe de diagnóstico: el dispositivo se está leyendo por cada protocolo que habla. Tarda hasta un minuto; después se ofrece el archivo para descargar.",
    diag_elapsed: "%s s",
    diag_notRunning: "La instancia no se está ejecutando. Iníciela y luego vuelva a abrir esta pestaña.",
    diag_stopped:
      "La instancia se detuvo mientras se creaba el informe (reinicio o fallo). Inténtelo de nuevo cuando vuelva a ejecutarse: el registro de la instancia muestra lo que ocurrió.",
    diag_noAnswer: "El adaptador no respondió en %s s. Revise el registro de la instancia y vuelva a intentarlo.",
  },
  pl: {
    diag_loadingDevices: "Wczytywanie urządzeń…",
    diag_listFailed: "Adapter nie zwrócił listy urządzeń. Czy instancja działa?",
    diag_intro: "Tworzy raport diagnostyczny wybranego urządzenia — tylko odczyt, w urządzeniu nic się nie zmienia.",
    diag_contains: "Raport zawiera:",
    diag_containsWhat: "co urządzenie potrafi i co odpowiada",
    diag_containsDatapoints: "jego punkty danych",
    diag_containsLog: "ostatnie wiersze dziennika adaptera",
    diag_after: "Odczyt trwa do minuty. Następnie dołącz plik do zgłoszenia na GitHubie.",
    diag_noDevices: "Ta instancja nie obsługuje jeszcze żadnego urządzenia.",
    diag_device: "Urządzenie",
    diag_notConnected: "niepołączone",
    diag_offlineHint:
      "Urządzenie nie jest połączone: raport zawiera to, co adapter o nim zapamiętał, oraz wiersze dziennika, ale bez bieżącego odczytu.",
    diag_export: "Utwórz raport diagnostyczny",
    diag_reading: "Odczyt urządzenia…",
    diag_done: "Zapisano jako %s.",
    diag_openIssue: "Otwórz zgłoszenie na GitHubie",
    diag_exportFailed: "Nie udało się utworzyć raportu.",
    diag_privacyTitle: "Prywatność",
    diag_privacyMarkers:
      "Adresy, numery seryjne, nazwy sieci i pomieszczeń są zastępowane znacznikami, zanim plik opuści adapter.",
    diag_privacyMemory:
      "Nic nie jest zapisywane na dysku — raport jest tylko w pamięci, dopóki nie odbierze go przeglądarka.",
    diag_generating:
      "Tworzenie raportu diagnostycznego – urządzenie jest odczytywane przez każdy obsługiwany protokół. Trwa to do minuty; potem plik zostanie udostępniony do pobrania.",
    diag_elapsed: "%s s",
    diag_notRunning: "Instancja nie działa. Uruchom ją, a następnie ponownie otwórz tę kartę.",
    diag_stopped:
      "Instancja zatrzymała się podczas tworzenia raportu (restart lub awaria). Spróbuj ponownie, gdy znów będzie działać — dziennik instancji pokazuje, co się stało.",
    diag_noAnswer: "Adapter nie odpowiedział w ciągu %s s. Sprawdź dziennik instancji i spróbuj ponownie.",
  },
  uk: {
    diag_loadingDevices: "Завантаження пристроїв…",
    diag_listFailed: "Адаптер не повернув список пристроїв. Чи запущено екземпляр?",
    diag_intro: "Створює діагностичний звіт для вибраного пристрою — лише читання, на пристрої нічого не змінюється.",
    diag_contains: "Звіт містить:",
    diag_containsWhat: "що вміє пристрій і що він відповідає",
    diag_containsDatapoints: "його точки даних",
    diag_containsLog: "останні рядки журналу адаптера",
    diag_after: "Читання триває до хвилини. Потім додайте файл до issue на GitHub.",
    diag_noDevices: "Цей екземпляр ще не керує жодним пристроєм.",
    diag_device: "Пристрій",
    diag_notConnected: "не підключено",
    diag_offlineHint:
      "Пристрій не підключено: звіт містить те, що адаптер про нього запам’ятав, і рядки журналу, але без поточного зчитування.",
    diag_export: "Створити діагностичний звіт",
    diag_reading: "Зчитування пристрою…",
    diag_done: "Збережено як %s.",
    diag_openIssue: "Відкрити issue на GitHub",
    diag_exportFailed: "Не вдалося створити звіт.",
    diag_privacyTitle: "Конфіденційність",
    diag_privacyMarkers:
      "Адреси, серійні номери, назви мереж і кімнат замінюються мітками, перш ніж файл покине адаптер.",
    diag_privacyMemory:
      "На диск нічого не записується — звіт зберігається лише в пам'яті, доки його не отримає браузер.",
    diag_generating:
      "Створюється діагностичний звіт: пристрій зчитується через кожен протокол, який він підтримує. Це триває до хвилини; потім файл буде запропоновано для завантаження.",
    diag_elapsed: "%s с",
    diag_notRunning: "Екземпляр не запущено. Запустіть його, а потім знову відкрийте цю вкладку.",
    diag_stopped:
      "Екземпляр зупинився під час створення звіту (перезапуск або збій). Спробуйте ще раз, коли він знову працюватиме — журнал екземпляра покаже, що сталося.",
    diag_noAnswer: "Адаптер не відповів протягом %s с. Перевірте журнал екземпляра та спробуйте ще раз.",
  },
  "zh-cn": {
    diag_loadingDevices: "正在加载设备…",
    diag_listFailed: "适配器未返回设备列表。实例是否正在运行？",
    diag_intro: "为所选设备生成诊断报告——只读，设备上不会有任何改动。",
    diag_contains: "报告包含：",
    diag_containsWhat: "设备能做什么以及它的应答",
    diag_containsDatapoints: "它的数据点",
    diag_containsLog: "适配器最近的日志行",
    diag_after: "读取最多需要一分钟。之后请将文件附加到 GitHub issue。",
    diag_noDevices: "此实例尚未管理任何设备。",
    diag_device: "设备",
    diag_notConnected: "未连接",
    diag_offlineHint: "设备未连接：报告包含适配器记住的设备信息和日志行，但没有实时读取。",
    diag_export: "创建诊断报告",
    diag_reading: "正在读取设备…",
    diag_done: "已保存为 %s。",
    diag_openIssue: "创建 GitHub issue",
    diag_exportFailed: "无法创建报告。",
    diag_privacyTitle: "隐私",
    diag_privacyMarkers: "在文件离开适配器之前，地址、序列号、网络名称和房间名称都会被替换为标记。",
    diag_privacyMemory: "不会向磁盘写入任何内容——报告只保存在内存中，直到浏览器取走为止。",
    diag_generating: "正在生成诊断报告——正在通过设备支持的每种协议读取它。最多需要一分钟；完成后将提供文件下载。",
    diag_elapsed: "%s 秒",
    diag_notRunning: "实例未运行。请启动实例，然后重新打开此选项卡。",
    diag_stopped: "生成报告期间实例已停止（重启或崩溃）。请在实例重新运行后重试——实例日志会说明发生了什么。",
    diag_noAnswer: "适配器在 %s 秒内没有响应。请检查实例日志，然后重试。",
  },
};

/** Whether the card's words are registered already — once per page is enough. */
let registered = false;

/**
 * Hand the card's words to the admin's translation table, once.
 *
 * @param extend the admin's `I18n.extendTranslations`
 */
export function registerDiagnosticsTexts(extend: (words: Record<string, string>, lang: string) => void): void {
  if (registered) {
    return;
  }
  registered = true;
  for (const [lang, words] of Object.entries(DIAGNOSTICS_TEXTS)) {
    extend({ ...words }, lang);
  }
}
