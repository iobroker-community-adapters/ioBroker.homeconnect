'use strict';

/*
 * Created with @iobroker/create-adapter v2.1.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const axiosRateLimit = require('axios-rate-limit');
const helper = require('./lib/helper');
const limiting = require('./lib/rateLimiting');
const constants = require('./lib/constants');
const qs = require('qs');
const { EventSource } = require('eventsource');
const tough = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
class Homeconnect extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'homeconnect',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.createDataPoint = helper.createDataPoint;
    this.createDevices = helper.createDevices;
    this.createObjects = helper.createObjects;
    this.createFolders = helper.createFolders;
    this.createLimit = limiting.createLimit;
    this.getRateLimit = limiting.getRateLimit;
    this.checkToken = limiting.checkToken;
    this.checkBlock = limiting.checkBlock;
    this.setLimitCounter = limiting.setLimitCounter;
    this.checkLimitCounter = limiting.checkLimitCounter;
    this.userAgent = 'ioBroker v1.0.0';
    this.headers = {
      'user-agent': this.userAgent,
      Accept: 'application/vnd.bsh.sdk.v1+json',
      'Accept-Language': 'de-DE',
    };
    this.deviceArray = [];
    this.typeJson = {};
    this.stateCheck = [];
    this.fetchedDevice = {};
    //this.refreshStatusInterval = null;
    this.reLoginTimeout = null;
    //this.reconnectInterval = null;
    this.reconnectTimeout = null;
    this.refreshTokenInterval = null;
    this.availablePrograms = {};
    this.availableProgramOptions = {};
    this.eventSourceState;
    this.currentSelected = {};
    this.sleepTimer = null;
    this.rateLimiting = {};
    this.tokenRateLimiting = {};
    this.rateLimitingInterval = null;
    this.cookieJar = new tough.CookieJar();
    // @ts-expect-error //Nothing
    this.requestClient = axiosRateLimit(
      axios.create({
        withCredentials: true,
        httpsAgent: new HttpsCookieAgent({
          cookies: {
            jar: this.cookieJar,
          },
        }),
      }),
      { maxRequests: 15, perMilliseconds: 1000 },
    );
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.resetAccess) {
      this.log.info('Reset access');
      this.setState('auth.session', '', true);
      const adapterConfig = `system.adapter.${this.name}.${this.instance}`;
      this.getForeignObject(adapterConfig, (error, obj) => {
        if (obj) {
          obj.native.resetAccess = false;
          this.setForeignObject(adapterConfig, obj);
        } else {
          this.log.error('No reset possible no Adapterconfig found');
        }
      });
      return;
    }
    await this.createLimit();
    await this.getRateLimit(constants);
    this.session = {};
    this.subscribeStates('*');
    const sessionState = await this.getStateAsync('auth.session');

    if (sessionState && sessionState.val && typeof sessionState.val === 'string') {
      this.log.debug('Found current session');
      //this.session = JSON.parse(this.decrypt(sessionState.val));
      this.session = JSON.parse(sessionState.val);
    }

    if (this.session.refresh_token) {
      await this.refreshToken();
    } else {
      if (!this.config.username || !this.config.password || !this.config.clientID) {
        this.log.warn('please enter homeconnect app username and password and clientId in the instance settings');
        return;
      }

      this.log.debug('Start normal login');
      await this.login();
    }
    if (this.session.access_token) {
      this.headers.authorization = `Bearer ${this.session.access_token}`;
      await this.getDeviceList();
      await this.startEventStream();

      // this.refreshStatusInterval = this.setInterval(async () => {
      //     for (const haId of this.deviceArray) {
      //         this.log.debug("Update status for " + haId);
      //         this.getAPIValues(haId, "/status");
      //     }
      // }, 10 * 60 * 1000); //every 10 minutes
      //Workaround because sometimes no connect event for offline events
      // this.reconnectInterval = this.setInterval(async () => {
      //     this.startEventStream();
      // }, 60 * 60 * 1000); //every 60 minutes
      this.refreshTokenInterval = this.setInterval(
        async () => {
          await this.refreshToken();
          this.startEventStream();
        },
        (this.session.expires_in - 200) * 1000,
      );
    }
    this.setLimitInterval();
  }
  setLimitInterval() {
    this.rateLimitingInterval = this.setInterval(async () => {
      await this.checkLimitCounter();
    }, 60 * 1000);
  }
  async login() {
    let loginUrl = '';
    let tokenRequestSuccesful = false;
    const deviceAuth = await this.requestClient({
      method: 'post',
      url: 'https://api.home-connect.com/security/oauth/device_authorization',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `client_id=${this.config.clientID}&scope=IdentifyAppliance%20Monitor%20Settings%20Control`,
    })
      .then(res => {
        this.log.debug(`login: ${JSON.stringify(res.data)}`);
        return res.data;
      })
      .catch(error => {
        this.log.error(`login: ${error}`);
        if (error.response) {
          this.log.error(`login: ${JSON.stringify(error.response.data)}`);
          if (error.response.data.error === 'unauthorized_client') {
            this.log.error('Please check your clientID or wait 15 minutes until it is active');
          }
        }
      });
    if (!deviceAuth || !deviceAuth.verification_uri_complete) {
      this.log.error('No verification_uri_complete in device_authorization');
      return;
    }

    const loginResponse = await this.requestClient({
      method: 'post',
      url: 'https://api.home-connect.com/security/oauth/device_login',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },

      data: qs.stringify({
        user_code: deviceAuth.user_code,
        client_id: this.config.clientID,
        accept_language: 'de',
        region: 'EU',
        environment: 'PRD',
        lookup: 'true',
        email: this.config.username,
        password: this.config.password,
      }),
    })
      .then(async res => {
        this.log.debug(`device login: ${JSON.stringify(res.data)}`);
        if (res.data.match('data-error-data="" >(.*)<')) {
          this.log.info(`Normal Login response ${res.data.match('data-error-data="" >(.*)<')[1]}`);
          this.log.info('Try new SingleKey Login');

          const formData = await this.requestClient({
            method: 'post',
            url: 'https://api.home-connect.com/security/oauth/device_login',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },

            data: qs.stringify({
              user_code: deviceAuth.user_code,
              client_id: this.config.clientID,
              accept_language: 'de',
              region: 'EU',
              environment: 'PRD',
              lookup: 'true',
              email: this.config.username,
            }),
          })
            .then(res => {
              this.log.debug(`device login2: ${JSON.stringify(res.data)}`);

              loginUrl = res.request.path;
              return this.extractHidden(res.data);
            })
            .catch(error => {
              this.log.error(`device login2: ${error}`);
              if (error.response) {
                this.log.error(`device login2: ${JSON.stringify(error.response.data)}`);
              }
            });
          const loginParams = qs.parse(loginUrl.split('?')[1]);
          const returnUrl = loginParams.returnUrl || loginParams.ReturnUrl;

          await this.requestClient({
            method: 'post',
            maxBodyLength: Infinity,
            url: 'https://singlekey-id.com/auth/de-de/login/password',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              accept: '*/*',
              'hx-request': 'true',
              'sec-fetch-site': 'same-origin',
              'hx-boosted': 'true',
              'accept-language': 'de-DE,de;q=0.9',
              'sec-fetch-mode': 'cors',
              origin: 'https://singlekey-id.com',
              'user-agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
              'sec-fetch-dest': 'empty',
            },
            params: loginParams,
            data: {
              Password: this.config.password,
              RememberMe: 'true',
              __RequestVerificationToken: formData['undefined'],
            },
          }).catch(error => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
          return await this.requestClient({
            method: 'get',
            url: `https://singlekey-id.com${returnUrl}`,
          })
            .then(res => {
              this.log.debug(`Password: ${JSON.stringify(res.data)}`);
              return res.data;
            })
            .catch(error => {
              this.log.error(`Password: ${error}`);
              error.response && this.log.error(`Password: ${JSON.stringify(error.response.data)}`);
            });
        }
        this.log.info('Login details submitted');
        return this.extractHidden(res.data);
      })
      .catch(error => {
        this.log.error('Please check username and password');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    const grantData = this.extractHidden(loginResponse);
    await this.requestClient({
      method: 'post',
      url: 'https://api.home-connect.com/security/oauth/device_grant',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },

      data: grantData,
    })
      .then(res => {
        this.log.debug(`Grand: ${JSON.stringify(res.data)}`);
        return;
      })
      .catch(error => {
        this.log.error(error);
        if (error.response) {
          this.log.error(`Grand: ${JSON.stringify(error.response.data)}`);
        }
      });

    await this.sleep(6000);

    while (!tokenRequestSuccesful) {
      await this.requestClient({
        method: 'post',
        url: 'https://api.home-connect.com/security/oauth/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },

        data: qs.stringify({
          grant_type: 'device_code',
          device_code: deviceAuth.device_code,
          client_id: this.config.clientID,
        }),
      })
        .then(async res => {
          this.log.debug(`Token: ${JSON.stringify(res.data)}`);
          this.session = res.data;
          this.log.info('Token received succesfully');
          await this.setState('info.connection', true, true);
          this.session.next = new Date().getTime() + parseInt(this.session.expires_in) * 1000;
          //await this.setState('auth.session', { val: this.encrypt(JSON.stringify(this.session)), ack: true });
          await this.setState('auth.session', { val: JSON.stringify(this.session), ack: true });
          tokenRequestSuccesful = true;
        })
        .catch(async error => {
          this.log.error(error);
          this.log.error('Please check username and password or visit this site for manually login: ');
          this.log.error('Bitte überprüfe Benutzername und Passwort oder besuche diese Seite für manuelle Anmeldung: ');
          this.log.error(deviceAuth.verification_uri_complete);
          //   this.log.error(error);
          if (error.response) {
            this.log.error(JSON.stringify(error.response.data));
            if (error.response.status === 429) {
              this.log.info('The maximum number of requests has been reached!');
              if (error.response.headers) {
                if (error.response.headers['retry-after']) {
                  this.log.error(`API retry-after: ${this.convertRetryAfter(error.response.headers['retry-after'])}`);
                }
              }
            }
          }

          this.log.info('Wait 10 seconds to retry');

          await this.sleep(10000);
        });
    }
  }
  async getDeviceList() {
    this.log.debug('Get device list');
    await this.requestClient({
      method: 'get',
      url: 'https://api.home-connect.com/api/homeappliances',
      headers: this.headers,
    })
      .then(async res => {
        this.log.debug(`Homeappliances: ${JSON.stringify(res.data)}`);
        this.log.info(`Found ${res.data.data.homeappliances.length} devices`);
        for (const device of res.data.data.homeappliances) {
          let haID = device.haId;
          if (!haID) {
            this.log.info(`Invalid device ${JSON.stringify(device)}`);
            continue;
          }
          haID = haID.replace(/\.?-001*$/, '');
          this.typeJson[haID] = device.type;
          this.createFolders(haID);
          this.deviceArray.push(haID);
          const name = device.name;
          await this.createDevices(haID, name, device);
          if (device.connected) {
            this.fetchDeviceInformation(haID);
          }
        }
      })
      .catch(error => {
        this.log.error(`getDeviceList: ${error}`);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
          if (error.response.status === 429) {
            this.log.info('The maximum number of requests has been reached!');
            if (error.response.headers) {
              if (error.response.headers['retry-after']) {
                this.log.error(`API retry-after: ${this.convertRetryAfter(error.response.headers['retry-after'])}`);
              }
            }
          }
        }
      });
  }

  async fetchDeviceInformation(haId) {
    //this.getAPIValues(haId, '/events'); // Response empty
    //this.getAPIValues(haId, '/images');
    this.getAPIValues(haId, '/status');
    this.getAPIValues(haId, '/settings');
    if (!this.isPrograms(haId)) {
      this.getAPIValues(haId, '/programs/active');
      this.getAPIValues(haId, '/programs/selected');
    }
    if (!this.fetchedDevice[haId] && !this.isPrograms(haId)) {
      this.fetchedDevice[haId] = true;
      this.getAPIValues(haId, '/programs');
      this.updateOptions(haId, '/programs/active');
      this.updateOptions(haId, '/programs/selected');
    }
  }
  async getAPIValues(haId, url) {
    if (!(await this.checkBlock())) {
      return;
    }
    await this.sleep(Math.floor(Math.random() * 1500));
    await this.setLimitCounter('OK', haId, 'NOK', url, 'GET');
    const header = Object.assign({}, this.headers);
    header['Accept-Language'] = this.config.language;
    const returnValue = await this.requestClient({
      method: 'get',
      url: `https://api.home-connect.com/api/homeappliances/${haId}${url}`,
      headers: header,
    })
      .then(res => {
        this.log.debug(`Homeappliances device: ${JSON.stringify(res.data)}`);
        return res.data;
      })
      .catch(error => {
        if (error.response) {
          this.log.error(`Homeappliances device: ${JSON.stringify(error.response.data)}`);
          if (error.response.status === 429) {
            this.log.info('The maximum number of requests has been reached!');
            if (error.response.headers) {
              if (error.response.headers['retry-after']) {
                this.log.error(`API retry-after: ${this.convertRetryAfter(error.response.headers['retry-after'])}`);
              }
            }
          }
          const description = error.response.data.error ? error.response.data.error.description : '';
          this.log.info(`${haId}${url}: ${description}.`);
          this.log.debug(`Homeappliances device: ${JSON.stringify(error.response.data)}`);
        } else {
          this.log.info(error);
        }
        return;
      });
    if (!returnValue || returnValue.error) {
      await this.setErrorResponse(true);
      returnValue && this.log.debug(`Error: ${returnValue.error}`);
      return;
    }
    try {
      this.log.debug(`URL: ${url}`);
      this.log.debug(`returnValue: ${JSON.stringify(returnValue)}`);
      if (url.indexOf('/settings/') !== -1) {
        let defaults;
        let type = 'string';
        let role = 'state';
        defaults = '';
        if (returnValue.data.type === 'Int' || returnValue.data.type === 'Double') {
          type = 'number';
          role = 'value';
          defaults = 0;
        }
        if (returnValue.data.type === 'Boolean') {
          type = 'boolean';
          role = 'switch';
          defaults = false;
        }
        const common = {
          name: returnValue.data.name,
          type: type,
          role: role,
          write: true,
          read: true,
          def: defaults,
        };
        if (returnValue.data.constraints && returnValue.data.constraints.allowedvalues) {
          const states = {};
          for (let index in returnValue.data.constraints.allowedvalues) {
            const val = returnValue.data.constraints.allowedvalues[index];
            states[val] = returnValue.data.constraints.displayvalues[index] || val;
          }
          common.states = states;
        }
        const folder = `.settings.${returnValue.data.key.replace(/\./g, '_')}`;
        this.log.debug(`Extend Settings: ${haId}${folder}`);
        let value = null;
        value = returnValue.data.value != null ? returnValue.data.value : value;
        await this.createDataPoint(haId + folder, common, 'state', value, null);
        return;
      }

      if (url.indexOf('/programs/available/') !== -1) {
        if (returnValue.data.options) {
          this.availableProgramOptions[returnValue.data.key] = this.availableProgramOptions[returnValue.data.key] || [];
          for (const option of returnValue.data.options) {
            this.availableProgramOptions[returnValue.data.key].push(option.key);
            let defaults;
            let type = 'string';
            let role = 'state';
            defaults = '';
            if (option.type === 'Int' || option.type === 'Double') {
              type = 'number';
              role = 'value';
              defaults = 0;
            }
            if (option.type === 'Boolean') {
              type = 'boolean';
              role = 'switch';
              defaults = false;
            }
            let common = {
              name: option.name,
              type: type,
              role: role,
              write: true,
              read: true,
              def: defaults,
            };
            if (option.unit && option.unit != '') {
              common.unit = option.unit;
            }
            if (option.constraints && option.constraints.min != null && typeof option.constraints.min === 'number') {
              common.min = option.constraints.min;
              common.def = option.constraints.min;
            }
            if (option.constraints && option.constraints.max != null && typeof option.constraints.max === 'number') {
              common.max = option.constraints.max;
            }

            if (option.constraints && option.constraints.allowedvalues) {
              common.states = {};
              for (const element of option.constraints.allowedvalues) {
                common.states[element] =
                  option.constraints.displayvalues[option.constraints.allowedvalues.indexOf(element)];
              }
            }
            let folder = `.programs.available.options.${option.key.replace(/\./g, '_')}`;
            this.log.debug(`Extend Options: ${haId}${folder}`);
            await this.createDataPoint(haId + folder, common, 'state', null, null);
            this.log.debug('Set default value');
            if (option.constraints && option.constraints.default) {
              let value = option.constraints.default;
              if (option.constraints.default > option.constraints.max) {
                value = option.constraints.max;
                this.log.debug(
                  `Default value ${option.constraints.default} is greater than max ${option.constraints.max}. Set to max.`,
                );
              }
              await this.setState(haId + folder, value, true);
            }
            const key = returnValue.data.key.split('.').pop();
            const com = {
              name: returnValue.data.name,
              desc: returnValue.data.desc ? returnValue.data.desc : returnValue.data.name,
            };
            if (!this.stateCheck.includes(`${this.namespace}.${haId}.programs.selected.options.${key}`)) {
              await this.createDataPoint(`${haId}.programs.selected.options.${key}`, com, 'folder', null, null);
            }
            folder = `.programs.selected.options.${key}.${option.key.replace(/\./g, '_')}`;
            await this.createDataPoint(haId + folder, common, 'state', null, null);
          }
        }
        return;
      }

      if ('key' in returnValue.data) {
        returnValue.data = {
          items: [returnValue.data],
        };
      }
      for (const item in returnValue.data) {
        if (Array.isArray(returnValue.data[item])) {
          for (const subElement of returnValue.data[item]) {
            let folder = url.replace(/\//g, '.');
            if (url === '/programs/active') {
              subElement.value = subElement.key;
              subElement.key = 'BSH_Common_Root_ActiveProgram';
              subElement.name = 'BSH_Common_Root_ActiveProgram';
            }
            if (url === '/programs/selected') {
              if (subElement.key) {
                subElement.value = subElement.key;
                this.currentSelected[haId] = { key: subElement.value, name: subElement.name };
                subElement.key = 'BSH_Common_Root_SelectedProgram';
                subElement.name = 'BSH_Common_Root_SelectedProgram';
              } else {
                this.log.warn(`Empty sublement: ${JSON.stringify(subElement)}`);
              }
            }
            if (url === '/programs') {
              this.log.debug(`${haId} available: ${JSON.stringify(subElement)}`);
              if (this.availablePrograms[haId]) {
                this.availablePrograms[haId].push({
                  key: subElement.key,
                  name: subElement.name || subElement.key,
                });
              } else {
                this.availablePrograms[haId] = [
                  {
                    key: subElement.key,
                    name: subElement.name || subElement.key,
                  },
                ];
              }
              this.getAPIValues(haId, `/programs/available/${subElement.key}`);
              folder += '.available';
            }
            if (url === '/settings') {
              this.getAPIValues(haId, `/settings/${subElement.key}`);
            }

            if (url.indexOf('/programs/selected/') !== -1) {
              //TODO override channel as state - WHY???
              if (!this.currentSelected[haId]) {
                return;
              }
              if (!this.currentSelected[haId].key) {
                this.log.warn(`${JSON.stringify(this.currentSelected[haId])} is selected but has no key selected `);
                return;
              }
              const key = this.currentSelected[haId].key.split('.').pop();
              folder += `.${key}`;
              /**
              const common = {
                name: this.currentSelected[haId].name,
                type: 'mixed',
                role: 'state',
                write: true,
                read: true,
              };
               */
              const common = {
                name: this.currentSelected[haId].name,
                desc: this.currentSelected[haId].name,
              };
              this.log.debug(`FOLDER: ${JSON.stringify(this.currentSelected[haId])}`);
              //await this.createDataPoint(haId + folder, common, 'state', null, null);
              await this.createDataPoint(haId + folder, common, 'folder', null, null);
            }
            this.log.debug(`Create State: ${haId}${folder}.${subElement.key.replace(/\./g, '_')}`);
            let defaults;
            let type = 'mixed';
            let role = 'state';
            defaults = '';
            if (typeof subElement.value === 'boolean') {
              type = 'boolean';
              role = 'switch';
              defaults = false;
            }
            if (typeof subElement.value === 'number') {
              type = 'number';
              role = 'value';
              defaults = 0;
            }
            let common = {
              name: subElement.name,
              type: type,
              role: role,
              write: true,
              read: true,
              def: defaults,
            };
            if (subElement.unit && subElement.unit != '') {
              common.unit = subElement.unit;
            }
            if (
              subElement.constraints &&
              subElement.constraints.min != null &&
              typeof subElement.constraints.min === 'number'
            ) {
              common.min = subElement.constraints.min;
              common.def = subElement.constraints.min;
            }
            if (
              subElement.constraints &&
              subElement.constraints.max != null &&
              typeof subElement.constraints.max === 'number'
            ) {
              common.max = subElement.constraints.max;
            }
            const path = `${haId + folder}.${subElement.key.replace(/\./g, '_')}`;
            await this.createDataPoint(path, common, 'state', null, null);
            let value = null;
            if (subElement.value !== undefined) {
              this.log.debug('Set api value');
              let value = subElement.value;
              //check if value is an object
              if (typeof value === 'object' && value !== null) {
                value = JSON.stringify(value);
              }
            }
            if (value == null) {
              this.log.debug(`failed set state - Path: ${path} - ${JSON.stringify(subElement)}`);
              this.log.debug(`Value: '${value}'`);
            }
            await this.createDataPoint(path, common, 'state', value, null);
          }
        } else {
          this.log.info(`No array: ${item}`);
        }
      }
      if (url === '/programs') {
        const rootItems = [
          {
            key: 'BSH_Common_Root_ActiveProgram',
            folder: '.programs.active',
          },
          {
            key: 'BSH_Common_Root_SelectedProgram',
            folder: '.programs.selected',
          },
        ];
        if (!this.availablePrograms[haId]) {
          this.log.info(`No available programs found for: ${haId}`);
          return;
        }
        for (const rootItem of rootItems) {
          const common = {
            name: rootItem.key,
            type: 'string',
            role: 'state',
            write: true,
            read: true,
            states: {},
          };
          if (this.availablePrograms[haId]) {
            for (const program of this.availablePrograms[haId]) {
              common.states[program.key] = program.name;
            }
          }
          await this.createDataPoint(
            `${haId + rootItem.folder}.${rootItem.key.replace(/\./g, '_')}`,
            common,
            'state',
            null,
            null,
          );
        }
      }
    } catch (error) {
      this.log.error(error);
      this.log.error(error.stack);
      this.log.error(url);
      this.log.error(JSON.stringify(returnValue));
    }
  }
  async updateOptions(haId, url, forceDeletion) {
    const pre = `${this.name}.${this.instance}`;
    const states = await this.getStatesAsync(`${pre}.${haId}.programs.*`);
    if (!states) {
      this.log.warn(`No states found for: ${pre}.${haId}.programs.*`);
      return;
    }
    const allIds = Object.keys(states);
    let searchString = 'selected.options.';
    if (url.indexOf('/active') !== -1) {
      searchString = 'active.options.';
      this.log.debug(`search: ${searchString}`);
      //delete only for active options
      this.log.debug(`Delete: ${haId}${url.replace(/\//g, '.')}.options`);

      for (const keyName of allIds) {
        if (
          (keyName.indexOf(searchString) !== -1 && keyName.indexOf('BSH_Common_Option') === -1) ||
          (forceDeletion && keyName.indexOf('BSH_Common_Option_RemainingProgramTime') === -1)
        ) {
          this.stateCheck = this.stateCheck.filter(r => r !== keyName);
          await this.delObjectAsync(keyName.split('.').slice(2).join('.'));
        } else if (keyName.indexOf('BSH_Common_Option_ProgramProgress') !== -1) {
          const programProgess = await this.getStateAsync(
            `${haId}.programs.active.options.BSH_Common_Option_ProgramProgress`,
          );
          if (programProgess && programProgess.val !== 100) {
            await this.setState(`${haId}.programs.active.options.BSH_Common_Option_ProgramProgress`, 100, true);
          }
        } else if (keyName.indexOf('BSH_Common_Option_RemainingProgramTime') !== -1) {
          const remainTime = await this.getStateAsync(
            `${haId}.programs.active.options.BSH_Common_Option_RemainingProgramTime`,
          );
          if (remainTime && remainTime.val !== 0) {
            await this.setState(`${haId}.programs.active.options.BSH_Common_Option_RemainingProgramTime`, 0, true);
          }
        }
      }
    }
    this.setTimeout(() => this.getAPIValues(haId, `${url}/options`), 0); //ToDo Why 0
  }
  async putAPIValues(haId, url, data) {
    this.log.debug(`Put ${JSON.stringify(data)} to ${url} for ${haId}`);
    if (!(await this.checkBlock())) {
      return;
    }
    let start = 'NOK';
    if (data && data.data && data.data.key) {
      if (data.data.key.indexOf('StopProgram') !== -1) {
        start = 'Stop';
      } else if (
        data.data.key.indexOf('Root_ActiveProgram') !== -1 ||
        data.data.key.indexOf('StartInRelative') !== -1
      ) {
        start = 'Stop';
      }
    }
    await this.setLimitCounter('OK', haId, start, url, 'PUT');
    await this.requestClient({
      method: 'PUT',
      url: `https://api.home-connect.com/api/homeappliances/${haId}${url}`,
      headers: this.headers,
      data: data,
    })
      .then(res => {
        this.log.debug(`Put: ${JSON.stringify(res.data)}`);
        return res.data;
      })
      .catch(error => {
        this.setLimitCounter('ERR', haId, start, null, null);
        this.log.error(`Put: ${error}`);
        if (error.response) {
          if (error.response.headers && error.response.headers['rate-limit-type'] === 'start') {
            this.log.error(JSON.stringify(error.response.headers));
            this.log.error(`Block time ${error.response.headers['retry-after']} second(s)`);
          }
          if (error.response.status === 409) {
            this.log.info(
              'Command cannot be executed for the home appliance, the error response contains the error details',
            );
          } else if (error.response.status === 429) {
            this.log.info('The number of requests for a specific endpoint exceeded the quota of the client');
          } else if (error.response.status === 403) {
            this.log.info('Scope has not been granted or home appliance is not assigned to HC account');
          }
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }

  async deleteAPIValues(haId, url) {
    if (!(await this.checkBlock())) {
      return;
    }
    await this.setLimitCounter('OK', haId, 'Stop', url, 'DELETE');
    await this.requestClient({
      method: 'DELETE',
      url: `https://api.home-connect.com/api/homeappliances/${haId}${url}`,
      headers: this.headers,
    })
      .then(res => {
        this.log.debug(`deleteAPIValues: ${JSON.stringify(res.data)}`);
        return res.data;
      })
      .catch(error => {
        this.setLimitCounter('ERR', haId, 'NOK', null, null);
        this.log.error(`deleteAPIValues: ${error}`);
        if (error.response) {
          if (error.response.status === 429) {
            this.log.info('The maximum number of requests has been reached!');
            if (error.response.headers) {
              if (error.response.headers['retry-after']) {
                this.log.error(`API retry-after: ${this.convertRetryAfter(error.response.headers['retry-after'])}`);
              }
            }
          }
          if (error.response.status === 403) {
            this.log.info('Homeconnect API has not the rights for this command and device');
          }
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async startEventStream() {
    this.log.debug('Start EventStream');
    const baseUrl = 'https://api.home-connect.com/api/homeappliances/events';
    if (this.eventSourceState) {
      this.eventSourceState.close();
      this.eventSourceState.removeEventListener('PAIRED', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('DEPAIRED', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('STATUS', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('NOTIFY', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('EVENT', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('CONNECTED', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('DISCONNECTED', e => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('KEEP-ALIVE', () => this.resetReconnectTimeout(), false);
    }
    this.eventSourceState = new EventSource(baseUrl, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${this.session.access_token}`,
            Accept: 'text/event-stream',
          },
        }),
    });
    // Error handling
    this.eventSourceState.onerror = err => {
      if (err.code) {
        this.log.error(`${err.code} ${err.message}`);
      } else {
        this.log.debug(`EventSource error: ${JSON.stringify(err)}`);
        this.log.debug('Undefined Error from Homeconnect this happens sometimes.');
      }
      if (err.code !== undefined) {
        this.log.error(`Start Event Stream Error: ${JSON.stringify(err)}`);
        if (err.code === 401) {
          this.refreshToken();
          // Most likely the token has expired, try to refresh the token
          this.log.info('Token abgelaufen');
        } else if (err.code === 429) {
          this.log.info('Too many requests. Please wait 24h.');
        } else {
          this.log.error(`Error: ${err.code}`);
          this.log.error(`Error: ${JSON.stringify(err)}`);
          if (err.code >= 500) {
            this.log.error('Homeconnect API are not available please try again later');
          }
        }
      }
    };

    this.eventSourceState.addEventListener('PAIRED', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener('DEPAIRED', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener('STATUS', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener('NOTIFY', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener('EVENT', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener('CONNECTED', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener('DISCONNECTED', e => this.processEvent(e), false);
    this.eventSourceState.addEventListener(
      'KEEP-ALIVE',
      e => {
        this.resetReconnectTimeout();
        const val = {
          type: e.type,
          data: e.data,
          lastEventId: e.lastEventId, // is empty...why?
          timestamp: e.timeStamp,
          origin: e.origin,
        };
        this.log.debug(`KEEP-ALIVE: ${JSON.stringify(val)}`);
      },
      false,
    );

    this.resetReconnectTimeout();
  }
  resetReconnectTimeout() {
    this.reconnectTimeout && this.clearInterval(this.reconnectTimeout);
    this.reconnectTimeout = this.setInterval(() => {
      this.log.info('Keep Alive failed Reconnect EventStream');
      this.startEventStream();
    }, 70000);
  }

  async processEvent(msg) {
    try {
      this.log.debug(`event: ${JSON.stringify(msg.data)}`);
      this.log.debug(`eventType: ${JSON.stringify(msg.type)}`);
      this.log.debug(`lastEventId: ${msg.lastEventId}`);
      const stream = msg;
      //eslint-disable-next-line no-useless-escape
      const lastEventId = stream.lastEventId.replace(/\.?\-001*$/, '');
      if (!stream) {
        this.log.debug(`No Return: ${stream}`);
        return;
      }
      this.resetReconnectTimeout();
      if (stream.type == 'DISCONNECTED') {
        this.log.info(`DISCONNECTED: ${lastEventId}`);
        this.setState(`${lastEventId}.general.connected`, false, true);
        this.updateOptions(lastEventId, '/programs/active');
        return;
      }
      if (stream.type == 'CONNECTED' || stream.type == 'PAIRED') {
        this.log.info(`CONNECTED: ${lastEventId}`);
        this.setState(`${lastEventId}.general.connected`, true, true);
        if (this.config.disableFetchConnect) {
          return;
        }
        this.fetchDeviceInformation(lastEventId);
        return;
      }

      const parseMsg = msg.data;

      const parseMessage = JSON.parse(parseMsg);
      for (let element of parseMessage.items) {
        let haId = parseMessage.haId;
        //eslint-disable-next-line no-useless-escape
        haId = haId.replace(/\.?\-001*$/, '');
        let folder;
        let key;
        if (stream.type === 'EVENT') {
          folder = 'events';
          key = element.key.replace(/\./g, '_');
        } else {
          folder = element.uri.split('/').splice(4);
          if (folder[folder.length - 1].indexOf('.') != -1) {
            folder.pop();
          }
          folder = folder.join('.');
          key = element.key.replace(/\./g, '_');
        }
        this.log.debug(`Path: ${haId}.${folder}.${key}:${element.value}`);
        let value = null;
        if (element.value !== undefined) {
          this.log.debug('Set event state ');
          value = element.value;
          await this.setState(`${haId}.${folder}.${key}`, element.value, true);
        }
        const common = {
          name: key,
          type: 'mixed',
          role: 'state',
          write: true,
          read: true,
        };
        if (element.unit && element.unit != '') {
          common.unit = element.unit;
        }
        await this.createDataPoint(`${haId}.${folder}.${key}`, common, 'state', value, null);
        if (element.value !== undefined) {
          this.log.debug('Set event state ');
          await this.setState(`${haId}.${folder}.${key}`, element.value, true);
        }
      }
    } catch (error) {
      this.log.error(`Parsemessage: ${error}`);
      this.log.error(`Error Event: ${JSON.stringify(msg)}`);
    }
  }

  async refreshToken() {
    if (!this.session) {
      this.log.error('No session found relogin');
      await this.login();
      return;
    }
    if (!this.checkToken(false)) {
      return;
    }
    this.log.debug('Refresh Token');
    await this.requestClient({
      method: 'post',
      url: 'https://api.home-connect.com/security/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `grant_type=refresh_token&refresh_token=${this.session.refresh_token}`,
    })
      .then(res => {
        this.log.debug(`RefreshToken: ${JSON.stringify(res.data)}`);
        this.session = res.data;
        this.headers.authorization = `Bearer ${this.session.access_token}`;
        this.setState('info.connection', true, true);
        this.session.next = new Date().getTime() + parseInt(this.session.expires_in) * 1000;
        //await this.setState('auth.session', { val: this.encrypt(JSON.stringify(this.session)), ack: true });
        this.setState('auth.session', { val: JSON.stringify(this.session), ack: true });
      })
      .catch(error => {
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
          if (error.response.status === 429) {
            this.log.info('The maximum number of requests has been reached!');
            if (error.response.headers) {
              if (error.response.headers['retry-after']) {
                this.log.error(`API retry-after: ${this.convertRetryAfter(error.response.headers['retry-after'])}`);
              }
            }
          }
        }
        this.log.error('refresh token failed');
        this.log.error(error);
        this.log.error('Restart adapter in 20min');
        this.reconnectTimeout && this.clearInterval(this.reconnectTimeout);
        this.reLoginTimeout && this.clearTimeout(this.reLoginTimeout);
        this.reLoginTimeout = this.setTimeout(
          async () => {
            this.restart();
          },
          1000 * 60 * 20,
        );
      });
  }
  extractHidden(body) {
    const returnObject = {};
    const matches = this.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g, body);
    for (const match of matches) {
      returnObject[match[1]] = match[2];
    }
    return returnObject;
  }
  matchAll(re, str) {
    let match;
    const matches = [];

    while ((match = re.exec(str))) {
      // add all matched groups
      matches.push(match);
    }

    return matches;
  }
  /**
   * @param ms milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => {
      this.sleepTimer = this.setTimeout(() => {
        resolve(true);
      }, ms);
    });
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      //this.refreshStatusInterval && this.clearTimeout(this.refreshStatusInterval);
      this.reLoginTimeout && this.clearTimeout(this.reLoginTimeout);
      //this.reconnectInterval && this.clearInterval(this.reconnectInterval);
      this.refreshTokenInterval && this.clearInterval(this.refreshTokenInterval);
      this.rateLimitingInterval && this.clearInterval(this.rateLimitingInterval);
      this.sleepTimer && this.clearTimeout(this.sleepTimer);
      if (this.eventSourceState) {
        this.eventSourceState.close();
        this.eventSourceState.removeEventListener('STATUS', e => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('NOTIFY', e => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('EVENT', e => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('CONNECTED', e => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('DISCONNECTED', e => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('KEEP-ALIVE', () => this.resetReconnectTimeout(), false);
      }

      callback();
    } catch (e) {
      this.log.error(`Error onUnload: ${e}`);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   *
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const idArray = id.split('.') || [];
        const commands = idArray.pop();
        const command = commands ? commands.replace(/_/g, '.') : '';
        const haId = idArray[2];
        if (state.val != null && !Number.isNaN(state.val) && !Number.isNaN(parseFloat(state.val.toString()))) {
          state.val = parseFloat(state.val.toString());
        }
        if (state.val === 'true') {
          state.val = true;
        }
        if (state.val === 'false') {
          state.val = false;
        }
        if (id.indexOf('.commands.') !== -1) {
          this.log.debug(`onStateChange - ${id} ${state.val}`);
          if (id.indexOf('StopProgram') !== -1 && state.val) {
            this.deleteAPIValues(haId, '/programs/active');
          } else {
            const data = {
              data: {
                key: command,
                value: state.val,
              },
            };

            this.putAPIValues(haId, `/commands/${command}`, data).catch(() => {
              this.log.error(`Put value failed ${haId}/commands/${command}${JSON.stringify(data)}`);
              this.log.error(`Original state ${id} change: ${JSON.stringify(state)}`);
            });
          }
        }
        if (id.indexOf('.settings.') !== -1) {
          const data = {
            data: {
              key: command,
              value: state.val,
              type: command,
            },
          };

          this.putAPIValues(haId, `/settings/${command}`, data);
        }
        if (id.indexOf('.options.') !== -1) {
          const data = {
            data: {
              key: command,
              value: state.val,
            },
          };
          if (id.indexOf('selected') !== -1) {
            idArray.pop();
          }
          const folder = idArray.slice(3, idArray.length).join('/');
          if (
            data.data.key === 'BSH.Common.Option.StartInRelative' ||
            data.data.key === 'BSH.Common.Option.FinishInRelative'
          ) {
            this.log.warn('Relative time cannot be changed here. Please use the specific program options.');
          }

          this.putAPIValues(haId, `/${folder}/${command}`, data);
        }
        if (id.indexOf('BSH_Common_Root_') !== -1) {
          const pre = `${this.name}.${this.instance}`;
          if (!state.val) {
            this.log.warn(`No state val: ${JSON.stringify(state)}`);
            return;
          }
          if (state.val.toString().indexOf('.') === -1) {
            this.log.warn(`No valid state val: ${JSON.stringify(state)}`);
            return;
          }
          const key = state.val.toString().split('.').pop();
          const states = await this.getStatesAsync(`${pre}.${haId}.programs.selected.options.${key}.*`);
          if (typeof states !== 'object') {
            this.log.error(`Missing States: ${pre}.${haId}.programs.selected.options.${key}.*`);
            return;
          }
          const allIds = Object.keys(states);
          const options = [];
          for (const keyName of allIds) {
            if (
              keyName.indexOf('BSH_Common_Option_ProgramProgress') === -1 &&
              keyName.indexOf('BSH_Common_Option_RemainingProgramTime') === -1
            ) {
              const idArray = keyName.split('.');
              const commandOptions = idArray.pop();
              const commandOption = commandOptions ? commandOptions.replace(/_/g, '.') : '';
              if (
                ((this.availableProgramOptions[state.val] &&
                  this.availableProgramOptions[state.val].includes(commandOption)) ||
                  commandOption === 'BSH.Common.Option.StartInRelative') &&
                states &&
                states[keyName] !== null
              ) {
                if (
                  (commandOption === 'BSH.Common.Option.StartInRelative' ||
                    commandOption === 'BSH.Common.Option.FinishInRelative') &&
                  command === 'BSH.Common.Root.SelectedProgram'
                ) {
                  this.log.debug('Relative time cannot be changed here. Please use the specific program options.');
                } else {
                  options.push({
                    key: commandOption,
                    value: states[keyName].val,
                  });
                }
              } else {
                this.log.debug(`Option ${commandOption} is not available for ${state.val}`);
                this.log.debug(`Available options: ${JSON.stringify(this.availableProgramOptions[state.val])}`);
              }
            }
          }
          const data = {
            data: {
              key: state.val,
              options: options,
            },
          };
          if (id.indexOf('Active') !== -1) {
            this.putAPIValues(haId, '/programs/active', data)
              .catch(() => {
                this.log.info("Programm doesn't start with options. Try again without selected options.");
                this.putAPIValues(haId, '/programs/active', {
                  data: {
                    key: state.val,
                  },
                }).catch(() => {
                  this.log.error(`Put active failed ${haId}${state.val}`);
                });
              })
              .then(() => this.updateOptions(haId, '/programs/active'))
              .catch(() => {
                this.log.error('Error update active program');
              });
          }
          if (id.indexOf('Selected') !== -1) {
            if (state.val) {
              this.currentSelected[haId] = { key: state.val };

              this.putAPIValues(haId, '/programs/selected', data)
                .then(
                  () => {
                    this.updateOptions(haId, '/programs/selected');
                  },
                  () => {
                    this.log.warn('Setting selected program was not succesful');
                  },
                )
                .catch(() => {
                  this.log.debug('No program selected found');
                });
            } else {
              this.log.warn(`No state val: ${JSON.stringify(state)}`);
            }
          }
        }
      } else {
        const idArray = id.split('.');
        const commands = idArray.pop();
        const command = commands ? commands.replace(/_/g, '.') : '';
        const stop = ['isBlocked', 'limitJson', 'reason', 'connection', 'session'];
        if (stop.includes(command)) {
          this.log.debug(`Catch state - ${id} - ${command}`);
          return;
        }
        const haId = idArray[2];
        this.log.debug(`State changed: ${id} ${JSON.stringify(state)} ${command}`);
        if (id.indexOf('BSH_Common_Root_') !== -1) {
          if (id.indexOf('Active') !== -1) {
            this.updateOptions(haId, '/programs/active');
          }
          if (id.indexOf('Selected') !== -1) {
            if (state && state.val) {
              this.currentSelected[haId] = { key: state.val };
            } else {
              this.log.debug(`Selected program is empty: ${JSON.stringify(state)}`);
            }

            this.updateOptions(haId, '/programs/selected');
          }
        }
        if (id.indexOf('BSH_Common_Status_OperationState') !== -1) {
          if (
            state.val &&
            typeof state.val === 'string' &&
            (state.val.indexOf('.Finished') !== -1 || state.val.indexOf('.Aborting') !== -1)
          ) {
            const remainTime = await this.getStateAsync(
              `${haId}.programs.active.options.BSH_Common_Option_RemainingProgramTime`,
            );
            if (remainTime && remainTime.val !== 0) {
              await this.setState(`${haId}.programs.active.options.BSH_Common_Option_RemainingProgramTime`, 0, true);
            }
            const programProgess = await this.getStateAsync(
              `${haId}.programs.active.options.BSH_Common_Option_ProgramProgress`,
            );
            if (programProgess && programProgess.val !== 100) {
              await this.setState(`${haId}.programs.active.options.BSH_Common_Option_ProgramProgress`, 100, true);
            }
          }
        }
        if (id.indexOf('.options.') !== -1 || id.indexOf('.events.') !== -1 || id.indexOf('.status.') !== -1) {
          if (
            id.indexOf('BSH_Common_Option') === -1 &&
            state &&
            state.val &&
            state.val.toString().indexOf('.') !== -1
          ) {
            this.getObject(id, async (err, obj) => {
              if (obj && state.val != null) {
                const common = obj.common;
                const valArray = state.val.toString().split('.');
                common.states = {};
                common.states[state.val.toString()] = valArray[valArray.length - 1];
                this.log.debug(`Extend common option: ${id}`);
                await this.createDataPoint(id, common, 'state', null, null);
              }
            });
          }
        }
      }
    }
  }
  convertRetryAfter(inputSeconds) {
    try {
      const days = Math.floor(inputSeconds / (60 * 60 * 24));
      const hours = Math.floor((inputSeconds % (60 * 60 * 24)) / (60 * 60));
      const minutes = Math.floor(((inputSeconds % (60 * 60 * 24)) % (60 * 60)) / 60);
      const seconds = Math.floor(((inputSeconds % (60 * 60 * 24)) % (60 * 60)) % 60);
      let day = '';
      if (days > 0) {
        day = `${days}d - `;
      }
      return (
        day +
        [hours, minutes, seconds]
          .map(v => (v < 10 ? `0${v}` : v))
          .filter((v, i) => v !== '00' || i > 0)
          .join(':')
      );
    } catch {
      return 0;
    }
  }
  getWeek(timestamp) {
    if (typeof timestamp === 'number' && timestamp === 0) {
      return '0-0';
    }
    const target = timestamp != null ? new Date(timestamp) : new Date();
    const getDay = target.getDay();
    const dayNr = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const jan4 = new Date(target.getFullYear(), 0, 4);
    const dayDiff = (target.getTime() - jan4.getTime()) / 86400000;
    if (new Date(target.getFullYear(), 0, 1).getDay() < 5) {
      return `${1 + Math.ceil(dayDiff / 7)}-${getDay}`;
    }
    return `${Math.ceil(dayDiff / 7)}-${getDay}`;
  }
  async setTokenJson(block, reason) {
    await this.setState(`rateTokenLimit.limitJson`, { val: JSON.stringify(this.tokenRateLimiting), ack: true });
    await this.setState(`rateTokenLimit.isBlocked`, { val: block, ack: true });
    await this.setState(`rateTokenLimit.reason`, { val: reason, ack: true });
  }
  async setLimitJson(block, reason) {
    await this.setState(`rateLimit.limitJson`, { val: JSON.stringify(this.rateLimiting), ack: true });
    await this.setState(`rateLimit.isBlocked`, { val: block, ack: true });
    await this.setState(`rateLimit.reason`, { val: reason, ack: true });
  }
  async setErrorResponse(update) {
    this.log.debug(this.rateLimiting.requests.length);
    try {
      if (this.rateLimiting.requests.length > 0) {
        const last = this.rateLimiting.requests.length - 1;
        this.rateLimiting.requests[last].response = 'Error';
      }
    } catch (e) {
      this.log.warn(`Cannot change response - ${e}`);
    }
    if (update) {
      await this.setState(`rateLimit.limitJson`, { val: JSON.stringify(this.rateLimiting), ack: true });
    }
  }
  /**
   * Is program for your type available
   *
   * @param {string} haID
   */
  isPrograms(haID) {
    return ['Cooktop', 'FridgeFreezer', 'WineCooler', 'Freezer', 'Refrigerator', 'CookProcessor'].includes(
      this.typeJson[haID],
    );
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = options => new Homeconnect(options);
} else {
  // otherwise start the instance directly
  new Homeconnect();
}
