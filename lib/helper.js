module.exports = {
  /**
   * Create device
   *
   * @param {string} haId
   */
  async createFolders(haId) {
    switch (this.typeJson[haId]) {
      case 'Cooktop':
        // Program support is currently not planned to be released. Selected and active program can be already requested.
        break;
      case 'Microwave':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'Washer':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'CoffeeMaker':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'Dryer':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'Oven':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'Dishwasher':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'FridgeFreezer':
        // There are no programs available for Fridge Freezers.
        break;
      case 'WineCooler':
        // There are no programs available for Wine Coolers.
        break;
      case 'Freezer':
        // There are no programs available for Freezers.
        break;
      case 'Refrigerator':
        // There are no programs available for refrigerator.
        break;
      case 'WasherDryer':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'CleaningRobot':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'WarmingDrawer':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'Hood':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'Hob':
        await this.createObjects(`${haId}.programs`, 'programs');
        await this.createObjects(`${haId}.programs.available`, 'available');
        await this.createObjects(`${haId}.programs.available.options`, 'options');
        await this.createObjects(`${haId}.programs.selected`, 'selected');
        await this.createObjects(`${haId}.programs.selected.options`, 'options');
        await this.createObjects(`${haId}.programs.active`, 'active');
        await this.createObjects(`${haId}.programs.active.options`, 'options');
        break;
      case 'CookProcessor':
        // Program support is currently not planned to be released. Selected and active program can be already requested.
        break;
      default:
        this.log.info(`Programs for ${this.typeJson[haId]} not found`);
        return;
    }
    await this.createObjects(`${haId}.status`, 'status');
    await this.createObjects(`${haId}.settings`, 'settings');
    await this.createObjects(`${haId}.events`, 'events');
  },
  /**
   * Create own rewquest
   *
   * @param {string} id
   */
  async createOwnRequest(id) {
    let common = {};
    common = {
      name: {
        en: 'Own request',
        de: 'Eigene Anfrage',
        ru: 'Собственный запрос',
        pt: 'Pedido próprio',
        nl: 'Eigen verzoek',
        fr: 'Demande personnelle',
        it: 'Richiesta personale',
        es: 'Solicitud propia',
        pl: 'Własne żądanie',
        uk: 'Власний запит',
        'zh-cn': '自己的请求',
      },
      desc: 'Own request',
    };
    await this.createDataPoint(`${id}.own_request`, common, 'channel', null, false, null);
    common = {
      type: 'string',
      role: 'json',
      name: {
        en: 'JSON request',
        de: 'JSON-Anforderung',
        ru: 'JSON-запрос',
        pt: 'Solicitação JSON',
        nl: 'JSON-verzoek',
        fr: 'Requête JSON',
        it: 'Richiesta JSON',
        es: 'Solicitud JSON',
        pl: 'Żądanie JSON',
        uk: 'JSON-запит',
        'zh-cn': 'JSON 请求',
      },
      desc: 'JSON request',
      read: true,
      write: true,
      def: JSON.stringify({ methode: 'get', url: 'url', data: {} }),
    };
    await this.createDataPoint(`${id}.own_request.request_json`, common, 'state', null, false, null);
    common = {
      type: 'string',
      role: 'json',
      name: {
        en: 'Response',
        de: 'Antwort',
        ru: 'Ответ',
        pt: 'Resposta',
        nl: 'Antwoord',
        fr: 'Réponse',
        it: 'Risposta',
        es: 'Respuesta',
        pl: 'Odpowiedź',
        uk: 'Відповідь',
        'zh-cn': '回复',
      },
      desc: 'JSON request',
      read: true,
      write: false,
      def: JSON.stringify({}),
    };
    await this.createDataPoint(`${id}.own_request.response`, common, 'state', null, false, null);
  },
  /**
   * Create device
   *
   * @param {string} id
   * @param {string} name
   */
  async createObjects(id, name) {
    if (this.stateCheck.includes(`${this.namespace}.${id}`)) {
      return;
    }
    let common = {};
    if (name === 'settings') {
      common = {
        name: {
          en: 'Settings',
          de: 'Einstellungen',
          ru: 'Настройки',
          pt: 'Configurações',
          nl: 'Instellingen',
          fr: 'Paramètres',
          it: 'Impostazioni',
          es: 'Ajustes',
          pl: 'Ustawienia',
          uk: 'Налаштування',
          'zh-cn': '设置',
        },
        desc: 'Settings',
      };
      await this.createDataPoint(id, common, 'channel', null, false, null);
      return;
    }
    if (name === 'events') {
      common = {
        name: {
          en: 'Events',
          de: 'Veranstaltungen',
          ru: 'События',
          pt: 'Eventos',
          nl: 'Evenementen',
          fr: 'Événements',
          it: 'Eventi',
          es: 'Eventos',
          pl: 'Wydarzenia',
          uk: 'Події',
          'zh-cn': '活动',
        },
        desc: 'Events',
      };
      await this.createDataPoint(id, common, 'channel', null, false, null);
      return;
    }
    if (name === 'programs') {
      common = {
        name: {
          en: 'Programs',
          de: 'Programme',
          ru: 'Программы',
          pt: 'Programas',
          nl: "Programma's",
          fr: 'Programmes',
          it: 'Programmi',
          es: 'Programas',
          pl: 'Programy',
          uk: 'Програми',
          'zh-cn': '程序',
        },
        desc: 'Programs',
      };
      await this.createDataPoint(id, common, 'channel', null, false, null);
      return;
    }
    if (name === 'status') {
      common = {
        name: {
          en: 'Status',
          de: 'Status',
          ru: 'Статус',
          pt: 'Status',
          nl: 'Status',
          fr: 'Statut',
          it: 'Stato',
          es: 'Estado',
          pl: 'Status',
          uk: 'Статус',
          'zh-cn': '地位',
        },
        desc: 'Status',
      };
      await this.createDataPoint(id, common, 'channel', null, false, null);
      return;
    }
    if (name === 'available') {
      common = {
        name: {
          en: 'available',
          de: 'verfügbar',
          ru: 'доступный',
          pt: 'disponível',
          nl: 'beschikbaar',
          fr: 'disponible',
          it: 'disponibile',
          es: 'disponible',
          pl: 'dostępny',
          uk: 'доступний',
          'zh-cn': '可用的',
        },
        desc: 'available',
      };
      await this.createDataPoint(id, common, 'folder', null, false, null);
      return;
    }
    if (name === 'options') {
      common = {
        name: {
          en: 'Options',
          de: 'Optionen',
          ru: 'Параметры',
          pt: 'Opções',
          nl: 'Opties',
          fr: 'Options',
          it: 'Opzioni',
          es: 'Opciones',
          pl: 'Opcje',
          uk: 'Опції',
          'zh-cn': '选项',
        },
        desc: 'Options',
      };
      await this.createDataPoint(id, common, 'folder', null, false, null);
      return;
    }
    if (name === 'selected') {
      common = {
        name: {
          en: 'selected',
          de: 'ausgewählt',
          ru: 'выбрано',
          pt: 'selecionado',
          nl: 'gekozen',
          fr: 'choisi',
          it: 'selezionato',
          es: 'seleccionado',
          pl: 'wybrany',
          uk: 'вибраний',
          'zh-cn': '已选择',
        },
        desc: 'selected',
      };
      await this.createDataPoint(id, common, 'folder', null, false, null);
      return;
    }
    if (name === 'active') {
      common = {
        name: {
          en: 'active',
          de: 'aktiv',
          ru: 'активный',
          pt: 'ativo',
          nl: 'actief',
          fr: 'actif',
          it: 'attivo',
          es: 'activo',
          pl: 'aktywny',
          uk: 'активний',
          'zh-cn': '积极的',
        },
        desc: 'active',
      };
      await this.createDataPoint(id, common, 'folder', null, false, null);
      return;
    }
  },
  /**
   * Create device
   *
   * @param {string} id
   * @param {string} name
   * @param {object} device
   */
  async createDevices(id, name, device) {
    let common = {};
    common = {
      name: name,
      desc: name,
      statusStates: {
        onlineId: `${this.namespace}.${id}.general.connected`,
      },
    };
    await this.createDataPoint(id, common, 'device', null, false, null);
    common = {
      name: {
        en: 'Commands',
        de: 'Befehle',
        ru: 'Команды',
        pt: 'Comandos',
        nl: 'Opdrachten',
        fr: 'Commandes',
        it: 'Comandi',
        es: 'Comandos',
        pl: 'Polecenia',
        uk: 'Команди',
        'zh-cn': '命令',
      },
      desc: 'Commands',
    };
    await this.createDataPoint(`${id}.commands`, common, 'channel', null, false, null);
    common = {
      name: {
        en: 'Commands',
        de: 'Befehle',
        ru: 'Команды',
        pt: 'Comandos',
        nl: 'Opdrachten',
        fr: 'Commandes',
        it: 'Comandi',
        es: 'Comandos',
        pl: 'Polecenia',
        uk: 'Команди',
        'zh-cn': '命令',
      },
      desc: 'Commands',
    };
    await this.createDataPoint(`${id}.commands`, common, 'channel', null, false, null);
    common = {
      name: {
        en: 'General Information',
        de: 'Allgemeine Informationen',
        ru: 'Общая информация',
        pt: 'Informações gerais',
        nl: 'Algemene informatie',
        fr: 'Informations générales',
        it: 'Informazioni generali',
        es: 'Información general',
        pl: 'Informacje ogólne',
        uk: 'Загальна інформація',
        'zh-cn': '一般信息',
      },
      desc: 'General Information',
    };
    await this.createDataPoint(`${id}.general`, common, 'channel', null, false, null);
    const pause = ['Microwave', 'Oven', 'CleaningRobot', 'Dryer', 'Washer', 'WasherDryer'];
    if (pause.includes(this.typeJson[id])) {
      common = {
        type: 'boolean',
        role: 'button',
        name: {
          en: 'TRUE = Pause',
          de: 'TRUE = Pause',
          ru: 'ИСТИНА = Пауза',
          pt: 'VERDADEIRO = Pausa',
          nl: 'WAAR = Pauze',
          fr: 'VRAI = Pause',
          it: 'VERO = Pausa',
          es: 'VERDADERO = Pausa',
          pl: 'PRAWDA = Pauza',
          uk: 'TRUE = Пауза',
          'zh-cn': 'TRUE = 暂停',
        },
        desc: 'TRUE = Pause',
        read: false,
        write: true,
        def: false,
      };
      await this.createDataPoint(`${id}.commands.BSH_Common_Command_PauseProgram`, common, 'state', false, false, null);
    }
    const resume = ['Microwave', 'Oven', 'CleaningRobot', 'Dryer', 'Washer', 'WasherDryer', 'Dishwasher'];
    if (resume.includes(this.typeJson[id])) {
      common = {
        type: 'boolean',
        role: 'button',
        name: {
          en: 'TRUE = Resume',
          de: 'TRUE = Fortsetzen',
          ru: 'ИСТИНА = Резюме',
          pt: 'VERDADEIRO = Retomar',
          nl: 'WAAR = CV',
          fr: 'VRAI = Reprendre',
          it: 'VERO = Riprendi',
          es: 'VERDADERO = Reanudar',
          pl: 'PRAWDA = Wznów',
          uk: 'TRUE = Резюме',
          'zh-cn': 'TRUE = 恢复',
        },
        desc: 'TRUE = Resume',
        read: false,
        write: true,
        def: false,
      };
      await this.createDataPoint(
        `${id}.commands.BSH_Common_Command_ResumeProgram`,
        common,
        'state',
        false,
        false,
        null,
      );
    }
    const openDoor = ['Microwave', 'Oven', 'FridgeFreezer', 'Freezer', 'Refrigerator'];
    if (openDoor.includes(this.typeJson[id])) {
      common = {
        type: 'boolean',
        role: 'button',
        name: {
          en: 'Open door',
          de: 'Tür öffnen',
          ru: 'Открытая дверь',
          pt: 'Porta aberta',
          nl: 'Open deur',
          fr: 'Porte ouverte',
          it: 'Porta aperta',
          es: 'Puerta abierta',
          pl: 'Otwarte drzwi',
          uk: 'Відчинені двері',
          'zh-cn': '打开门',
        },
        desc: 'Open door',
        read: false,
        write: true,
        def: false,
      };
      await this.createDataPoint(`${id}.commands.BSH_Common_Command_OpenDoor`, common, 'state', false, false, null);
    }

    const partlyOpenDoor = ['Oven'];
    if (partlyOpenDoor.includes(this.typeJson[id])) {
      common = {
        type: 'boolean',
        role: 'button',
        name: {
          en: 'Partly Open Door',
          de: 'Teilweise Tür öffnen',
          ru: 'Частично открытая дверь',
          pt: 'Porta parcialmente aberta',
          nl: 'Gedeeltelijk open deur',
          fr: 'Porte partiellement ouverte',
          it: 'Porta parzialmente aperta',
          es: 'Puerta parcialmente abierta',
          pl: 'Częściowo otwarte drzwi',
          uk: 'Частково відчинені двері',
          'zh-cn': '半开的门',
        },
        desc: 'Open door',
        read: false,
        write: true,
        def: false,
      };
      await this.createDataPoint(
        `${id}.commands.BSH_Common_Command_PartlyOpenDoor`,
        common,
        'state',
        false,
        false,
        null,
      );
    }

    common = {
      type: 'boolean',
      role: 'button',
      name: {
        en: 'TRUE = Stop',
        de: 'TRUE = Stopp',
        ru: 'ИСТИНА = Стоп',
        pt: 'VERDADEIRO = Parar',
        nl: 'WAAR = Stop',
        fr: 'VRAI = Arrêter',
        it: 'VERO = Stop',
        es: 'VERDADERO = Detener',
        pl: 'PRAWDA = Zatrzymaj',
        uk: 'TRUE = Зупинити',
        'zh-cn': 'TRUE = 停止',
      },
      desc: 'TRUE = Stop',
      read: false,
      write: true,
      def: false,
    };
    await this.createDataPoint(`${id}.commands.BSH_Common_Command_StopProgram`, common, 'state', false, false, null);
    for (const key in device) {
      common = {
        type: typeof device[key],
        role: 'state',
        name: key,
        desc: key,
        read: true,
        write: false,
        def: device[key],
      };
      await this.createDataPoint(`${id}.general.${key}`, common, 'state', device[key], false, null);
    }
  },
  /**
   * @param {string} ident
   * @param {object} common
   * @param {string} types
   * @param {string|number|boolean|null|undefined} value
   * @param {boolean|null|undefined} extend
   * @param {object|null|undefined} [native=null]
   */
  async createDataPoint(ident, common, types, value, extend, native) {
    if (!this.stateCheck.includes(`${this.namespace}.${ident}`)) {
      this.stateCheck.push(`${this.namespace}.${ident}`);
    }
    try {
      const nativvalue = !native ? { native: {} } : { native: native };
      const obj = await this.getObjectAsync(ident);
      if (!obj) {
        await this.setObjectNotExistsAsync(ident, {
          type: types,
          common: common,
          ...nativvalue,
        }).catch(error => {
          this.log.warn(`createDataPoint: ${error}`);
        });
      } else {
        if (extend) {
          this.log.debug(`INFORMATION - Extend common: ${this.namespace}.${ident}`);
          await this.extendObject(ident, {
            type: types,
            common: common,
            ...nativvalue,
          });
          if (value != null) {
            await this.setStateAsync(ident, value, true);
          }
          return;
        }
        let ischange = false;
        if (Object.keys(obj.common).length == Object.keys(common).length) {
          for (const key in common) {
            if (obj.common[key] == null) {
              ischange = true;
              break;
            } else if (JSON.stringify(obj.common[key]) != JSON.stringify(common[key])) {
              ischange = true;
              break;
            }
          }
        } else {
          ischange = true;
        }
        if (JSON.stringify(obj.type) != JSON.stringify(types)) {
          ischange = true;
        }
        if (native) {
          if (Object.keys(obj.native).length == Object.keys(nativvalue.native).length) {
            for (const key in obj.native) {
              if (nativvalue.native[key] == null) {
                ischange = true;
                delete obj['native'];
                obj['native'] = native;
                break;
              } else if (JSON.stringify(obj.native[key]) != JSON.stringify(nativvalue.native[key])) {
                ischange = true;
                obj.native[key] = nativvalue.native[key];
                break;
              }
            }
          } else {
            ischange = true;
          }
        }
        if (ischange) {
          this.log.debug(`INFORMATION - Change common: ${this.namespace}.${ident}`);
          delete obj['common'];
          obj['common'] = common;
          obj['type'] = types;
          await this.setObjectAsync(ident, obj);
        }
      }
      if (value != null) {
        await this.setStateAsync(ident, value, true);
      }
    } catch (error) {
      this.log.warn(`createDataPoint e: ${error}`);
    }
  },
};
