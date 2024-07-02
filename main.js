'use strict';

/*
 * Created with @iobroker/create-adapter v2.1.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const qs = require('qs');
const EventSource = require('eventsource');
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
    this.headers = {
      'user-agent': this.userAgent,
      Accept: 'application/vnd.bsh.sdk.v1+json',
      'Accept-Language': 'de-DE',
    };
    this.deviceArray = [];
    this.fetchedDevice = {};

    this.availablePrograms = {};
    this.availableProgramOptions = {};
    this.eventSourceState;

    this.currentSelected = {};
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
      this.setState('dev.refreshToken', '', true);
      const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
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

    this.userAgent = 'ioBroker v1.0.0';

    this.cookieJar = new tough.CookieJar();
    this.requestClient = rateLimit(
      axios.create({
        withCredentials: true,
        httpsAgent: new HttpsCookieAgent({
          cookies: {
            jar: this.cookieJar,
          },
        }),
      }),
      { maxRequests: 45, perMilliseconds: 60000 },
    );

    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates('*');
    const sessionState = await this.getStateAsync('auth.session');

    if (sessionState && sessionState.val) {
      this.log.debug('Found current session');
      this.session = JSON.parse(sessionState.val);
    } else {
      const refreshToken = await this.getStateAsync('dev.refreshToken');
      if (refreshToken && refreshToken.val) {
        this.log.debug('Found old refreshtoken');
        this.session.refresh_token = refreshToken.val;
      }
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
      this.headers.authorization = 'Bearer ' + this.session.access_token;
      await this.getDeviceList();
      await this.startEventStream();

      // this.refreshStatusInterval = setInterval(async () => {
      //     for (const haId of this.deviceArray) {
      //         this.log.debug("Update status for " + haId);
      //         this.getAPIValues(haId, "/status");
      //     }
      // }, 10 * 60 * 1000); //every 10 minutes
      //Workaround because sometimes no connect event for offline events
      // this.reconnectInterval = setInterval(async () => {
      //     this.startEventStream();
      // }, 60 * 60 * 1000); //every 60 minutes
      this.refreshTokenInterval = setInterval(async () => {
        await this.refreshToken();
        this.startEventStream();
      }, (this.session.expires_in - 200) * 1000);
    }
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
      data: 'client_id=' + this.config.clientID + '&scope=IdentifyAppliance%20Monitor%20Settings%20Control',
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
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
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.match('data-error-data="" >(.*)<')) {
          this.log.info('Normal Login response ' + res.data.match('data-error-data="" >(.*)<')[1]);
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
            .then((res) => {
              this.log.debug(JSON.stringify(res.data));

              loginUrl = res.request.path;
              return this.extractHidden(res.data);
            })
            .catch((error) => {
              this.log.error(error);
              if (error.response) {
                this.log.error(JSON.stringify(error.response.data));
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
          }).catch((error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
          return await this.requestClient({
            method: 'get',
            url: 'https://singlekey-id.com' + returnUrl,
          })
            .then((res) => {
              this.log.debug(JSON.stringify(res.data));
              return res.data;
            })
            .catch((error) => {
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
        }
        this.log.info('Login details submitted');
        return this.extractHidden(res.data);
      })
      .catch((error) => {
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
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
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
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.session = res.data;
          this.log.info('Token received succesfully');
          await this.setStateAsync('info.connection', true, true);
          await this.setStateAsync('auth.session', JSON.stringify(this.session), true);
          tokenRequestSuccesful = true;
        })
        .catch(async (error) => {
          this.log.error(error);
          this.log.error('Please check username and password or visit this site for manually login: ');
          this.log.error('Bitte überprüfe Benutzername und Passwort oder besuche diese Seite für manuelle Anmeldung: ');
          this.log.error(deviceAuth.verification_uri_complete);
          //   this.log.error(error);
          if (error.response) {
            this.log.error(JSON.stringify(error.response.data));
          }

          this.log.info('Wait 10 seconds to retry');

          await this.sleep(10000);
        });
    }
  }
  async getDeviceList() {
    this.deviceArray = [];
    this.log.debug('Get device list');
    await this.requestClient({
      method: 'get',
      url: 'https://api.home-connect.com/api/homeappliances',
      headers: this.headers,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info(`Found ${res.data.data.homeappliances.length} devices`);
        for (const device of res.data.data.homeappliances) {
          const haID = device.haId;
          if (!haID) {
            this.log.info('Invalid device ' + JSON.stringify(device));
            continue;
          }
          this.deviceArray.push(haID);
          const name = device.name;

          await this.setObjectNotExistsAsync(haID, {
            type: 'device',
            common: {
              name: name,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(haID + '.commands', {
            type: 'channel',
            common: {
              name: 'Commands',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(haID + '.general', {
            type: 'channel',
            common: {
              name: 'General Information',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'BSH_Common_Command_PauseProgram', name: 'True = Pause' },
            { command: 'BSH_Common_Command_ResumeProgram', name: 'True = Resume' },
            { command: 'BSH_Common_Command_StopProgram', name: 'True = Stop' },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(haID + '.commands.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                write: true,
                read: true,
              },
              native: {},
            });
          });
          for (const key in device) {
            await this.setObjectNotExistsAsync(haID + '.general.' + key, {
              type: 'state',
              common: {
                name: key,
                type: typeof device[key],
                role: 'indicator',
                write: false,
                read: true,
              },
              native: {},
            });
            this.setState(haID + '.general.' + key, device[key], true);
          }
          if (device.connected) {
            this.fetchDeviceInformation(haID);
          }
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async fetchDeviceInformation(haId) {
    this.getAPIValues(haId, '/status');
    this.getAPIValues(haId, '/settings');
    this.getAPIValues(haId, '/programs/active');
    this.getAPIValues(haId, '/programs/selected');
    if (!this.fetchedDevice[haId]) {
      this.fetchedDevice[haId] = true;
      this.getAPIValues(haId, '/programs');
      this.updateOptions(haId, '/programs/active');
      this.updateOptions(haId, '/programs/selected');
    }
  }
  async getAPIValues(haId, url) {
    await this.sleep(Math.floor(Math.random() * 1500));
    const returnValue = await this.requestClient({
      method: 'get',
      url: 'https://api.home-connect.com/api/homeappliances/' + haId + url,
      headers: this.headers,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        if (error.response) {
          const description = error.response.data.error ? error.response.data.error.description : '';
          this.log.info(`${haId}${url}: ${description}.`);
          this.log.debug(JSON.stringify(error.response.data));
        } else {
          this.log.info(error);
        }
        return;
      });
    if (!returnValue || returnValue.error) {
      returnValue && this.log.debug('Error: ' + returnValue.error);
      return;
    }
    try {
      this.log.debug(url);
      this.log.debug(JSON.stringify(returnValue));
      if (url.indexOf('/settings/') !== -1) {
        let type = 'string';
        if (returnValue.data.type === 'Int' || returnValue.data.type === 'Double') {
          type = 'number';
        }
        if (returnValue.data.type === 'Boolean') {
          type = 'boolean';
        }
        const common = {
          name: returnValue.data.name,
          type: type,
          role: 'indicator',
          write: true,
          read: true,
        };
        if (returnValue.data.constraints && returnValue.data.constraints.allowedvalues) {
          const states = {};
          returnValue.data.constraints.allowedvalues.forEach((element, index) => {
            states[element] = returnValue.data.constraints.displayvalues[index] || element;
          });
          common.states = states;
        }
        const folder = '.settings.' + returnValue.data.key.replace(/\./g, '_');
        this.log.debug('Extend Settings: ' + haId + folder);
        await this.extendObjectAsync(haId + folder, {
          type: 'state',
          common: common,
          native: {},
        });
        return;
      }

      if (url.indexOf('/programs/available/') !== -1) {
        if (returnValue.data.options) {
          this.availableProgramOptions[returnValue.data.key] = this.availableProgramOptions[returnValue.data.key] || [];
          for (const option of returnValue.data.options) {
            this.availableProgramOptions[returnValue.data.key].push(option.key);
            let type = 'string';
            if (option.type === 'Int' || option.type === 'Double') {
              type = 'number';
            }
            if (option.type === 'Boolean') {
              type = 'boolean';
            }
            const common = {
              name: option.name,
              type: type,
              role: 'indicator',
              unit: option.unit || '',
              write: true,
              read: true,
            };
            if (option.constraints && option.constraints.min && typeof option.constraints.min === 'number') {
              common.min = option.constraints.min;
            }
            if (option.constraints && option.constraints.max && typeof option.constraints.max === 'number') {
              common.max = option.constraints.max;
            }

            if (option.constraints && option.constraints.allowedvalues) {
              common.states = {};
              for (const element of option.constraints.allowedvalues) {
                common.states[element] =
                  option.constraints.displayvalues[option.constraints.allowedvalues.indexOf(element)];
              }
            }
            let folder = '.programs.available.options.' + option.key.replace(/\./g, '_');
            this.log.debug('Extend Options: ' + haId + folder);
            await this.setObjectNotExistsAsync(haId + folder, {
              type: 'state',
              common: common,
              native: {},
            }).catch(() => {
              this.log.error('failed set state');
            });

            await this.extendObjectAsync(haId + folder, {
              type: 'state',
              common: common,
              native: {},
            });
            this.log.debug('Set default value');
            if (option.constraints && option.constraints.default) {
              let value = option.constraints.default;
              if (option.constraints.default > option.constraints.max) {
                value = option.constraints.max;
                this.log.debug(
                  `Default value ${option.constraints.default} is greater than max ${option.constraints.max}. Set to max.`,
                );
              }
              await this.setStateAsync(haId + folder, value, true);
            }
            const key = returnValue.data.key.split('.').pop();
            await this.setObjectNotExistsAsync(haId + '.programs.selected.options.' + key, {
              type: 'state',
              common: { name: returnValue.data.name, type: 'mixed', role: 'indicator', write: true, read: true },
              native: {},
            })
              .then(() => {})
              .catch(() => {
                this.log.error('failed set state');
              });
            folder = '.programs.selected.options.' + key + '.' + option.key.replace(/\./g, '_');
            await this.extendObjectAsync(haId + folder, {
              type: 'state',
              common: common,
              native: {},
            });
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
                this.log.warn('Empty sublement: ' + JSON.stringify(subElement));
              }
            }
            if (url === '/programs') {
              this.log.debug(haId + ' available: ' + JSON.stringify(subElement));
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
              this.getAPIValues(haId, '/programs/available/' + subElement.key);
              folder += '.available';
            }
            if (url === '/settings') {
              this.getAPIValues(haId, '/settings/' + subElement.key);
            }

            if (url.indexOf('/programs/selected/') !== -1) {
              if (!this.currentSelected[haId]) {
                return;
              }
              if (!this.currentSelected[haId].key) {
                this.log.warn(JSON.stringify(this.currentSelected[haId]) + ' is selected but has no key selected ');
                return;
              }
              const key = this.currentSelected[haId].key.split('.').pop();
              folder += '.' + key;

              await this.setObjectNotExistsAsync(haId + folder, {
                type: 'state',
                common: {
                  name: this.currentSelected[haId].name,
                  type: 'mixed',
                  role: 'indicator',
                  write: true,
                  read: true,
                },
                native: {},
              }).catch(() => {
                this.log.error('failed set state');
              });
            }
            this.log.debug('Create State: ' + haId + folder + '.' + subElement.key.replace(/\./g, '_'));
            let type = 'mixed';
            if (typeof subElement.value === 'boolean') {
              type = 'boolean';
            }
            if (typeof subElement.value === 'number') {
              type = 'number';
            }
            const common = {
              name: subElement.name,
              type: type,
              role: 'indicator',
              write: true,
              read: true,
              unit: subElement.unit || '',
            };

            if (subElement.constraints && subElement.constraints.min && typeof subElement.constraints.min === 'number') {
              common.min = subElement.constraints.min;
            }
            if (subElement.constraints && subElement.constraints.max && typeof subElement.constraints.max === 'number') {
              common.max = subElement.constraints.max;
            }
            this.extendObjectAsync(haId + folder + '.' + subElement.key.replace(/\./g, '_'), {
              type: 'state',
              common: common,
              native: {},
            })
              .then(() => {
                if (subElement.value !== undefined) {
                  this.log.debug('Set api value');
                  this.setState(haId + folder + '.' + subElement.key.replace(/\./g, '_'), subElement.value, true);
                }
              })
              .catch(() => {
                this.log.error('failed set state');
              });
          }
        } else {
          this.log.info('No array: ' + item);
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
          this.log.info('No available programs found for: ' + haId);
          return;
        }
        rootItems.forEach(async (rootItem) => {
          const common = {
            name: rootItem.key,
            type: 'string',
            role: 'indicator',
            write: true,
            read: true,
            states: {},
          };
          this.availablePrograms[haId].forEach((program) => {
            common.states[program.key] = program.name;
          });
          await this.setObjectNotExistsAsync(haId + rootItem.folder + '.' + rootItem.key.replace(/\./g, '_'), {
            type: 'state',
            common: common,
            native: {},
          })
            .then(() => {})
            .catch(() => {
              this.log.error('failed set state');
            });
          await this.extendObjectAsync(haId + rootItem.folder + '.' + rootItem.key.replace(/\./g, '_'), {
            type: 'state',
            common: common,
            native: {},
          });
        });
      }
    } catch (error) {
      this.log.error(error);
      this.log.error(error.stack);
      this.log.error(url);
      this.log.error(JSON.stringify(returnValue));
    }
  }
  async updateOptions(haId, url, forceDeletion) {
    const pre = this.name + '.' + this.instance;
    const states = await this.getStatesAsync(pre + '.' + haId + '.programs.*');
    if (!states) {
      this.log.warn('No states found for: ' + pre + '.' + haId + '.programs.*');
      return;
    }
    const allIds = Object.keys(states);
    let searchString = 'selected.options.';
    if (url.indexOf('/active') !== -1) {
      searchString = 'active.options.';
      this.log.debug(searchString);
      //delete only for active options
      this.log.debug('Delete: ' + haId + url.replace(/\//g, '.') + '.options');

      for (const keyName of allIds) {
        if (
          (keyName.indexOf(searchString) !== -1 && keyName.indexOf('BSH_Common_Option') === -1) ||
          (forceDeletion && keyName.indexOf('BSH_Common_Option_RemainingProgramTime') === -1)
        ) {
          await this.delObjectAsync(keyName.split('.').slice(2).join('.'));
        } else if (keyName.indexOf('BSH_Common_Option_ProgramProgress') !== -1) {
          const programProgess = await this.getStateAsync(
            haId + '.programs.active.options.BSH_Common_Option_ProgramProgress',
          );
          if (programProgess && programProgess.val !== 100) {
            await this.setStateAsync(haId + '.programs.active.options.BSH_Common_Option_ProgramProgress', 100, true);
          }
        } else if (keyName.indexOf('BSH_Common_Option_RemainingProgramTime') !== -1) {
          const remainTime = await this.getStateAsync(
            haId + '.programs.active.options.BSH_Common_Option_RemainingProgramTime',
          );
          if (remainTime && remainTime.val !== 0) {
            await this.setStateAsync(haId + '.programs.active.options.BSH_Common_Option_RemainingProgramTime', 0, true);
          }
        }
      }
    }
    setTimeout(() => this.getAPIValues(haId, url + '/options'), 0);
  }
  async putAPIValues(haId, url, data) {
    this.log.debug(`Put ${JSON.stringify(data)} to ${url} for ${haId}`);
    await this.requestClient({
      method: 'PUT',
      url: 'https://api.home-connect.com/api/homeappliances/' + haId + url,
      headers: this.headers,
      data: data,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          if (error.response.status === 403) {
            this.log.info('Homeconnect API has not the rights for this command and device');
          }
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }

  async deleteAPIValues(haId, url) {
    await this.requestClient({
      method: 'DELETE',
      url: 'https://api.home-connect.com/api/homeappliances/' + haId + url,
      headers: this.headers,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
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
    const header = {
      headers: {
        Authorization: 'Bearer ' + this.session.access_token,
        Accept: 'text/event-stream',
      },
    };
    if (this.eventSourceState) {
      this.eventSourceState.close();
      this.eventSourceState.removeEventListener('PAIRED', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('DEPAIRED', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('STATUS', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('NOTIFY', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('EVENT', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('CONNECTED', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('DISCONNECTED', (e) => this.processEvent(e), false);
      this.eventSourceState.removeEventListener('KEEP-ALIVE', (e) => this.resetReconnectTimeout(e.lastEventId), false);
    }
    this.eventSourceState = new EventSource(baseUrl, header);
    // Error handling
    this.eventSourceState.onerror = (err) => {
      if (err.status) {
        this.log.error(err.status + ' ' + err.message);
      } else {
        this.log.debug('EventSource error: ' + JSON.stringify(err));
        this.log.debug('Undefined Error from Homeconnect this happens sometimes.');
      }
      if (err.status !== undefined) {
        this.log.error('Start Event Stream Error: ' + JSON.stringify(err));
        if (err.status === 401) {
          this.refreshToken();
          // Most likely the token has expired, try to refresh the token
          this.log.info('Token abgelaufen');
        } else if (err.status === 429) {
          this.log.info('Too many requests. Please wait 24h.');
        } else {
          this.log.error('Error: ' + err.status);
          this.log.error('Error: ' + JSON.stringify(err));
          if (err.status >= 500) {
            this.log.error('Homeconnect API are not available please try again later');
          }
        }
      }
    };

    this.eventSourceState.addEventListener('PAIRED', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener('DEPAIRED', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener('STATUS', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener('NOTIFY', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener('EVENT', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener('CONNECTED', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener('DISCONNECTED', (e) => this.processEvent(e), false);
    this.eventSourceState.addEventListener(
      'KEEP-ALIVE',
      (e) => {
        this.resetReconnectTimeout();
      },
      false,
    );

    this.resetReconnectTimeout();
  }
  resetReconnectTimeout() {
    this.reconnectTimeout && clearInterval(this.reconnectTimeout);
    this.reconnectTimeout = setInterval(() => {
      this.log.info('Keep Alive failed Reconnect EventStream');
      this.startEventStream();
    }, 70000);
  }

  processEvent(msg) {
    try {
      this.log.debug('event: ' + JSON.stringify(msg));
      const stream = msg;
      const lastEventId = stream.lastEventId.replace(/\.?\-001*$/, '');
      if (!stream) {
        this.log.debug('No Return: ' + stream);
        return;
      }
      this.resetReconnectTimeout();
      if (stream.type == 'DISCONNECTED') {
        this.log.info('DISCONNECTED: ' + lastEventId);
        this.setState(lastEventId + '.general.connected', false, true);
        this.updateOptions(lastEventId, '/programs/active');
        return;
      }
      if (stream.type == 'CONNECTED' || stream.type == 'PAIRED') {
        this.log.info('CONNECTED: ' + lastEventId);
        this.setState(lastEventId + '.general.connected', true, true);
        if (this.config.disableFetchConnect) {
          return;
        }
        this.fetchDeviceInformation(lastEventId);
        return;
      }

      const parseMsg = msg.data;

      const parseMessage = JSON.parse(parseMsg);
      parseMessage.items.forEach(async (element) => {
        let haId = parseMessage.haId;
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
        this.log.debug(haId + '.' + folder + '.' + key + ':' + element.value);
        await this.setObjectNotExistsAsync(haId + '.' + folder + '.' + key, {
          type: 'state',
          common: {
            name: key,
            type: 'mixed',
            role: 'indicator',
            write: true,
            read: true,
            unit: element.unit || '',
          },
          native: {},
        })
          .then(() => {})
          .catch(() => {
            this.log.error('failed set state');
          });
        if (element.value !== undefined) {
          this.log.debug('Set event state ');
          await this.setStateAsync(haId + '.' + folder + '.' + key, element.value, true);
        }
      });
    } catch (error) {
      this.log.error('Parsemessage: ' + error);
      this.log.error('Error Event: ' + JSON.stringify(msg));
    }
  }

  async refreshToken() {
    if (!this.session) {
      this.log.error('No session found relogin');
      await this.login();
      return;
    }
    this.log.debug('Refresh Token');
    await this.requestClient({
      method: 'post',
      url: 'https://api.home-connect.com/security/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: 'grant_type=refresh_token&refresh_token=' + this.session.refresh_token,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.headers.authorization = 'Bearer ' + this.session.access_token;
        this.setState('info.connection', true, true);
        this.setState('auth.session', JSON.stringify(this.session), true);
      })
      .catch((error) => {
        this.log.error('refresh token failed');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error('Restart adapter in 20min');
        this.reconnectTimeout && clearInterval(this.reconnectTimeout);
        this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
        this.reLoginTimeout = setTimeout(async () => {
          this.restart();
        }, 1000 * 60 * 20);
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
  sleep(ms) {
    if (this.adapterStopped) {
      ms = 0;
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.refreshStatusInterval && clearTimeout(this.refreshStatusInterval);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.reconnectInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);

      if (this.eventSourceState) {
        this.eventSourceState.close();
        this.eventSourceState.removeEventListener('STATUS', (e) => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('NOTIFY', (e) => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('EVENT', (e) => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('CONNECTED', (e) => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('DISCONNECTED', (e) => this.processEvent(e), false);
        this.eventSourceState.removeEventListener('KEEP-ALIVE', (e) => this.resetReconnectTimeout(), false);
      }

      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (state && !state.ack) {
        const idArray = id.split('.') || [];
        const command = idArray.pop().replace(/_/g, '.');
        const haId = idArray[2];
        if (!isNaN(state.val) && !isNaN(parseFloat(state.val))) {
          state.val = parseFloat(state.val);
        }
        if (state.val === 'true') {
          state.val = true;
        }
        if (state.val === 'false') {
          state.val = false;
        }
        if (id.indexOf('.commands.') !== -1) {
          this.log.debug(id + ' ' + state.val);
          if (id.indexOf('StopProgram') !== -1 && state.val) {
            this.deleteAPIValues(haId, '/programs/active');
          } else {
            const data = {
              data: {
                key: command,
                value: state.val,
              },
            };

            this.putAPIValues(haId, '/commands/' + command, data).catch(() => {
              this.log.error('Put value failed ' + haId + '/commands/' + command + JSON.stringify(data));
              this.log.error('Original state ' + id + ' change: ' + JSON.stringify(state));
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

          this.putAPIValues(haId, '/settings/' + command, data);
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

          this.putAPIValues(haId, '/' + folder + '/' + command, data);
        }
        if (id.indexOf('BSH_Common_Root_') !== -1) {
          const pre = this.name + '.' + this.instance;
          if (!state.val) {
            this.log.warn('No state val: ' + JSON.stringify(state));
            return;
          }
          if (!state.val.split) {
            this.log.warn('No valid state val: ' + JSON.stringify(state));
            return;
          }
          const key = state.val.split('.').pop();
          this.getStates(pre + '.' + haId + '.programs.selected.options.' + key + '.*', (err, states) => {
            const allIds = Object.keys(states);
            const options = [];
            allIds.forEach((keyName) => {
              if (
                keyName.indexOf('BSH_Common_Option_ProgramProgress') === -1 &&
                keyName.indexOf('BSH_Common_Option_RemainingProgramTime') === -1
              ) {
                const idArray = keyName.split('.');
                const commandOption = idArray.pop().replace(/_/g, '.');
                if (
                  ((this.availableProgramOptions[state.val] &&
                    this.availableProgramOptions[state.val].includes(commandOption)) ||
                    commandOption === 'BSH.Common.Option.StartInRelative') &&
                  states[keyName] !== null
                ) {
                  if (
                    (commandOption === 'BSH.Common.Option.StartInRelative' ||
                      commandOption === 'BSH.Common.Option.FinishInRelative') &&
                    command === 'BSH.Common.Root.SelectedProgram'
                  ) {
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
            });

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
                    this.log.error('Put active failed ' + haId + state.val);
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
                this.log.warn('No state val: ' + JSON.stringify(state));
              }
            }
          });
        }
      } else {
        const idArray = id.split('.');
        const command = idArray.pop().replace(/_/g, '.');
        const haId = idArray[2];
        if (id.indexOf('BSH_Common_Root_') !== -1) {
          if (id.indexOf('Active') !== -1) {
            this.updateOptions(haId, '/programs/active');
          }
          if (id.indexOf('Selected') !== -1) {
            if (state && state.val) {
              this.currentSelected[haId] = { key: state.val };
            } else {
              this.log.debug('Selected program is empty: ' + JSON.stringify(state));
            }

            this.updateOptions(haId, '/programs/selected');
          }
        }
        if (id.indexOf('BSH_Common_Status_OperationState') !== -1) {
          if (state.val && (state.val.indexOf('.Finished') !== -1 || state.val.indexOf('.Aborting') !== -1)) {
            const remainTime = await this.getStateAsync(
              haId + '.programs.active.options.BSH_Common_Option_RemainingProgramTime',
            );
            if (remainTime && remainTime.val !== 0) {
              await this.setStateAsync(
                haId + '.programs.active.options.BSH_Common_Option_RemainingProgramTime',
                0,
                true,
              );
            }
            const programProgess = await this.getStateAsync(
              haId + '.programs.active.options.BSH_Common_Option_ProgramProgress',
            );
            if (programProgess && programProgess.val !== 100) {
              await this.setStateAsync(haId + '.programs.active.options.BSH_Common_Option_ProgramProgress', 100, true);
            }
          }
        }
        if (id.indexOf('.options.') !== -1 || id.indexOf('.events.') !== -1 || id.indexOf('.status.') !== -1) {
          if (
            id.indexOf('BSH_Common_Option') === -1 &&
            state &&
            state.val &&
            state.val.indexOf &&
            state.val.indexOf('.') !== -1
          ) {
            this.getObject(id, async (err, obj) => {
              if (obj) {
                const common = obj.common;
                const valArray = state.val.split('.');
                common.states = {};
                common.states[state.val] = valArray[valArray.length - 1];
                this.log.debug('Extend common option: ' + id);
                await this.setObjectNotExistsAsync(id, {
                  type: 'state',
                  common: common,
                  native: {},
                })
                  .then(() => {})
                  .catch(() => {
                    this.log.error('failed set state');
                  });
                await this.extendObjectAsync(id, {
                  type: 'state',
                  common: common,
                  native: {},
                });
              }
            });
          }
        }
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Homeconnect(options);
} else {
  // otherwise start the instance directly
  new Homeconnect();
}
