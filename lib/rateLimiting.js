module.exports = {
  /**
   * check all rate limiting json
   */
  async checkLimitCounter() {
    const device_json = this.rateLimiting;
    const minutes_1 = 60 * 1000;
    const diff_1 = new Date().getTime() - device_json.requestsMinutesStartLast;
    if (diff_1 > minutes_1) {
      device_json.requestsMinutesStartCount = 0;
      device_json.requestsMinutesStartLast = new Date().getTime();
    }
    const diff_2 = new Date().getTime() - device_json.requestsMinutesStopLast;
    if (diff_2 > minutes_1) {
      device_json.requestsMinutesStopCount = 0;
      device_json.requestsMinutesStopLast = new Date().getTime();
    }
    const diff_50 = new Date().getTime() - device_json.requestsMinutesLast;
    if (diff_50 > minutes_1) {
      device_json.requestsMinutesCount = 0;
      device_json.requestsMinutesLast = new Date().getTime();
    }
    const actualCW = this.getWeek();
    const blockCW = this.getWeek(device_json.requestsDayLast);
    if (actualCW !== blockCW) {
      device_json.requestsDayCount = 0;
      device_json.requestsDayLast = new Date().getTime();
      device_json.requests = [];
    }
    const val = await this.checkBlock();
    if (val) {
      await this.setLimitJson(false, 0);
    } else {
      await this.setState(`rateLimit.limitJson`, {
        val: JSON.stringify(this.rateLimiting),
        ack: true,
      });
    }

    const minutes_10 = 10 * 60 * 1000;
    const diff_10 = new Date().getTime() - this.tokenRateLimiting.tokenRefreshMinutesLast;
    if (diff_10 > minutes_10 || diff_10 === minutes_10) {
      this.tokenRateLimiting.tokenRefreshMinutesCount = 0;
      this.tokenRateLimiting.tokenRefreshMinutesLast = new Date().getTime();
    }
    const actualCWToken = this.getWeek();
    const blockCWToken = this.getWeek(this.tokenRateLimiting.tokenRefreshDayLast);
    if (actualCWToken !== blockCWToken) {
      this.tokenRateLimiting.tokenRefreshDayCount = 0;
      this.tokenRateLimiting.tokenRefreshDayLast = new Date().getTime();
    }
    const token = await this.checkToken(true);
    if (!token) {
      await this.setState(`rateTokenLimit.limitJson`, { val: JSON.stringify(this.tokenRateLimiting), ack: true });
    }
  },
  /**
   * check rate limiting json
   *
   * @param {string} resp
   * @param {number} haId
   * @param {string} start
   * @param {string|null} url
   * @param {string|null} methode
   */
  async setLimitCounter(resp, haId, start, url, methode) {
    if (resp === 'OK') {
      const minutes_1 = 60 * 1000;
      const diff_1 = new Date().getTime() - this.rateLimiting.requestsMinutesStartLast;
      if (diff_1 > minutes_1) {
        this.rateLimiting.requestsMinutesStartCount = 0;
        this.rateLimiting.requestsMinutesStartLast = new Date().getTime();
      }
      const diff_2 = new Date().getTime() - this.rateLimiting.requestsMinutesStopLast;
      if (diff_2 > minutes_1) {
        this.rateLimiting.requestsMinutesStopCount = 0;
        this.rateLimiting.requestsMinutesStopLast = new Date().getTime();
      }
      const diff_50 = new Date().getTime() - this.rateLimiting.requestsMinutesLast;
      if (diff_50 > minutes_1) {
        this.rateLimiting.requestsMinutesCount = 0;
        this.rateLimiting.requestsMinutesLast = new Date().getTime();
      }
      const actualCW = this.getWeek();
      const blockCW = this.getWeek(this.rateLimiting.requestsDayLast);
      if (actualCW !== blockCW) {
        this.rateLimiting.requestsDayCount = 0;
        this.rateLimiting.requestsDayLast = new Date().getTime();
        this.rateLimiting.requests = [];
      }
      if (url != null) {
        const json = {
          methode: methode,
          haId: haId,
          url: url,
          date: new Date().toISOString(),
        };
        this.rateLimiting.requests.push(json);
      }
      if (start === 'Start') {
        ++this.rateLimiting.requestsMinutesStartCount;
        if (
          this.rateLimiting.requestsMinutesStartCount === this.rateLimiting.requestsMinutesStartMax ||
          this.rateLimiting.requestsMinutesStartCount > this.rateLimiting.requestsMinutesStartMax
        ) {
          this.rateLimiting.requestBlock = true;
          this.rateLimiting.requestBlockTime = new Date().getTime();
          this.rateLimiting.requestReason = '5_Start_Requests_Minute';
          this.log.error(`The limit of 5 start requests has been reached. Requests will be locked for 1 minute!`);
          ++this.rateLimiting.requestsMinutesCount;
          ++this.rateLimiting.requestsDayCount;
          await this.setLimitJson(true, 2);
          return;
        }
      }
      if (start === 'Stop') {
        ++this.rateLimiting.requestsMinutesStopCount;
        if (
          this.rateLimiting.requestsMinutesStopCount === this.rateLimiting.requestsMinutesStopMax ||
          this.rateLimiting.requestsMinutesStopCount > this.rateLimiting.requestsMinutesStopMax
        ) {
          this.rateLimiting.requestBlock = true;
          this.rateLimiting.requestBlockTime = new Date().getTime();
          this.rateLimiting.requestReason = '5_Stop_Requests_Minute';
          this.log.error(`The limit of 5 stop requests has been reached. Requests will be locked for 1 minute!`);
          ++this.rateLimiting.requestsMinutesCount;
          ++this.rateLimiting.requestsDayCount;
          await this.setLimitJson(true, 3);
          return;
        }
      }
      ++this.rateLimiting.requestsMinutesCount;
      if (
        this.rateLimiting.requestsMinutesCount === this.rateLimiting.requestsMinutesMax ||
        this.rateLimiting.requestsMinutesCount > this.rateLimiting.requestsMinutesMax
      ) {
        this.rateLimiting.requestBlock = true;
        this.rateLimiting.requestBlockTime = new Date().getTime();
        this.rateLimiting.requestReason = '50_Requests_Minute';
        this.log.error(`The limit of 50 requests per minute has been reached. Requests will be locked for 1 minute!`);
        ++this.rateLimiting.requestsDayCount;
        await this.setLimitJson(true, 4);
        return;
      }
      ++this.rateLimiting.requestsDayCount;
      if (
        this.rateLimiting.requestsDayCount === this.rateLimiting.requestsDayMax ||
        this.rateLimiting.requestsDayCount > this.rateLimiting.requestsDayMax
      ) {
        this.rateLimiting.requestBlock = true;
        this.rateLimiting.requestBlockTime = new Date().getTime();
        this.rateLimiting.requestReason = '1000_Requests_Day';
        this.log.error(`The limit of 1000 requests per day has been reached. Requests will be locked for this day!`);
        await this.setLimitJson(true, 5);
        return;
      }
    } else {
      const minutes = 10 * 60 * 1000;
      const diff_10 = new Date().getTime() - this.rateLimiting.responseErrorLast10MinutesLast;
      if (diff_10 > minutes) {
        this.rateLimiting.responseErrorLast10MinutesCount = 0;
        this.rateLimiting.responseErrorLast10MinutesLast = new Date().getTime();
      }
      ++this.rateLimiting.responseErrorLast10MinutesCount;
      if (
        this.rateLimiting.responseErrorLast10MinutesCount === this.rateLimiting.responseErrorLast10MinutesMax ||
        this.rateLimiting.responseErrorLast10MinutesCount > this.rateLimiting.responseErrorLast10MinutesMax
      ) {
        this.rateLimiting.requestBlock = true;
        this.rateLimiting.requestBlockTime = new Date().getTime();
        this.rateLimiting.requestReason = '10_Error_Minute';
        this.log.error(`The limit of 10 error responses has been reached. Requests will be locked for 10 minutes!`);
        await this.setLimitJson(true, 1);
        return;
      }
    }
    await this.setLimitJson(false, 0);
  },
  /**
   * set rate limiting json
   */
  async checkBlock() {
    if (this.rateLimiting && this.rateLimiting.requestBlock) {
      const diff = new Date().getTime() - this.rateLimiting.requestBlockTime;
      const minute = 60 * 1000;
      if (this.rateLimiting.requestReason === '50_Requests_Minute') {
        if (diff < minute) {
          return false;
        }
        this.rateLimiting.requestsMinutesCount = 0;
        this.rateLimiting.requestsMinutesLast = new Date().getTime();
      } else if (this.rateLimiting.requestReason === '5_Start_Requests_Minute') {
        if (diff < minute) {
          return false;
        }
        this.rateLimiting.requestsMinutesStartCount = 0;
        this.rateLimiting.requestsMinutesStartLast = new Date().getTime();
      } else if (this.rateLimiting.requestReason === '5_Stop_Requests_Minute') {
        if (diff < minute) {
          return false;
        }
        this.rateLimiting.requestsMinutesStopCount = 0;
        this.rateLimiting.requestsMinutesStopLast = new Date().getTime();
      } else if (this.rateLimiting.requestReason === '1000_Requests_Day') {
        const actualCW = this.getWeek();
        const blockCW = this.getWeek(this.rateLimiting.requestsMinutesLast);
        if (actualCW === blockCW) {
          return false;
        }
        this.rateLimiting.requestsDayCount = 0;
        this.rateLimiting.requestsDayLast = new Date().getTime();
      } else if (this.rateLimiting.requestReason === '10_Error_Minute') {
        const minutes_10 = 10 * 60 * 1000;
        if (diff < minutes_10) {
          return false;
        }
        this.rateLimiting.responseErrorLast10MinutesCount = 0;
        this.rateLimiting.responseErrorLast10MinutesLast = new Date().getTime();
      }
      this.rateLimiting.requestBlock = false;
      this.rateLimiting.requestBlockTime = new Date().getTime();
      this.rateLimiting.requestReason = 'No Block';
    }
    return true;
  },
  /**
   * check token rate limiting json
   *
   * @param {boolean} check
   */
  async checkToken(check) {
    if (this.tokenRateLimiting.tokenBlock) {
      if (this.tokenRateLimiting.tokenReason === '10_Minutes') {
        const minutes_10 = 10 * 60 * 1000;
        const diff_10 = new Date().getTime() - this.tokenRateLimiting.tokenBlockTime;
        if (diff_10 > minutes_10) {
          this.tokenRateLimiting.tokenBlock = false;
          this.tokenRateLimiting.tokenBlockTime = 0;
          this.tokenRateLimiting.tokenReason = 'No Block';
          this.tokenRateLimiting.tokenRefreshMinutesCount = 0;
          this.tokenRateLimiting.tokenRefreshMinutesLast = new Date().getTime();
          ++this.tokenRateLimiting.tokenRefreshMinutesCount;
          ++this.tokenRateLimiting.tokenRefreshDayCount;
          this.log.info(`10 minute token lock is unlock.`);
          await this.setTokenJson(false, 0);
          return true;
        }
        return false;
      } else if (this.tokenRateLimiting.tokenReason === 'Day') {
        const actualCW = this.getWeek();
        const blockCW = this.getWeek(this.tokenRateLimiting.tokenBlockTime);
        if (actualCW !== blockCW) {
          this.tokenRateLimiting.tokenBlock = false;
          this.tokenRateLimiting.tokenBlockTime = 0;
          this.tokenRateLimiting.tokenReason = 'No Block';
          this.tokenRateLimiting.tokenRefreshDayCount = 0;
          this.tokenRateLimiting.tokenRefreshDayLast = new Date().getTime();
          ++this.tokenRateLimiting.tokenRefreshMinutesCount;
          ++this.tokenRateLimiting.tokenRefreshDayCount;
          this.log.info(`Token lock is unlock.`);
          await this.setTokenJson(false, 0);
          return true;
        }
        return false;
      }
      this.tokenRateLimiting.tokenBlock = false;
      this.tokenRateLimiting.tokenBlockTime = 0;
      this.tokenRateLimiting.tokenReason = 'No Block';
    }
    if (check) {
      return false;
    }
    const minutes_10 = 10 * 60 * 1000;
    const diff_10 = new Date().getTime() - this.tokenRateLimiting.tokenRefreshMinutesLast;
    if (diff_10 > minutes_10 || diff_10 === minutes_10) {
      this.tokenRateLimiting.tokenRefreshMinutesCount = 0;
      this.tokenRateLimiting.tokenRefreshMinutesLast = new Date().getTime();
    }
    ++this.tokenRateLimiting.tokenRefreshMinutesCount;
    if (
      diff_10 < minutes_10 &&
      (this.tokenRateLimiting.tokenRefreshMinutesCount > this.tokenRateLimiting.tokenRefreshMinutesMax ||
        this.tokenRateLimiting.tokenRefreshMinutesCount === this.tokenRateLimiting.tokenRefreshMinutesMax)
    ) {
      this.tokenRateLimiting.tokenBlock = true;
      this.tokenRateLimiting.tokenBlockTime = new Date().getTime();
      this.tokenRateLimiting.tokenReason = '10_Minutes';
      this.log.error(`The limit of 10 token requests has been reached. Refresh token will be locked for 10 minutes!`);
      await this.setTokenJson(true, 1);
      return false;
    }
    const actualCW = this.getWeek();
    const blockCW = this.getWeek(this.tokenRateLimiting.tokenRefreshDayLast);
    if (actualCW !== blockCW) {
      this.tokenRateLimiting.tokenRefreshDayCount = 0;
      this.tokenRateLimiting.tokenRefreshDayLast = new Date().getTime();
    }
    ++this.tokenRateLimiting.tokenRefreshDayCount;
    if (
      actualCW === blockCW &&
      (this.tokenRateLimiting.tokenRefreshDayCount > this.tokenRateLimiting.tokenRefreshDayMax ||
        this.tokenRateLimiting.tokenRefreshDayCount === this.tokenRateLimiting.tokenRefreshDayMax)
    ) {
      this.tokenRateLimiting.tokenBlock = true;
      this.tokenRateLimiting.tokenBlockTime = new Date().getTime();
      this.tokenRateLimiting.tokenReason = 'Day';
      this.log.error(`The limit of 100 token requests has been reached. Refresh token will be locked for this day!`);
      await this.setTokenJson(true, 2);
      return false;
    }
    await this.setTokenJson(false, 0);
    return true;
  },
  /**
   * read rate limiting and token json
   *
   * @param {object} constants
   */
  async getRateLimit(constants) {
    const dev = await this.getStateAsync(`rateLimit.limitJson`);
    if (dev && typeof dev.val === 'string' && dev.val.startsWith('{')) {
      const rate = JSON.parse(dev.val);
      if (Object.keys(rate).length != Object.keys(constants.rateLimiting).length) {
        this.rateLimiting = constants.rateLimiting;
      } else {
        this.rateLimiting = rate;
      }
    } else {
      this.rateLimiting = constants.rateLimiting;
    }
    const all = await this.getStateAsync(`rateTokenLimit.limitJson`);
    if (all && typeof all.val === 'string' && all.val.startsWith('{')) {
      const rate = JSON.parse(all.val);
      if (Object.keys(rate).length != Object.keys(constants.rateTokenLimiting).length) {
        this.tokenRateLimiting = constants.rateTokenLimiting;
      } else {
        this.tokenRateLimiting = rate;
      }
    } else {
      this.tokenRateLimiting = constants.rateTokenLimiting;
    }
  },
  /**
   * Create Token Rate Limiting
   *
   */
  async createLimit() {
    let common = {};
    common = {
      name: {
        en: 'Token Rate Limiting',
        de: 'Token-Ratenbegrenzung',
        ru: 'Ограничение скорости токена',
        pt: 'Limitação de taxa de token',
        nl: 'Token tariefbeperking',
        fr: 'Limitation du taux de jetons',
        it: 'Limitazione della velocità del token',
        es: 'Limitación de la tasa de tokens',
        pl: 'Ograniczenie szybkości tokenów',
        uk: 'Обмеження швидкості токенів',
        'zh-cn': '令牌速率限制',
      },
      desc: 'Token Rate Limiting',
    };
    await this.createDataPoint(`rateTokenLimit`, common, 'channel', null, null);
    common = {
      type: 'string',
      role: 'json',
      name: {
        en: 'Token Rate Limiting as JSON',
        de: 'Token-Ratenbegrenzung als JSON',
        ru: 'Ограничение скорости передачи токенов в формате JSON',
        pt: 'Limitação de taxa de token como JSON',
        nl: 'Tokensnelheidsbeperking als JSON',
        fr: 'Limitation du débit des jetons au format JSON',
        it: 'Limitazione della velocità del token come JSON',
        es: 'Limitación de la tasa de tokens como JSON',
        pl: 'Ograniczanie szybkości tokenów jako JSON',
        uk: 'Обмеження швидкості токенів у форматі JSON',
        'zh-cn': 'JSON 格式的令牌速率限制',
      },
      desc: 'Token Rate Limiting as JSON',
      read: true,
      write: false,
      def: '{}',
    };
    await this.createDataPoint(`rateTokenLimit.limitJson`, common, 'state', null, null);
    common = {
      type: 'boolean',
      role: 'switch',
      name: {
        en: 'Blocking active',
        de: 'Sperrung aktiv',
        ru: 'Блокировка активна',
        pt: 'Bloqueio ativo',
        nl: 'Blokkering actief',
        fr: 'Blocage actif',
        it: 'Blocco attivo',
        es: 'Bloqueo activo',
        pl: 'Blokowanie aktywne',
        uk: 'Блокування активне',
        'zh-cn': '阻断活动',
      },
      desc: 'Blocking active',
      read: true,
      write: false,
      def: false,
    };
    await this.createDataPoint(`rateTokenLimit.isBlocked`, common, 'state', null, null);
    common = {
      type: 'number',
      role: 'value',
      name: {
        en: 'Blocking reason',
        de: 'Sperrgrund',
        ru: 'Причина блокировки',
        pt: 'Motivo do bloqueio',
        nl: 'Reden voor blokkering',
        fr: 'Motif de blocage',
        it: 'Motivo del blocco',
        es: 'Motivo del bloqueo',
        pl: 'Powód blokowania',
        uk: 'Причина блокування',
        'zh-cn': '阻止原因',
      },
      desc: 'Blocking reason',
      read: true,
      write: false,
      def: 0,
      states: {
        0: 'Nothing',
        1: 'Token Limit (10 per minute)',
        2: 'Token Limit (100 per day)',
      },
    };
    await this.createDataPoint(`rateTokenLimit.reason`, common, 'state', null, null);
    common = {
      name: {
        en: 'Rate Limiting',
        de: 'Ratenbegrenzung',
        ru: 'Ограничение скорости',
        pt: 'Limitação de taxa',
        nl: 'Snelheidsbeperking',
        fr: 'Limitation de débit',
        it: 'Limitazione della velocità',
        es: 'Limitación de velocidad',
        pl: 'Ograniczanie szybkości',
        uk: 'Обмеження швидкості',
        'zh-cn': '速率限制',
      },
      desc: 'Rate Limiting',
    };
    await this.createDataPoint(`rateLimit`, common, 'channel', null, null);
    common = {
      type: 'string',
      role: 'json',
      name: {
        en: 'Rate Limiting as JSON',
        de: 'Ratenbegrenzung als JSON',
        ru: 'Ограничение скорости в формате JSON',
        pt: 'Limitação de taxa como JSON',
        nl: 'Snelheidsbeperking als JSON',
        fr: 'Limitation de débit en JSON',
        it: 'Limitazione della velocità come JSON',
        es: 'Limitación de velocidad como JSON',
        pl: 'Ograniczanie szybkości przesyłania danych jako JSON',
        uk: 'Обмеження швидкості у форматі JSON',
        'zh-cn': 'JSON 格式的速率限制',
      },
      desc: 'Rate Limiting as JSON',
      read: true,
      write: false,
      def: '{}',
    };
    await this.createDataPoint(`rateLimit.limitJson`, common, 'state', null, null);
    common = {
      type: 'boolean',
      role: 'switch',
      name: {
        en: 'Blocking active',
        de: 'Sperrung aktiv',
        ru: 'Блокировка активна',
        pt: 'Bloqueio ativo',
        nl: 'Blokkering actief',
        fr: 'Blocage actif',
        it: 'Blocco attivo',
        es: 'Bloqueo activo',
        pl: 'Blokowanie aktywne',
        uk: 'Блокування активне',
        'zh-cn': '阻断活动',
      },
      desc: 'Blocking active',
      read: true,
      write: false,
      def: false,
    };
    await this.createDataPoint(`rateLimit.isBlocked`, common, 'state', null, null);
    common = {
      type: 'number',
      role: 'value',
      name: {
        en: 'Blocking reason',
        de: 'Sperrgrund',
        ru: 'Причина блокировки',
        pt: 'Motivo do bloqueio',
        nl: 'Reden voor blokkering',
        fr: 'Motif de blocage',
        it: 'Motivo del blocco',
        es: 'Motivo del bloqueo',
        pl: 'Powód blokowania',
        uk: 'Причина блокування',
        'zh-cn': '阻止原因',
      },
      desc: 'Blocking reason',
      read: true,
      write: false,
      def: 0,
      states: {
        0: 'Nothing',
        1: 'Error Limit (10 per 10 minutes)',
        2: 'Start Limit (5 per minute)',
        3: 'Stop Limit (5 per minute)',
        4: 'Request Limit (50 per minute)',
        5: 'Request Limit (1000 per day)',
      },
    };
    await this.createDataPoint(`rateLimit.reason`, common, 'state', null, null);
  },
};
